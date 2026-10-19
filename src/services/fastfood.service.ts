import type { Connection, Model } from "mongoose";
import { fastfoodModel, type FastfoodDoc } from "../models/fastfood.model";
import type { FastfoodApi } from "./fastfood.client";
import { openIntervals, toRestaurant, type Restaurant } from "./fastfood.helpers";
import { errorText } from "../utils/error-text";
import type { ServiceLogger } from "../utils/service-logger";
import { serviceSlot } from "../utils/service-slot";

/** A refresh with fewer restaurants than this is a truncated or broken answer: keep the old data */
export const MIN_RESTAURANTS = 100;
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
}

/** McDonald's, KFC and Burger King from OpenStreetMap: refreshed daily, listed with their open intervals. */
export class FastfoodService {
  private readonly model: Model<FastfoodDoc>;
  private readonly now: () => Date;
  private readonly minCount: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private cache: { at: number; items: FastfoodItem[] } | null = null;
  private refreshing: Promise<boolean> | null = null;

  constructor(private readonly options: FastfoodServiceOptions) {
    this.model = fastfoodModel(options.connection);
    this.now = options.now ?? (() => new Date());
    this.minCount = options.minCount ?? MIN_RESTAURANTS;
  }

  /** Refresh now when the data is missing or a day old, then check again every hour. */
  start() {
    void this.refreshIfStale();
    this.timer = setInterval(() => void this.refreshIfStale(), CHECK_EVERY_MS);
    this.timer.unref?.();
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
    await this.model.bulkWrite(restaurants.map((restaurant) => ({ replaceOne: { filter: { osmId: restaurant.osmId }, replacement: restaurant, upsert: true } })));
    await this.model.deleteMany({ osmId: { $nin: restaurants.map((restaurant) => restaurant.osmId) } });
    const unknown = restaurants.filter((restaurant) => openIntervals(restaurant.openingHours, now) === undefined).length;
    this.options.logger.info(`Fastfood refreshed: ${restaurants.length} restaurants, ${unknown} without usable opening hours`);
    this.cache = null;
    return true;
  }

  /** Every restaurant with its open intervals for the coming 8 days (cached for LIST_CACHE_MS). */
  async list(): Promise<FastfoodItem[]> {
    const now = this.now();
    if (this.cache && now.getTime() - this.cache.at < LIST_CACHE_MS) return this.cache.items;
    const docs = await this.model.find().select({ _id: 0 }).lean();
    const items = docs.map(({ updatedAt, ...restaurant }) => {
      const intervals = openIntervals(restaurant.openingHours, now);
      const item: FastfoodItem = { ...restaurant, updatedAt: updatedAt.toISOString() };
      if (intervals) item.intervals = intervals.map(({ start, end }) => ({ start: start.toISOString(), end: end.toISOString() }));
      return item;
    });
    this.cache = { at: now.getTime(), items };
    return items;
  }
}

const slot = serviceSlot<FastfoodService>("Fastfood is niet beschikbaar op de server.");
export const setFastfoodService = slot.set;
export const getFastfoodService = slot.get;
export const requireFastfoodService = slot.require;
