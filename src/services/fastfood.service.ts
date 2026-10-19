import type { Connection, Model } from "mongoose";
import { fastfoodModel, type FastfoodDoc } from "../models/fastfood.model";
import type { FastfoodApi } from "./fastfood.client";
import { openIntervals, toRestaurant, type Restaurant } from "./fastfood.helpers";
import { errorText } from "../utils/error-text";
import type { ServiceLogger } from "../utils/service-logger";
import { serviceSlot } from "../utils/service-slot";

/** A refresh with fewer restaurants than this is a truncated or broken answer: keep the old data */
export const MIN_RESTAURANTS = 100;
/** A refresh with fewer than this share of the stored restaurants is a partial answer: keep the old data */
export const MIN_KEEP_RATIO = 0.8;
/** Past this age the stored data is too old to defend: the keep-ratio guard steps aside (minCount still holds) */
export const RATIO_GUARD_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;
export const REFRESH_AFTER_MS = 24 * 60 * 60 * 1000;
const CHECK_EVERY_MS = 60 * 60 * 1000;
/** The list's intervals start at "now"; recomputing them every 10 minutes is plenty for an open/closed status */
export const LIST_CACHE_MS = 10 * 60 * 1000;

/** One restaurant as `GET /fastfood` answers it; `intervals` is absent when the opening hours are unknown. */
export interface FastfoodItem extends Omit<Restaurant, "updatedAt"> {
  updatedAt: string;
  intervals?: { start: string; end: string }[];
}

export interface FastfoodServiceOptions {
  /** Connection to the REAL database (the demo state store's), so the cache survives demo mode */
  connection: Connection;
  client: FastfoodApi;
  logger: ServiceLogger;
  /** Tests only */
  now?: () => Date;
  /** Tests only, default MIN_RESTAURANTS */
  minCount?: number;
  /** Tests only, default MIN_KEEP_RATIO */
  minKeepRatio?: number;
}

/** McDonald's, KFC and Burger King from OpenStreetMap: refreshed daily, listed with their open intervals. */
export class FastfoodService {
  private readonly model: Model<FastfoodDoc>;
  private readonly now: () => Date;
  private readonly minCount: number;
  private readonly minKeepRatio: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private cache: { at: number; items: FastfoodItem[] } | null = null;
  private refreshing: Promise<boolean> | null = null;
  /** Bumped by every refresh that clears the cache, so a list() that read the old data doesn't cache it */
  private generation = 0;

  constructor(private readonly options: FastfoodServiceOptions) {
    this.model = fastfoodModel(options.connection);
    this.now = options.now ?? (() => new Date());
    this.minCount = options.minCount ?? MIN_RESTAURANTS;
    this.minKeepRatio = options.minKeepRatio ?? MIN_KEEP_RATIO;
  }

  /** Refresh now when the data is missing or a day old, then check again every hour. */
  start() {
    this.checkInBackground();
    this.timer = setInterval(() => this.checkInBackground(), CHECK_EVERY_MS);
    this.timer.unref?.();
  }

  /** A failed check (e.g. Mongo down) is logged, never left as an unhandled rejection. */
  private checkInBackground() {
    void this.refreshIfStale().catch((error) => this.options.logger.error(`Fastfood refresh check failed: ${errorText(error)}`));
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async refreshIfStale(): Promise<void> {
    const newest = await this.model.findOne().sort({ updatedAt: -1 }).select({ updatedAt: 1 }).lean();
    if (newest && this.now().getTime() - newest.updatedAt.getTime() < REFRESH_AFTER_MS) return;
    await this.refresh();
  }

  /** Fetch all restaurants and replace the stored ones; false (old data kept) when Overpass fails or answers too few. */
  refresh(): Promise<boolean> {
    this.refreshing ??= this.doRefresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async doRefresh(): Promise<boolean> {
    const now = this.now();
    let restaurants: Restaurant[];
    try {
      const elements = await this.options.client.fetchElements();
      restaurants = elements.map((element) => toRestaurant(element, now)).filter((restaurant): restaurant is Restaurant => !!restaurant);
    } catch (error) {
      this.options.logger.warn(`Fastfood refresh failed, keeping the old data: ${errorText(error)}`);
      return false;
    }
    if (restaurants.length < this.minCount) {
      this.options.logger.warn(`Fastfood refresh got only ${restaurants.length} restaurants, keeping the old data`);
      return false;
    }
    const stored = await this.model.countDocuments();
    if (restaurants.length < stored * this.minKeepRatio) {
      const newest = await this.model.findOne().sort({ updatedAt: -1 }).select({ updatedAt: 1 }).lean();
      const age = newest ? now.getTime() - newest.updatedAt.getTime() : 0;
      if (age <= RATIO_GUARD_MAX_AGE_MS) {
        this.options.logger.warn(`Fastfood refresh got only ${restaurants.length} restaurants (had ${stored}), keeping the old data`);
        return false;
      }
      // Without this the guard could keep a once-larger set forever
      this.options.logger.error(
        `Fastfood refresh got only ${restaurants.length} restaurants (had ${stored}), accepting it because the stored data is ${Math.round(age / 3_600_000)} hours old`,
      );
    }
    await this.model.bulkWrite(restaurants.map((restaurant) => ({ replaceOne: { filter: { osmId: restaurant.osmId }, replacement: restaurant, upsert: true } })));
    await this.model.deleteMany({ osmId: { $nin: restaurants.map((restaurant) => restaurant.osmId) } });
    const unknown = restaurants.filter((restaurant) => openIntervals(restaurant.openingHours, now) === undefined).length;
    this.options.logger.info(`Fastfood refreshed: ${restaurants.length} restaurants, ${unknown} without usable opening hours`);
    this.cache = null;
    this.generation++;
    return true;
  }

  /** Every restaurant with its open intervals for the coming 8 days (cached for LIST_CACHE_MS). */
  async list(): Promise<FastfoodItem[]> {
    const now = this.now();
    if (this.cache && now.getTime() - this.cache.at < LIST_CACHE_MS) return this.cache.items;
    const generation = this.generation;
    const docs = await this.model.find().select({ _id: 0 }).lean();
    const items = docs.map(({ updatedAt, ...restaurant }) => {
      const intervals = openIntervals(restaurant.openingHours, now);
      const item: FastfoodItem = { ...restaurant, updatedAt: updatedAt.toISOString() };
      if (intervals) item.intervals = intervals.map(({ start, end }) => ({ start: start.toISOString(), end: end.toISOString() }));
      return item;
    });
    // A refresh that finished while we were reading may have left us with the old data: answer it, don't cache it
    if (generation === this.generation) this.cache = { at: now.getTime(), items };
    return items;
  }
}

const slot = serviceSlot<FastfoodService>("Fastfood is niet beschikbaar op de server.");
export const setFastfoodService = slot.set;
export const getFastfoodService = slot.get;
export const requireFastfoodService = slot.require;
