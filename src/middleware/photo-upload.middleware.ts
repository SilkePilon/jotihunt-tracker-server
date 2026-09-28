import { NextFunction, Request, Response } from "express";
import multer from "multer";
import { MAX_PHOTO_BYTES, resolvePhotoExtension } from "../services/hunt-report.helpers";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PHOTO_BYTES, files: 1 },
  // Disallowed types are dropped (req.file stays undefined) and rejected by the controller with a clear message
  fileFilter: (_req, file, callback) => callback(null, resolvePhotoExtension(file.mimetype) !== null),
});

/** Parse a multipart body with one `photo` file; multer errors become 400 responses. */
export function photoUpload(req: Request, res: Response, next: NextFunction) {
  upload.single("photo")(req, res, (error: unknown) => {
    if (error instanceof multer.MulterError) {
      const message = error.code === "LIMIT_FILE_SIZE" ? "Foto is groter dan 5 MB." : "Foto uploaden is mislukt.";
      return res.status(400).json({ message });
    }
    if (error) return next(error);
    next();
  });
}
