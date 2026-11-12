// TS twin of the Host API v1 web Origin rule (extension/core/host-api-origins.mjs, desktop/src-tauri/src/prefs.rs
// `normalize_web_origin`), pinned by schema/host-api/v1/fixtures/security/origins.json. The host re-validates on save;
// this twin only lets the editor explain a refusal before it is sent.

export const MAX_WEB_ORIGINS = 10;
export const MAX_WEB_ORIGINS_CHARS = 2048;
export const HOSTED_WEB_ORIGIN = "https://llm-ide.com";

const LOOPBACK = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):([0-9]{1,5})$/;
const HTTPS = /^https:\/\/([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)(?::([0-9]{1,5}))?$/;
const portOk = (p: string): boolean => Number(p) >= 1 && Number(p) <= 65535;

/** The canonical origin, or null when the rule refuses it. */
export function normaliseWebOrigin(entry: string): string | null {
  const e = entry.trim().toLowerCase();
  const lo = LOOPBACK.exec(e);
  if (lo) return portOk(lo[2]) ? e : null;
  const h = HTTPS.exec(e);
  if (!h || /^[0-9.]+$/.test(h[1])) return null;
  if (h[2] === undefined) return e;
  if (!portOk(h[2])) return null;
  return h[2] === "443" ? `https://${h[1]}` : e;
}

/** Why an entry is refused (shown under it), or null when it is fine. */
export function webOriginError(entry: string): string | null {
  const e = entry.trim();
  if (!e) return "Enter an origin.";
  if (normaliseWebOrigin(e) !== null) return null;
  if (/^https:\/\/[0-9.]+(:[0-9]+)?$/i.test(e)) return "An IP address cannot be an https origin; use a DNS name.";
  if (/[/?#]/.test(e.replace(/^[a-z]+:\/\//i, ""))) return "Give only the origin: no path, query or trailing slash.";
  return "Use http://localhost:<port>, http://127.0.0.1:<port>, http://[::1]:<port> or https://<dns-name>[:port].";
}

/** The list after adding `entry`: canonical, de-duplicated; `error` explains a refusal (invalid, duplicate or over a bound). */
export function addWebOrigin(list: readonly string[], entry: string): { list: string[]; error: string | null } {
  const err = webOriginError(entry);
  if (err) return { list: [...list], error: err };
  const n = normaliseWebOrigin(entry) as string;
  if (list.includes(n)) return { list: [...list], error: "Already in the list." };
  const next = [...list, n];
  if (next.length > MAX_WEB_ORIGINS) return { list: [...list], error: `At most ${MAX_WEB_ORIGINS} origins.` };
  if (next.join(",").length > MAX_WEB_ORIGINS_CHARS) return { list: [...list], error: "The list is too long." };
  return { list: next, error: null };
}
