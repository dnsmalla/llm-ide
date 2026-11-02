// Client port of the core's provider base-URL rule, so the form can say why an address will be refused before the
// request. Sources, kept in step by tests/base-url-rule.test.ts (which runs the real core guard on the same table):
//   extension/server/ip-classifier.mjs       parseIp / classifyIp (one table for every IP spelling)
//   extension/server/base-url-guard.mjs      assertProviderBaseUrl
//   extension/server/provider-connections.mjs the posture a connect uses (entry.local, entry.allowPrivate, opt-in)
// The core stays authoritative (it also applies the operator gate LLMIDE_ALLOW_PRIVATE_PROVIDERS and checks DNS at
// connect time); this port must never refuse an address the core would accept.

type IpClass = "public" | "private" | "never";
interface IpVerdict { ip: boolean; class: IpClass; reason: string }

const V4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/** 16 bytes (IPv4 as IPv4-mapped) or null when the text is not an IP literal. */
function parseIp(text: string): Uint8Array | null {
  let s = text.trim().replace(/^\[|\]$/g, "");
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  if (V4.test(s)) return new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, ...s.split(".").map(Number)]);
  if (!s.includes(":") || !/^[0-9a-fA-F:.]+$/.test(s)) return null;
  let head = s;
  let tail4: number[] | null = null;
  if (s.includes(".")) {
    const colon = s.lastIndexOf(":");
    const quad = s.slice(colon + 1);
    if (!V4.test(quad)) return null;
    tail4 = quad.split(".").map(Number);
    head = `${s.slice(0, colon + 1)}0:0`;
  }
  const halves = head.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const parts = [...left, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...right];
  if (parts.some((g) => !/^[0-9a-fA-F]{1,4}$/.test(g))) return null;
  const out = new Uint8Array(16);
  parts.forEach((g, i) => { const n = parseInt(g, 16); out[2 * i] = n >> 8; out[2 * i + 1] = n & 0xff; });
  if (tail4) tail4.forEach((n, i) => { out[12 + i] = n; });
  return out;
}

function classifyV4(a: number, b: number, c: number): [IpClass, string] {
  if (a === 0) return ["never", 'unspecified or "this network" address'];
  if (a === 127) return ["private", "loopback address"];
  if (a === 10) return ["private", "private (RFC 1918) address"];
  if (a === 172 && b >= 16 && b <= 31) return ["private", "private (RFC 1918) address"];
  if (a === 192 && b === 168) return ["private", "private (RFC 1918) address"];
  if (a === 100 && b >= 64 && b <= 127) return ["private", "carrier-grade NAT address"];
  if (a === 169 && b === 254) return ["never", "link-local or cloud-metadata address"];
  if (a === 192 && b === 0 && c === 0) return ["never", "IETF protocol-assignment address"];
  if (a === 192 && b === 0 && c === 2) return ["never", "documentation address"];
  if (a === 198 && (b === 18 || b === 19)) return ["never", "benchmarking address"];
  if (a === 198 && b === 51 && c === 100) return ["never", "documentation address"];
  if (a === 203 && b === 0 && c === 113) return ["never", "documentation address"];
  if (a >= 224 && a <= 239) return ["never", "multicast address"];
  if (a >= 240) return ["never", "reserved or broadcast address"];
  return ["public", ""];
}

const METADATA_V6 = parseIp("fd00:ec2::254")!;

export function classifyIp(text: string): IpVerdict {
  const b = parseIp(text);
  if (!b) return { ip: false, class: "public", reason: "" };
  const zeros = (from: number, to: number) => { for (let i = from; i < to; i += 1) if (b[i] !== 0) return false; return true; };
  const embedded = () => classifyV4(b[12]!, b[13]!, b[14]!);
  const done = ([cls, reason]: [IpClass, string]): IpVerdict => ({ ip: true, class: cls, reason });
  if (zeros(0, 10) && b[10] === 0xff && b[11] === 0xff) return done(embedded());
  if (zeros(0, 12)) {
    if (zeros(12, 15) && b[15] === 0) return done(["never", "unspecified address"]);
    if (zeros(12, 15) && b[15] === 1) return done(["private", "loopback address"]);
    return done(embedded());
  }
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zeros(4, 12)) return done(embedded());
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && b[4] === 0 && b[5] === 1) return done(["never", "NAT64 local-use address"]);
  if (b[0] === 0x20 && b[1] === 0x02) return done(classifyV4(b[2]!, b[3]!, b[4]!));
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0 && b[3] === 0) return done(["never", "Teredo tunnel address"]);
  if (b[0] === 0xff) return done(["never", "multicast address"]);
  if (b[0] === 0xfe && (b[1]! & 0xc0) === 0x80) return done(["never", "link-local address"]);
  if (b[0] === 0xfe && (b[1]! & 0xc0) === 0xc0) return done(["private", "site-local address"]);
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return done(["never", "documentation address"]);
  if ((b[0]! & 0xfe) === 0xfc) {
    if (METADATA_V6.every((v, i) => v === b[i])) return done(["never", "cloud-metadata address"]);
    return done(["private", "unique-local (ULA) address"]);
  }
  return done(["public", ""]);
}

const isPrivateName = (h: string) => h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local");

export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  const c = classifyIp(h);
  return c.ip && c.reason === "loopback address";
}

/** `assertProviderBaseUrl` as a value: the core's refusal message, or null when the core accepts the URL. */
export function providerBaseUrlRefusal(url: string, allowPrivate: boolean): string | null {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return "Base URL is not a valid URL"; }
  if (/[?#]/.test(url)) return "Base URL must not contain a query string or fragment";
  if (parsed.username || parsed.password) return "Base URL must not contain credentials";
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (parsed.protocol !== "https:" && !(allowPrivate && parsed.protocol === "http:")) {
    return allowPrivate ? "Base URL must use http or https" : "Base URL must use https";
  }
  const c = classifyIp(host);
  if (c.ip) {
    if (c.class === "never") return `Base URL host is a ${c.reason} (${host}); never allowed`;
    if (c.class === "private" && !allowPrivate) return `Base URL host is a ${c.reason} (${host}); not allowed for this provider`;
    if (parsed.protocol === "http:" && c.class !== "private") return PLAIN_HTTP_CORE;
  } else {
    if (isPrivateName(host) && !allowPrivate) return "Base URL points at a local or private address; this provider does not allow that";
    if (parsed.protocol === "http:" && !isPrivateName(host)) return PLAIN_HTTP_CORE;
  }
  return null;
}

const PLAIN_HTTP_CORE = "Plain http is only allowed for a local or private address";

/** The Mac's sentence for plain http to a host that is not local (ProviderForms.swift). */
export const PLAIN_HTTP_REMOTE = "This URL uses plain http to a non-local host: your API key would be sent unencrypted. Use https.";
export const PLAIN_HTTP_NEEDS_OPT_IN = "http:// is only allowed for a private-network address you opted into. Use https://, or tick the private-network box.";

/**
 * What a connect with this catalog entry, address and opt-in would be refused for, worded for the form; null when the
 * core would accept it (modulo the operator gate and DNS, which only the core can see).
 */
export function connectBaseUrlIssue(entry: { name: string; baseURL: string; local: boolean; allowPrivate: boolean }, url: string, allowPrivate: boolean): string | null {
  const priv = entry.local ? true : entry.allowPrivate && allowPrivate;
  if (entry.local && url !== entry.baseURL && !allowPrivate) {
    let loop = false;
    try { loop = isLoopbackHost(new URL(url).hostname); } catch { loop = false; }
    if (!loop) return `${entry.name} on another host needs the private-network opt-in`;
  }
  const why = providerBaseUrlRefusal(url, priv);
  if (why === null) return null;
  let http = false;
  try { http = new URL(url).protocol === "http:"; } catch { http = false; }
  if (http && !priv && entry.allowPrivate) return PLAIN_HTTP_NEEDS_OPT_IN;
  if (why === PLAIN_HTTP_CORE) return PLAIN_HTTP_REMOTE;
  return why;
}
