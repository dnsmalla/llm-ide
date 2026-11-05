#!/usr/bin/env node
// Production static server for the built web client.
//
//   npm run build && npm start
//   HOST=127.0.0.1 PORT=5180 npm start
//
// Vite's preview server is fine for a quick look; this one is the deployable
// static server: it sends the CSP as a header (the built page also carries a
// meta copy), refuses directory traversal, does an SPA fallback for client
// routes, and serves hashed assets as immutable.
import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { readFileSync, statSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data:", "font-src 'self'",
  "connect-src 'self' ws://127.0.0.1:* ws://localhost:* ws://[::1]:* wss: https://g.api.mega.co.nz https://*.userstorage.mega.co.nz", "base-uri 'none'", "form-action 'none'", "object-src 'none'",
].join("; ");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".woff2": "font/woff2",
};

const HEADERS = {
  "Content-Security-Policy": CSP,
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};
export const securityHeaders = (tls) => (tls ? { ...HEADERS, "Strict-Transport-Security": "max-age=31536000; includeSubDomains" } : HEADERS);

/** True only for a file under distDir; a decoded `..`/absolute path is refused. */
export function safePath(distDir, rawPath) {
  let decoded;
  try { decoded = decodeURIComponent(rawPath); } catch { return null; }
  const rel = decoded.replace(/^\/+/, "");
  if (!rel || rel.includes("\0")) return rel === "" ? "" : null;
  const abs = resolve(distDir, rel);
  const root = resolve(distDir);
  if (abs !== root && !abs.startsWith(root + sep)) return null;
  return abs;
}

function fileAt(path) {
  try { return statSync(path).isFile() ? path : null; } catch { return null; }
}

export function createWebServer({ distDir = resolve(fileURLToPath(new URL("../dist", import.meta.url))), tls = null } = {}) {
  const index = join(distDir, "index.html");
  const handler = (req, res) => {
    const method = req.method || "GET";
    if (method !== "GET" && method !== "HEAD") {
      res.writeHead(405, { ...securityHeaders(tls), Allow: "GET, HEAD", "Content-Type": "text/plain; charset=utf-8" });
      res.end("Method Not Allowed\n");
      return;
    }
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const requested = safePath(distDir, url.pathname);
    if (requested === null) {
      res.writeHead(400, { ...securityHeaders(tls), "Content-Type": "text/plain; charset=utf-8" });
      res.end("Bad Request\n");
      return;
    }
    const file = requested === "" ? null : fileAt(requested);
    // A missing hashed asset or a file-looking path is a real 404; only a
    // client-side route (no extension) falls back to index.html.
    if (file === null && (url.pathname.startsWith("/assets/") || extname(url.pathname) !== "")) {
      res.writeHead(404, { ...securityHeaders(tls), "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not Found\n");
      return;
    }
    const target = file ?? index;
    let body;
    try { body = readFileSync(target); } catch {
      res.writeHead(404, { ...securityHeaders(tls), "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not Found\n");
      return;
    }
    const isHashedAsset = /^\/assets\/[^/]+$/.test(url.pathname);
    const type = MIME[extname(target).toLowerCase()] ?? "application/octet-stream";
    res.writeHead(200, {
      ...securityHeaders(tls),
      "Content-Type": type,
      "Content-Length": body.length,
      "Cache-Control": isHashedAsset ? "public, max-age=31536000, immutable" : "no-cache",
    });
    if (method === "HEAD") res.end(); else res.end(body);
  };
  return tls ? createHttpsServer(tls, handler) : createServer(handler);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const host = process.env.HOST || "127.0.0.1";
  const port = Number(process.env.PORT || 5180);
  const certPath = process.env.TLS_CERT || "";
  const keyPath = process.env.TLS_KEY || "";
  if (Boolean(certPath) !== Boolean(keyPath)) {
    console.error("llmide-web: set both TLS_CERT and TLS_KEY, or neither");
    process.exit(1);
  }
  const tls = certPath ? { cert: readFileSync(certPath), key: readFileSync(keyPath) } : null;
  const server = createWebServer({ tls });
  server.listen(port, host, () => {
    const a = server.address();
    console.log(`llmide-web: ${tls ? "https" : "http"}://${host}:${a.port}`);
  });
}
