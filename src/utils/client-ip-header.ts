import type { RequestHandler } from "express";

/**
 * Behind Cloudflare Tunnel → Traefik the real client address only survives in CF-Connecting-IP: Traefik replaces
 * X-Forwarded-For with the cloudflared pod address. Copy the header into X-Forwarded-For so that, with
 * TRUST_PROXY=1, req.ip (and so the login/pairing rate limits) is the real client. Only safe when every request
 * reaches the server through that proxy chain (ClusterIP Service, no other ingress): a client that can reach the
 * server directly can pick its own address by sending the header.
 */
export function clientIpHeader(headerName: string): RequestHandler {
  const name = headerName.trim().toLowerCase();
  return (req, _res, next) => {
    const value = req.headers[name];
    if (typeof value === "string" && value.trim()) req.headers["x-forwarded-for"] = value.trim();
    next();
  };
}
