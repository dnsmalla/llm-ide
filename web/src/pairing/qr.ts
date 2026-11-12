// Pure parser for the desktop's pairing QR / link: `llmide://pair?ip=A&ip=B…&pin=NNNNNN&h1port=P&h1fp=sha256:…&api=1`.
// Mirrors ios_app/SharedProtocol PairingInfo.swift: a scanned code re-points this browser at whatever host it names, so
// every field is validated and anything else is refused. NOTE: keep in step with PairingInfo.swift when it changes.

export const MAX_ADDRESSES = 4;

export interface PairingOffer {
  addresses: string[]; // validated, de-duplicated, QR order, 1..4
  pin: string;
  port: number;
  fingerprint: string; // sha256:<43 base64url chars>
}

export const isWellFormedPin = (pin: string): boolean => /^[0-9]{6}$/.test(pin);
export const isValidFingerprint = (s: string): boolean => /^sha256:[A-Za-z0-9_-]{43}$/.test(s);
const isValidPort = (s: string | undefined): s is string => s !== undefined && /^[0-9]{1,5}$/.test(s) && Number(s) >= 1 && Number(s) <= 65535;

function isPrivateIPv4(o: number[]): boolean {
  const [a, b] = o as [number, number];
  return a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

function isPrivateIPv6(addr: string): boolean {
  const lower = addr.toLowerCase();
  if (!/^[0-9a-f:]+$/.test(lower)) return false;
  if (lower === "::1") return true;
  const first = lower.split(":")[0] ?? "";
  if (first.length !== 4) return false;
  return /^fe[89ab]/.test(first) || /^f[cd]/.test(first);
}

const labelsOk = (labels: string[]) => labels.every((l) => l.length > 0 && l.length <= 63 && /^[A-Za-z0-9-]+$/.test(l));

function canonicalPrivateHost(host: string): string | null {
  if (host.length === 0 || host.length > 255) return null;
  if (host.includes(":")) {
    const at = host.indexOf("%");
    const addr = at < 0 ? host : host.slice(0, at);
    if (!isPrivateIPv6(addr)) return null;
    if (at < 0) return addr;
    const zone = host.slice(at + 1);
    return zone.length > 0 && zone.length <= 15 && /^[A-Za-z0-9]+$/.test(zone) ? `${addr}%${zone}` : null;
  }
  if (host.includes("%")) return null;
  const octets = host.split(".");
  if (octets.length === 4 && octets.every((o) => /^[0-9]+$/.test(o))) {
    const v = octets.map(Number);
    return v.every((n) => n >= 0 && n <= 255) && isPrivateIPv4(v) ? host : null;
  }
  const lower = host.toLowerCase();
  if (!(lower.endsWith(".local") || lower.endsWith(".ts.net"))) return null;
  const labels = host.split(".");
  return labels.length >= 2 && labelsOk(labels) ? host : null;
}

/** A public hub name is accepted only with a valid certificate pin (the optical channel is then the trust anchor). */
function canonicalHost(host: string, fingerprint: string): string | null {
  const priv = canonicalPrivateHost(host);
  if (priv) return priv;
  if (!isValidFingerprint(fingerprint)) return null;
  if (host.length === 0 || host.length > 253 || /[%:/?@#]/.test(host) || host.startsWith("-") || host.endsWith(".") || host.endsWith("-")) return null;
  const labels = host.split(".");
  if (labels.length < 2) return null;
  if (labels.length === 4 && labels.every((l) => /^[0-9]+$/.test(l))) return null; // a public IP literal is never a hub name
  return labelsOk(labels) && labels.every((l) => !l.startsWith("-") && !l.endsWith("-")) ? host.toLowerCase() : null;
}

function queryItems(query: string): [string, string][] {
  const out: [string, string][] = [];
  for (const part of query.split("&")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    const name = eq < 0 ? part : part.slice(0, eq);
    const raw = eq < 0 ? "" : part.slice(eq + 1);
    try { out.push([decodeURIComponent(name), decodeURIComponent(raw)]); } catch { /* a malformed escape drops only that item */ }
  }
  return out;
}

/** Parse a scanned or pasted pairing link; null when it is not one this browser is willing to act on. */
export function parsePairingLink(text: string): PairingOffer | null {
  const s = text.trim();
  const m = /^llmide:\/\/pair\/?\?([^#]*)(#.*)?$/i.exec(s);
  if (!m) return null;
  const items = queryItems(m[1] ?? "");
  const pin = items.find(([k]) => k === "pin")?.[1];
  const port = items.find(([k]) => k === "h1port")?.[1];
  const fp = items.find(([k]) => k === "h1fp")?.[1];
  if (pin === undefined || !isWellFormedPin(pin) || !isValidPort(port) || fp === undefined || !isValidFingerprint(fp)) return null;
  const addresses: string[] = [];
  for (const [k, v] of items) {
    if (k !== "ip") continue;
    const c = canonicalHost(v, fp);
    if (c && !addresses.includes(c)) addresses.push(c);
    if (addresses.length === MAX_ADDRESSES) break;
  }
  if (addresses.length === 0) return null;
  return { addresses, pin, port: Number(port), fingerprint: fp };
}

/** `wss://<ip>:<port>/host-api/v1` per address, in order. An IPv6 literal is bracketed (its zone id percent-encoded). */
export function candidateUrls(o: PairingOffer): string[] {
  return o.addresses.map((a) => `wss://${a.includes(":") ? `[${a.replace("%", "%25")}]` : a}:${o.port}/host-api/v1`);
}
