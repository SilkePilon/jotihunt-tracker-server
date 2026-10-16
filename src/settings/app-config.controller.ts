import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { NextFunction, Request, Response } from "express";
import multer from "multer";
import { respond, ServiceError } from "../http/service-error";
import { logger } from "../logger";
import { detectPhotoType } from "../middleware/photo-upload.middleware";
import { testJotihuntLogin } from "../services/jotihunt-scraper.service";
import * as traccarService from "../services/traccar.service";
import { adminConfig, general, publicConfig, setGeneral, setPlain, setSecret, type SecretName } from "./app-config";

const by = (req: Request) => req.user?.name ?? null;
const MAX_LOGO_BYTES = 1024 * 1024;
const LOGO_TYPES: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/svg+xml": "svg" };

/** Uploaded branding lives next to the hunt photos (real uploads dir, never the demo one). */
function brandingDir(): string {
  return path.join(path.resolve(process.env.UPLOADS_DIR || "uploads"), "branding");
}

export function getPublicConfig(_req: Request, res: Response) {
  res.setHeader("Cache-Control", "no-cache");
  return res.status(200).json(publicConfig());
}

export function getAdminConfig(_req: Request, res: Response) {
  return res.status(200).json(adminConfig());
}

/** The other side of the hunt window comes from the current config when the request sends only one (null clears it) */
function huntWindowOk(body: Record<string, unknown>): boolean {
  const side = (key: "huntStart" | "huntEnd") => (key in body ? (body[key] as string | null | undefined) || null : general(key).value);
  const start = side("huntStart");
  const end = side("huntEnd");
  return !start || !end || new Date(end) > new Date(start);
}

export async function putGeneral(req: Request, res: Response) {
  if (("huntStart" in req.body || "huntEnd" in req.body) && !huntWindowOk(req.body)) {
    // Same shape as the validate middleware
    return res.status(400).json({ errors: [{ type: "field", msg: "Einde moet na de start liggen.", path: "huntEnd", location: "body" }] });
  }
  await setGeneral(req.body, by(req));
  logger.info(`General settings changed by ${by(req)}: ${Object.keys(req.body).join(", ")}`);
  return res.status(200).json(adminConfig());
}

export async function putSecret(req: Request, res: Response) {
  const name = req.params.name as SecretName;
  return respond(res, 200, async () => {
    await setSecret(name, String(req.body.value), by(req));
    logger.info(`Secret ${name} changed by ${by(req)}`);
    return adminConfig();
  });
}

export async function deleteSecret(req: Request, res: Response) {
  const name = req.params.name as SecretName;
  await setSecret(name, null, by(req));
  logger.info(`Secret ${name} cleared by ${by(req)}`);
  return res.status(200).json(adminConfig());
}

export async function putPlain(req: Request, res: Response) {
  await setPlain(req.body, by(req));
  return res.status(200).json(adminConfig());
}

const logoUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_LOGO_BYTES, files: 1 } }).single("logo");

/** The real type of the bytes (the declared type can't be trusted); SVG by its opening tag. */
function logoType(buffer: Buffer): string | null {
  const photo = detectPhotoType(buffer);
  if (photo) return photo;
  const head = buffer.subarray(0, 512).toString("utf8").trimStart();
  return head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg")) ? "image/svg+xml" : null;
}

export function parseLogo(req: Request, res: Response, next: NextFunction) {
  logoUpload(req, res, (error: unknown) => {
    if (error instanceof multer.MulterError) return res.status(400).json({ message: error.code === "LIMIT_FILE_SIZE" ? "Logo is groter dan 1 MB." : "Logo uploaden is mislukt." });
    if (error) return next(error);
    next();
  });
}

export async function postLogo(req: Request, res: Response) {
  const file = req.file;
  const type = file ? logoType(file.buffer) : null;
  if (!file || !type) return res.status(400).json({ message: "Kies een PNG-, JPG-, WebP- of SVG-afbeelding." });
  const dir = brandingDir();
  await mkdir(dir, { recursive: true });
  for (const old of await readdir(dir)) if (old.startsWith("logo.")) await rm(path.join(dir, old), { force: true });
  await writeFile(path.join(dir, `logo.${LOGO_TYPES[type]}`), file.buffer);
  // A path on the API (the client prefixes API_BASE_URL); ?v= busts caches after a new upload
  await setGeneral({ logoUrl: `/branding/logo?v=${Date.now()}` }, by(req));
  logger.info(`Logo uploaded by ${by(req)}`);
  return res.status(200).json(adminConfig());
}

export async function getLogo(_req: Request, res: Response) {
  const dir = brandingDir();
  // Only a known extension: a stray logo.<other> file is ignored
  const known = (await readdir(dir).catch(() => [] as string[]))
    .map((name) => ({ name, type: Object.entries(LOGO_TYPES).find(([, ext]) => name === `logo.${ext}`)?.[0] }))
    .find((entry) => entry.type);
  if (!known?.type) return res.status(404).json({ message: "Geen logo geüpload." });
  const { name: file, type } = known;
  res.setHeader("Content-Type", type);
  // SVG may hold scripts: never run them in our origin
  res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox");
  res.setHeader("Cache-Control", "public, max-age=300");
  return res.status(200).send(await readFile(path.join(dir, file)));
}

export async function getTraccarGroups(_req: Request, res: Response) {
  return respond(res, 200, async () => {
    if (!traccarService.isTraccarConfigured) throw new ServiceError(503, "Traccar is niet ingesteld op de server.");
    const groups = await traccarService.getGroups();
    return groups.map((group) => ({ id: group.id, name: group.name })).sort((a, b) => a.id - b.id);
  });
}

/** Test the posted login (form not yet saved) or, without a body, the saved one */
export async function postJotihuntTestLogin(req: Request, res: Response) {
  const { username, password } = req.body ?? {};
  const login = typeof username === "string" && typeof password === "string" && username && password ? { username, password } : undefined;
  return res.status(200).json(await testJotihuntLogin(login));
}
