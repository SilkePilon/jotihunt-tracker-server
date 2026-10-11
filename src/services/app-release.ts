import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

export interface AppRelease {
  versionCode: number;
  versionName: string;
  sha256: string;
  url: string;
}

/** Directory with latest.json and the APKs (APP_DIR, default ./app-releases). */
export function appReleaseDir(): string {
  return path.resolve(process.env.APP_DIR || "app-releases");
}

/** Absolute path of an APK in `dir`, or null for anything that is not a plain *.apk name or does not exist. */
export function releaseFilePath(dir: string, file: string): string | null {
  if (path.basename(file) !== file || !file.endsWith(".apk")) return null;
  const full = path.join(dir, file);
  return existsSync(full) ? full : null;
}

/** The release described by latest.json; null when missing, unreadable or incomplete. */
export async function readLatestRelease(dir: string): Promise<AppRelease | null> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path.join(dir, "latest.json"), "utf8"));
  } catch {
    return null;
  }
  const value = (raw ?? {}) as Partial<{ versionCode: number; versionName: string; file: string; sha256: string }>;
  if (!Number.isInteger(value.versionCode) || typeof value.versionName !== "string" || typeof value.file !== "string" || typeof value.sha256 !== "string") return null;
  if (!releaseFilePath(dir, value.file)) return null;
  return { versionCode: value.versionCode!, versionName: value.versionName, sha256: value.sha256, url: `/app/download/${value.file}` };
}
