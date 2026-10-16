import distance from "@turf/distance";
import { knownAreaName, type AreaName } from "../constants/areas";
import { MarkerType } from "../models/marker.model";
import { isValidSessionKey } from "./session-crypto";

/**
 * Jotiboard (jotiboard.nl, our own app) keeps its data in Firebase: Auth (email/password) and the Realtime Database.
 * Values from the SPA bundle (search `databaseURL` / `jotiboard.local` in https://jotiboard.nl/assets/index-*.js if they
 * change). The API key is public (shipped to every browser), not a secret.
 */
export const JOTIBOARD_API_KEY = "AIzaSyAzRjEfPUeMEaatY7wF9CAE3wH1MWPlgx8";
export const JOTIBOARD_DB_URL = "https://jotiboard-c010d-default-rtdb.europe-west1.firebasedatabase.app";

/** The Jotiboard login form turns the username into this e-mail address. */
export function jotiboardEmail(username: string): string {
  return `${username.trim().toLowerCase()}@jotiboard.local`;
}

export interface JotiboardConfig {
  /** Base64 AES-256 key for the stored refresh token */
  sessionKey: string;
}

export function jotiboardConfigFromEnv(env: Record<string, string | undefined>, warn: (message: string) => void): JotiboardConfig | null {
  const sessionKey = env.JOTIBOARD_SESSION_KEY?.trim();
  if (!sessionKey) return null;
  if (!isValidSessionKey(sessionKey)) {
    warn("JOTIBOARD_SESSION_KEY is not 32 bytes (base64), the Jotiboard sync is off. Generate one with: openssl rand -base64 32");
    return null;
  }
  return { sessionKey };
}

// --- Data ---------------------------------------------------------------------------------------------------------

/** A pin on the Jotiboard map (`manualLocations/<id>`) */
export interface JotiboardPin {
  id: string;
  foxAreas: string[];
  lat: number;
  lon: number;
  /** Unix ms */
  time: number;
  type: "hint" | "hunt" | "other";
}

/** A hint solution entered on Jotiboard (`hintSolves/<messageId>`); x/y are RD */
export interface JotiboardHintSolve {
  messageId: number;
  foxAreas: string[];
  x: number;
  y: number;
  completed: boolean;
}

const PIN_TYPES = ["hint", "hunt", "other"] as const;
const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const areaList = (value: unknown): string[] => (Array.isArray(value) ? value.filter((area): area is string => typeof area === "string") : []);
const entries = (raw: unknown): [string, Record<string, unknown>][] =>
  raw && typeof raw === "object" && !Array.isArray(raw)
    ? Object.entries(raw as Record<string, unknown>).filter((entry): entry is [string, Record<string, unknown>] => !!entry[1] && typeof entry[1] === "object")
    : [];

/** The `manualLocations` node → pins; entries that don't look like a pin are skipped. */
export function parsePins(raw: unknown): JotiboardPin[] {
  return entries(raw).flatMap(([id, value]) => {
    const foxAreas = areaList(value.foxAreas);
    const type = PIN_TYPES.find((candidate) => candidate === value.type);
    if (!foxAreas.length || !type || !isNumber(value.lat) || !isNumber(value.lon) || !isNumber(value.time)) return [];
    return [{ id, foxAreas, lat: value.lat, lon: value.lon, time: value.time, type }];
  });
}

/** The `hintSolves` node → solves (completed or not); entries without coordinates are skipped. */
export function parseHintSolves(raw: unknown): JotiboardHintSolve[] {
  return entries(raw).flatMap(([key, value]) => {
    const messageId = isNumber(value.messageId) ? value.messageId : Number(key);
    if (!Number.isInteger(messageId) || !isNumber(value.x) || !isNumber(value.y)) return [];
    return [{ messageId, foxAreas: areaList(value.foxAreas), x: value.x, y: value.y, completed: value.completed === true }];
  });
}

// --- Imports ------------------------------------------------------------------------------------------------------

const PIN_MARKER_TYPE: Record<JotiboardPin["type"], MarkerType> = { hint: MarkerType.Hint, hunt: MarkerType.Hunt, other: MarkerType.Spot };

/** What one pin × area becomes in our database */
export interface PinImport {
  externalId: string;
  area: AreaName;
  type: MarkerType;
  time: Date;
  /** [lng, lat] */
  coordinates: [number, number];
}

/** One import per pin × known area. Times like createMarker: hint markers on the hour, others on the minute. */
export function pinImports(pins: JotiboardPin[]): PinImport[] {
  return pins.flatMap((pin) => {
    const type = PIN_MARKER_TYPE[pin.type];
    const time = new Date(pin.time);
    if (type === MarkerType.Hint) time.setUTCMinutes(0, 0, 0);
    else time.setUTCSeconds(0, 0);
    const areas = [...new Set(pin.foxAreas.map(knownAreaName).filter((area): area is AreaName => area !== null))];
    return areas.map((area) => ({ externalId: pin.id, area, type, time: new Date(time), coordinates: [pin.lon, pin.lat] as [number, number] }));
  });
}

/** A completed solve for one area, as an answer for solveCell */
export interface HintSolveImport {
  messageId: number;
  area: AreaName;
  answer: string;
}

export function hintSolveImports(solves: JotiboardHintSolve[]): HintSolveImport[] {
  return solves
    .filter((solve) => solve.completed)
    .flatMap((solve) => {
      const areas = [...new Set(solve.foxAreas.map(knownAreaName).filter((area): area is AreaName => area !== null))];
      return areas.map((area) => ({ messageId: solve.messageId, area, answer: `${solve.x} ${solve.y}` }));
    });
}

export const DUPLICATE_WINDOW_MS = 15 * 60_000;
export const DUPLICATE_DISTANCE_M = 300;

/** Same place and moment: within 15 min and 300 m (area and type are compared by the caller). */
export function isNearDuplicate(a: { time: Date; coordinates: number[] }, b: { time: Date; coordinates: number[] }): boolean {
  if (Math.abs(a.time.getTime() - b.time.getTime()) > DUPLICATE_WINDOW_MS) return false;
  return distance(a.coordinates, b.coordinates, { units: "meters" }) <= DUPLICATE_DISTANCE_M;
}

/** Key of an import record (pin id or message id, plus area) */
export const importKey = (externalId: string, area: string) => `${externalId}|${area}`;
