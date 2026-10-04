import { NextFunction, Request, Response } from "express";
import multer from "multer";
import { logger } from "../logger";
import { MAX_PHOTO_BYTES, MAX_THUMB_BYTES, resolvePhotoExtension } from "../services/hunt-report.helpers";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PHOTO_BYTES, files: 2 },
  // Disallowed types are dropped (req.file stays undefined) and rejected by the controller with a clear message
  fileFilter: (_req, file, callback) => callback(null, resolvePhotoExtension(file.mimetype) !== null),
});

/** The image type the bytes actually are (JPEG, PNG or WebP), or null. The declared type can not be trusted. */
export function detectPhotoType(buffer: Buffer): "image/jpeg" | "image/png" | "image/webp" | null {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buffer.length >= 12 && buffer.toString("latin1", 0, 4) === "RIFF" && buffer.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  return null;
}

type UploadedFiles = Partial<Record<"photo" | "thumb", Express.Multer.File[]>>;

/** The optional list thumbnail parsed by photoUpload (already checked), or undefined. */
export function uploadedThumb(req: Request): Express.Multer.File | undefined {
  return (req.files as UploadedFiles | undefined)?.thumb?.[0];
}

/**
 * Parse a multipart body with one `photo` file (as req.file) and an optional `thumb` file (see uploadedThumb);
 * multer errors become 400 responses. A thumb that is too big or no real image is dropped, never failing the upload.
 */
export function photoUpload(req: Request, res: Response, next: NextFunction) {
  upload.fields([
    { name: "photo", maxCount: 1 },
    { name: "thumb", maxCount: 1 },
  ])(req, res, (error: unknown) => {
    if (error instanceof multer.MulterError) {
      const message = error.code === "LIMIT_FILE_SIZE" ? "Foto is groter dan 5 MB." : "Foto uploaden is mislukt.";
      return res.status(400).json({ message });
    }
    if (error) return next(error);
    const files = (req.files ?? {}) as UploadedFiles;
    req.file = files.photo?.[0];
    if (req.file) {
      const type = detectPhotoType(req.file.buffer);
      if (!type) return res.status(400).json({ message: "Foto is geen geldige JPEG-, PNG- of WebP-afbeelding." });
      // Store (and later serve) the photo as what it really is
      req.file.mimetype = type;
    }
    const thumb = files.thumb?.[0];
    if (thumb) {
      const type = thumb.size <= MAX_THUMB_BYTES ? detectPhotoType(thumb.buffer) : null;
      if (type) thumb.mimetype = type;
      else {
        logger.warn(`Dropped an invalid hunt photo thumbnail (${thumb.size} bytes)`);
        delete files.thumb;
      }
    }
    next();
  });
}
