import type { Connection, Model } from "mongoose";
import { ServiceError } from "../http/service-error";
import { buildingTileModel, type BuildingTileDoc } from "../models/building-tile.model";
import type { BuildingsApi } from "./buildings.client";
import { encodeTile, inNetherlands, MAX_RADIUS_KM, parseTileId, tileBounds, tileId, tilesAround, toBuildingFeatures, type TileXY } from "./buildings.helpers";
import { errorText } from "../utils/error-text";

export interface BuildingsJob {
  kind: "refresh" | "prefetch";
  done: number;
  total: number;
  failed: number;
  startedAt: string;
  finishedAt: string | null;
  /** Stopped after MAX_CONSECUTIVE_FAILURES failed tiles in a row; the rest counts as failed */
  aborted: boolean;
}

export interface BuildingsStatus {
  tiles: number;
  buildings: number;
  bytes: number;
  oldest: string | null;
  newest: string | null;
  /** The running or last job since the server started */
  job: BuildingsJob | null;
}

export interface BuildingsLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string, error?: unknown): void;
}

export interface BuildingsServiceOptions {
  /** Connection to the REAL database (the demo state store's), so the cache survives demo mode */
  connection: Connection;
  client: BuildingsApi;
  logger: BuildingsLogger;
  /** Parallel 3DBAG fetches, default 4 */
  maxParallel?: number;
  /** Tests only */
  now?: () => Date;
}

const BUSY = "Er loopt al een taak voor de 3D-gebouwen.";
/** A job stops after this many failed tiles in a row, so a hanging 3DBAG can't lock the cache for hours */
export const MAX_CONSECUTIVE_FAILURES = 10;

/** A queued job fetch that was dropped because its job aborted */
class JobAbortedError extends Error {}

/**
 * 3D buildings from 3DBAG, cached per z15 tile as a ready vector tile. A miss is fetched on demand (map requests go
 * ahead of the queue); one background job at a time refreshes every cached tile or prefetches an area.
 */
export class BuildingsService {
  private readonly model: Model<BuildingTileDoc>;
  private readonly maxParallel: number;
  private readonly now: () => Date;
  private readonly inFlight = new Map<string, Promise<Buffer | null>>();
  private active = 0;
  /** Waiting fetches, each FIFO; map requests go before job fetches */
  private readonly urgentQueue: (() => void)[] = [];
  /** Job entries; called with `skip` to drop the fetch without giving it a slot (job aborted) */
  private readonly jobQueue: ((skip?: boolean) => void)[] = [];
  /** The jobQueue entry per tile id, so a map request for that tile can move it to the urgent queue */
  private readonly queuedJobs = new Map<string, (skip?: boolean) => void>();
  /** A job start or clear is past its busy check but hasn't set `job` / finished yet */
  private starting = false;
  private job: BuildingsJob | null = null;
  private jobDone: Promise<void> = Promise.resolve();

  constructor(private readonly options: BuildingsServiceOptions) {
    this.model = buildingTileModel(options.connection);
    this.maxParallel = options.maxParallel ?? 4;
    this.now = options.now ?? (() => new Date());
  }

  /** The vector tile of `tile` (null: no buildings); fetched from 3DBAG on a miss. Throws BuildingsUpstreamError. */
  async getTile(tile: TileXY): Promise<Buffer | null> {
    if (!inNetherlands(tile)) return null;
    const doc = await this.model.findById(tileId(tile));
    if (doc) return doc.mvt ? Buffer.from(doc.mvt) : null;
    return this.fetchAndStore(tile, true);
  }

  async status(): Promise<BuildingsStatus> {
    // Snapshot the job now, not after the aggregate (a job's fetches keep running meanwhile)
    const job = this.job && { ...this.job };
    const [stats] = await this.model.aggregate<{ tiles: number; buildings: number; bytes: number; oldest: Date | null; newest: Date | null }>([
      {
        $group: {
          _id: null,
          tiles: { $sum: 1 },
          buildings: { $sum: "$count" },
          bytes: { $sum: { $ifNull: [{ $binarySize: "$mvt" }, 0] } },
          oldest: { $min: "$fetchedAt" },
          newest: { $max: "$fetchedAt" },
        },
      },
    ]);
    return {
      tiles: stats?.tiles ?? 0,
      buildings: stats?.buildings ?? 0,
      bytes: stats?.bytes ?? 0,
      oldest: stats?.oldest?.toISOString() ?? null,
      newest: stats?.newest?.toISOString() ?? null,
      job,
    };
  }

  /** Fetch every cached tile again, oldest first; a tile that fails keeps its old data. */
  async startRefresh(): Promise<BuildingsStatus> {
    return this.exclusive(async () => {
      const docs = await this.model.find({}, { _id: 1 }).sort({ fetchedAt: 1 }).lean();
      return this.startJob("refresh", docs.map((doc) => parseTileId(doc._id)));
    });
  }

  /** Fetch the tiles around (lat, lon) that aren't cached yet. */
  async startPrefetch(lat: number, lon: number, radiusKm: number): Promise<BuildingsStatus> {
    if (!(radiusKm >= 1 && radiusKm <= MAX_RADIUS_KM)) throw new ServiceError(400, `Straal moet tussen 1 en ${MAX_RADIUS_KM} km liggen.`);
    return this.exclusive(async () => {
      const tiles = tilesAround(lat, lon, radiusKm);
      const cached = new Set((await this.model.find({ _id: { $in: tiles.map(tileId) } }, { _id: 1 }).lean()).map((doc) => doc._id));
      return this.startJob("prefetch", tiles.filter((tile) => !cached.has(tileId(tile))));
    });
  }

  async clear(): Promise<BuildingsStatus> {
    await this.exclusive(() => this.model.deleteMany({}));
    this.options.logger.info("3D building cache cleared");
    return this.status();
  }

  /** Resolves when the current job (if any) has ended. */
  idle(): Promise<void> {
    return this.jobDone;
  }

  /** Run `action` unless a job runs or another start/clear is underway (409); concurrent calls can't both get through. */
  private async exclusive<T>(action: () => Promise<T>): Promise<T> {
    if (this.starting || (this.job && this.job.finishedAt === null)) throw new ServiceError(409, BUSY);
    this.starting = true;
    try {
      return await action();
    } finally {
      this.starting = false;
    }
  }

  private async startJob(kind: BuildingsJob["kind"], tiles: TileXY[]): Promise<BuildingsStatus> {
    const job: BuildingsJob = {
      kind,
      done: 0,
      total: tiles.length,
      failed: 0,
      startedAt: this.now().toISOString(),
      finishedAt: null,
      aborted: false,
    };
    this.job = job;
    this.options.logger.info(`3D buildings ${kind} started (${tiles.length} tiles)`);
    let consecutiveFailures = 0;
    this.jobDone = Promise.all(
      tiles.map(async (tile) => {
        try {
          await this.fetchAndStore(tile, false);
          consecutiveFailures = 0;
        } catch (error) {
          job.failed++;
          if (job.aborted) return;
          this.options.logger.warn(`3D buildings tile ${tileId(tile)} failed: ${errorText(error)}`);
          if (++consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            job.aborted = true;
            this.options.logger.warn(`3D buildings ${kind} aborted after ${consecutiveFailures} consecutive failures`);
            this.dropQueuedJobFetches();
          }
        } finally {
          job.done++;
        }
      }),
    ).then(() => {
      job.finishedAt = this.now().toISOString();
      this.options.logger.info(`3D buildings ${kind} done (${job.done - job.failed}/${job.total} ok)`);
    });
    return this.status();
  }

  /** Fetch from 3DBAG, encode and upsert; concurrent calls for one tile share the fetch. */
  private fetchAndStore(tile: TileXY, urgent: boolean): Promise<Buffer | null> {
    const id = tileId(tile);
    const running = this.inFlight.get(id);
    if (running) {
      if (urgent) this.promote(id);
      return running;
    }
    const promise = this.limited(id, urgent, async () => {
      const features = toBuildingFeatures(await this.options.client.fetchParts(tileBounds(tile)));
      const encoded = encodeTile(tile, features);
      const mvt = encoded ? Buffer.from(encoded) : null;
      await this.model.updateOne({ _id: id }, { $set: { mvt, count: mvt ? features.length : 0, fetchedAt: this.now() } }, { upsert: true });
      return mvt;
    }).finally(() => this.inFlight.delete(id));
    this.inFlight.set(id, promise);
    return promise;
  }

  /** A map request joined a job fetch of tile `id`: if that fetch is still waiting, move it to the urgent queue. */
  private promote(id: string) {
    const resolve = this.queuedJobs.get(id);
    if (!resolve) return;
    this.queuedJobs.delete(id);
    this.jobQueue.splice(this.jobQueue.indexOf(resolve), 1);
    this.urgentQueue.push(resolve);
  }

  /** Job aborted: its waiting fetches end with JobAbortedError (fetches a map request joined were promoted, so they stay). */
  private dropQueuedJobFetches() {
    for (const entry of this.jobQueue.splice(0)) entry(true);
  }

  private async limited<T>(id: string, urgent: boolean, task: () => Promise<T>): Promise<T> {
    if (this.active >= this.maxParallel) {
      const skip = await new Promise<boolean>((resolve) => {
        if (urgent) {
          this.urgentQueue.push(() => resolve(false));
        } else {
          const entry = (skip = false) => {
            this.queuedJobs.delete(id);
            resolve(skip);
          };
          this.queuedJobs.set(id, entry);
          this.jobQueue.push(entry);
        }
      });
      // Dropped without a slot, so nothing to hand on
      if (skip) throw new JobAbortedError("job aborted");
    } else {
      this.active++;
    }
    try {
      return await task();
    } finally {
      // Hand the slot straight to the next waiter (active stays the same), else free it
      const next = this.urgentQueue.shift() ?? this.jobQueue.shift();
      if (next) next();
      else this.active--;
    }
  }
}

let instance: BuildingsService | null = null;

export function getBuildingsService(): BuildingsService | null {
  return instance;
}

export function setBuildingsService(service: BuildingsService | null) {
  instance = service;
}
