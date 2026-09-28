import { randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

/** Directory for hunt photos; in Docker a named volume at /usr/src/app/uploads. */
function uploadsDir(): string {
  return path.resolve(process.env.UPLOADS_DIR || "uploads");
}

/** Absolute path of a stored photo. Rejects names that would leave the uploads directory. */
export function photoFilePath(name: string): string {
  const base = path.basename(name);
  if (base !== name) throw new Error("Invalid photo name");
  return path.join(uploadsDir(), base);
}

/** Store a photo under a random name and return that name. */
export async function savePhoto(buffer: Buffer, extension: string): Promise<string> {
  await mkdir(uploadsDir(), { recursive: true });
  const name = `${randomUUID()}${extension}`;
  await writeFile(photoFilePath(name), buffer);
  return name;
}

/** Delete a stored photo; a missing file is not an error. */
export async function deletePhoto(name: string): Promise<void> {
  await unlink(photoFilePath(name)).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}
