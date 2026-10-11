import express from "express";
import path from "node:path";
import { appReleaseDir, readLatestRelease, releaseFilePath } from "../services/app-release";

const router = express.Router();

// Public: the site links the download for people who are not paired yet
router.get("/latest", async (_req, res) => {
  const release = await readLatestRelease(appReleaseDir());
  res.setHeader("Cache-Control", "no-cache");
  if (!release) return res.status(404).json({ message: "Nog geen app beschikbaar." });
  return res.status(200).json(release);
});

router.get("/download/:file", (req, res) => {
  const file = releaseFilePath(appReleaseDir(), String(req.params.file));
  if (!file) return res.status(404).json({ message: "Bestand niet gevonden." });
  return res.download(file, path.basename(file), { headers: { "Content-Type": "application/vnd.android.package-archive" } });
});

export default router;
