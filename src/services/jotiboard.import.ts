import type { Types } from "mongoose";
import { ServiceError } from "../http/service-error";
import { HintCell, HintCellStatus } from "../models/hint-cell.model";
import { HuntReport } from "../models/hunt-report.model";
import { JotiboardImport } from "../models/jotiboard-import.model";
import { Marker } from "../models/marker.model";
import { isDuplicateKeyError } from "../utils/mongo";
import { reopenImportedCell, solveCell } from "./hint-board.service";
import { DUPLICATE_WINDOW_MS, hintSolveImports, importKey, isNearDuplicate, pinImports, type JotiboardHintSolve, type JotiboardPin } from "./jotiboard.helpers";

export interface JotiboardCounts {
  /** Markers imported from pins */
  pins: number;
  /** Hint cells solved from Jotiboard */
  hints: number;
}

/** Writes Jotiboard data into our collections (default connection). Our own data always wins. */
export interface JotiboardImporter {
  /** `pins` is the full `manualLocations` snapshot: imported pins missing from it are removed again */
  importPins(pins: JotiboardPin[]): Promise<void>;
  importHintSolves(solves: JotiboardHintSolve[]): Promise<void>;
  /** Remove everything the sync imported (markers, solved cells that still hold the imported answer) and all records */
  purge(): Promise<{ markers: number; hints: number }>;
  counts(): Promise<JotiboardCounts>;
}

/** Drop the links hunt reports and hint cells keep to deleted markers (as deleteMarker does). */
async function unlinkMarkers(markerIds: Types.ObjectId[]) {
  if (!markerIds.length) return;
  await Promise.all([
    HuntReport.updateMany({ markerId: { $in: markerIds } }, { $unset: { markerId: 1 } }),
    HintCell.updateMany({ markerId: { $in: markerIds } }, { $unset: { markerId: 1 } }),
  ]);
}

async function importPins(pins: JotiboardPin[]): Promise<void> {
  const wanted = pinImports(pins);
  const records = await JotiboardImport.find({ kind: "pin" }).lean();
  const known = new Set(records.map((record) => importKey(record.externalId, record.area)));

  for (const pin of wanted) {
    if (known.has(importKey(pin.externalId, pin.area))) continue;
    const window = { $gte: new Date(pin.time.getTime() - DUPLICATE_WINDOW_MS), $lte: new Date(pin.time.getTime() + DUPLICATE_WINDOW_MS) };
    const nearby = await Marker.find({ area: pin.area, type: pin.type, source: { $ne: "jotiboard" }, time: window }, { time: 1, location: 1 }).lean();
    const record = { kind: "pin" as const, externalId: pin.externalId, area: pin.area };
    if (nearby.some((marker) => isNearDuplicate(pin, { time: marker.time, coordinates: marker.location.coordinates }))) {
      await JotiboardImport.create({ ...record, result: "skipped", reason: "duplicate" });
      continue;
    }
    try {
      const marker = await Marker.create({
        area: pin.area,
        time: pin.time,
        type: pin.type,
        location: { type: "Point", coordinates: pin.coordinates },
        source: "jotiboard",
        externalId: pin.externalId,
      });
      await JotiboardImport.create({ ...record, result: "imported", markerId: marker._id });
    } catch (error) {
      // A hint marker already holds this area's hour (unique index)
      if (!isDuplicateKeyError(error)) throw error;
      await JotiboardImport.create({ ...record, result: "skipped", reason: "duplicate" });
    }
  }

  // Pins deleted on Jotiboard: their imported markers go too
  const present = new Set(wanted.map((pin) => importKey(pin.externalId, pin.area)));
  const gone = records.filter((record) => !present.has(importKey(record.externalId, record.area)));
  const goneMarkers = gone.flatMap((record) => (record.result === "imported" && record.markerId ? [record.markerId] : []));
  if (goneMarkers.length) {
    await Marker.deleteMany({ _id: { $in: goneMarkers }, source: "jotiboard" });
    await unlinkMarkers(goneMarkers);
  }
  if (gone.length) await JotiboardImport.deleteMany({ _id: { $in: gone.map((record) => record._id) } });
}

async function importHintSolves(solves: JotiboardHintSolve[]): Promise<void> {
  const records = await JotiboardImport.find({ kind: "hintSolve" }).lean();
  const byKey = new Map(records.map((record) => [importKey(record.externalId, record.area), record]));

  for (const solve of hintSolveImports(solves)) {
    const externalId = String(solve.messageId);
    const existing = byKey.get(importKey(externalId, solve.area));
    if (existing && existing.reason !== "no-cell") continue;
    const filter = { kind: "hintSolve" as const, externalId, area: solve.area };
    const save = (fields: Record<string, unknown>) =>
      JotiboardImport.updateOne(filter, fields.reason ? { $set: { ...filter, ...fields } } : { $set: { ...filter, ...fields }, $unset: { reason: 1 } }, { upsert: true });

    const cell = await HintCell.findOne({ articleId: solve.messageId, area: solve.area }, { status: 1 }).lean();
    if (!cell) {
      if (!existing) await save({ result: "skipped", reason: "no-cell" });
      continue;
    }
    if (cell.status !== HintCellStatus.Open) {
      await save({ result: "skipped", reason: "cell-solved" });
      continue;
    }
    try {
      await solveCell(solve.messageId, solve.area, solve.answer);
      await save({ result: "imported", cellId: cell._id, answer: solve.answer });
    } catch (error) {
      // 409: a hint marker of ours already holds this area's hour
      if (!(error instanceof ServiceError) || error.status !== 409) throw error;
      await save({ result: "skipped", reason: "duplicate" });
    }
  }
}

async function purge(): Promise<{ markers: number; hints: number }> {
  const markerIds = (await Marker.find({ source: "jotiboard" }, { _id: 1 }).lean()).map((marker) => marker._id);
  const { deletedCount } = await Marker.deleteMany({ _id: { $in: markerIds } });
  await unlinkMarkers(markerIds);

  let hints = 0;
  const solved = await JotiboardImport.find({ kind: "hintSolve", result: "imported" }).lean();
  for (const record of solved) {
    if (record.cellId && record.answer && (await reopenImportedCell(record.cellId, record.answer))) hints++;
  }
  await JotiboardImport.deleteMany({});
  return { markers: deletedCount ?? 0, hints };
}

async function counts(): Promise<JotiboardCounts> {
  const [pins, hints] = await Promise.all([
    JotiboardImport.countDocuments({ kind: "pin", result: "imported" }),
    JotiboardImport.countDocuments({ kind: "hintSolve", result: "imported" }),
  ]);
  return { pins, hints };
}

export const jotiboardImporter: JotiboardImporter = { importPins, importHintSolves, purge, counts };
