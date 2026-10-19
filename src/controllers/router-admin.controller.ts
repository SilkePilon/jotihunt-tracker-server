import type { Request, Response } from "express";

const ADMIN_URL = () => process.env.ROUTER_ADMIN_URL?.replace(/\/$/, "");
const OFFLINE = { online: false, building: false, builtAt: null, report: null, lastError: null };

export async function getRouterStatus(_req: Request, res: Response) {
  const base = ADMIN_URL();
  if (!base || !process.env.ROUTER_URL) return res.status(200).json({ configured: false, ...OFFLINE });
  try {
    const answer = await fetch(`${base}/status`, { signal: AbortSignal.timeout(3000) });
    if (!answer.ok) return res.status(200).json({ configured: true, ...OFFLINE, lastError: `Router antwoordde ${answer.status}` });
    return res.status(200).json({ configured: true, ...OFFLINE, ...((await answer.json()) as object) });
  } catch {
    return res.status(200).json({ configured: true, ...OFFLINE, lastError: "Router niet bereikbaar" });
  }
}

export async function rebuildRouter(_req: Request, res: Response) {
  const base = ADMIN_URL();
  if (!base) return res.status(503).json({ message: "Router is niet ingesteld." });
  try {
    const answer = await fetch(`${base}/rebuild`, { method: "POST", signal: AbortSignal.timeout(5000) });
    // 409: a rebuild is already running; passed through so the client can say so
    if (answer.status === 409) return res.status(409).json({ message: "Kaartdata wordt al vernieuwd." });
    return res.status(answer.status).json(await answer.json().catch(() => ({})));
  } catch {
    return res.status(503).json({ message: "Router niet bereikbaar." });
  }
}
