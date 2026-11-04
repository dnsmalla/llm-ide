// The host address the user enters. Spec: TLS/WSS for non-loopback clients; plaintext only to this computer.
export const DEFAULT_HOST_URL = "ws://127.0.0.1:3016/host-api/v1";
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function checkHostUrl(raw: string, pageProtocol: string | undefined = globalThis.location?.protocol): { ok: true; url: string } | { ok: false; reason: string } {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return { ok: false, reason: "Enter a ws:// or wss:// address." }; }
  if (u.protocol !== "ws:" && u.protocol !== "wss:") return { ok: false, reason: "The address must start with ws:// or wss://." };
  if (u.username || u.password || u.search || u.hash) return { ok: false, reason: "The address must not carry a user, query or fragment." };
  if (u.pathname !== "/host-api/v1") return { ok: false, reason: "The address must end in /host-api/v1." };
  if (u.protocol === "ws:" && !LOOPBACK.has(u.hostname)) {
    return { ok: false, reason: "Plain ws:// is allowed only to this computer (127.0.0.1 or localhost). Use wss:// for another host." };
  }
  if (u.protocol === "ws:" && pageProtocol === "https:") return { ok: false, reason: "This page is served over https, so the host must use wss://." };
  return { ok: true, url: `${u.protocol}//${u.host}${u.pathname}` };
}

export function initialHostUrl(env: string | undefined, last: string | null): string {
  for (const c of [last, env]) {
    if (!c) continue;
    const r = checkHostUrl(c);
    if (r.ok) return r.url;
  }
  return DEFAULT_HOST_URL;
}
