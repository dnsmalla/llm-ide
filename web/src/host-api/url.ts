// The host address the user enters. Spec: TLS/WSS for non-loopback clients; plaintext only to this computer.
export const DEFAULT_HOST_URL = "ws://127.0.0.1:3016/host-api/v1";
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function checkHostUrl(raw: string, pageProtocol: string | undefined = globalThis.location?.protocol): { ok: true; url: string } | { ok: false; reason: string } {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return { ok: false, reason: "Enter a hub address: https://hub.example.com, or wss://host/host-api/v1." }; }
  // A hub URL is typed as its public https address; the browser client speaks wss to the same host.
  // A bare host, or the /app/ URL, normalises to the one Host API path. Exact ws(s) URLs still work.
  const ws = u.protocol === "https:" ? "wss:" : u.protocol === "http:" ? "ws:" : u.protocol;
  if (ws !== "ws:" && ws !== "wss:") return { ok: false, reason: "The address must start with https://, ws:// or wss://." };
  if (u.username || u.password || u.search || u.hash) return { ok: false, reason: "The address must not carry a user, query or fragment." };
  let path = u.pathname;
  if (path === "" || path === "/" || path === "/app" || path === "/app/") path = "/host-api/v1";
  if (path !== "/host-api/v1") return { ok: false, reason: "Enter the hub address (https://host) or end the address in /host-api/v1." };
  if (ws === "ws:" && !LOOPBACK.has(u.hostname)) {
    return { ok: false, reason: "Plain ws:// is allowed only to this computer (127.0.0.1 or localhost). Use https:// or wss:// for another host." };
  }
  if (ws === "ws:" && pageProtocol === "https:") return { ok: false, reason: "This page is served over https, so the host must use https:// or wss://." };
  return { ok: true, url: `${ws}//${u.host}${path}` };
}

// An https page cannot use the plaintext loopback default (checkHostUrl refuses it): start empty there.
export function initialHostUrl(env: string | undefined, last: string | null, pageProtocol: string | undefined = globalThis.location?.protocol): string {
  for (const c of [last, env]) {
    if (!c) continue;
    const r = checkHostUrl(c, pageProtocol);
    if (r.ok) return r.url;
  }
  return pageProtocol === "https:" ? "" : DEFAULT_HOST_URL;
}

export function hostUrlHint(pageProtocol: string | undefined = globalThis.location?.protocol): string {
  return pageProtocol === "https:"
    ? "For a hub, enter https://hub.example.com. For a desktop, wss://<host>:<port>/host-api/v1."
    : `For a hub, enter https://hub.example.com. For this computer, ${DEFAULT_HOST_URL}.`;
}
