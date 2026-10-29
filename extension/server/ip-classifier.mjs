// One classifier for every IP form, shared by the literal base-URL check, the
// DNS-resolved check and the connect-time pin (server/pinned-fetch.mjs).
//
// `classifyIp(text)` canonicalises an address to bytes first (IPv4 in any
// spelling the URL parser or resolver can hand us, IPv6 with `::`, embedded
// dotted quads, IPv4-mapped `::ffff:a.b.c.d` / `::ffff:7f00:1`, IPv4-compatible
// `::a.b.c.d`, NAT64 `64:ff9b::/96`, 6to4 `2002::/16`) and then applies ONE
// table, so a spelling can never change the verdict.
//
// Verdict classes:
//   'public'   routable unicast
//   'private'  loopback, RFC 1918, CGNAT 100.64/10, IPv6 ULA fc00::/7,
//              site-local: reachable on the user's own network, allowed only
//              behind an explicit opt-in (and the operator gate)
//   'never'    link-local (v4 + v6; cloud metadata 169.254.169.254, fd00:ec2::254
//              is covered by ULA below AND listed explicitly), unspecified,
//              0.0.0.0/8, multicast, broadcast, reserved, documentation,
//              benchmarking, IETF protocol assignments: refused in every mode

import net from 'node:net';

const METADATA_V6 = 'fd00:ec2::254';

/** Parse text to 16 bytes (IPv4 becomes IPv4-mapped); null when it is not an IP. */
export function parseIp(text) {
  if (typeof text !== 'string') return null;
  let s = text.trim().replace(/^\[|\]$/g, '');
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  const fam = net.isIP(s);
  if (fam === 4) {
    const p = s.split('.').map(Number);
    return new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, ...p]);
  }
  if (fam !== 6) return null;
  let head = s;
  let tail4 = null;
  const dot = s.lastIndexOf('.');
  if (dot >= 0) {
    const colon = s.lastIndexOf(':');
    const q = s.slice(colon + 1).split('.').map(Number);
    if (q.length !== 4 || q.some((n) => !(n >= 0 && n <= 255))) return null;
    tail4 = q;
    head = `${s.slice(0, colon + 1)}0:0`;
  }
  const halves = head.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const groups = [...left, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...right].map((g) => parseInt(g || '0', 16));
  if (groups.length !== 8 || groups.some((g) => !(g >= 0 && g <= 0xffff))) return null;
  const out = new Uint8Array(16);
  groups.forEach((g, i) => { out[2 * i] = g >> 8; out[2 * i + 1] = g & 0xff; });
  if (tail4) tail4.forEach((n, i) => { out[12 + i] = n; });
  return out;
}

const NEVER = 'never';
const PRIVATE = 'private';
const PUBLIC = 'public';

function classifyV4(a, b, c) {
  if (a === 0) return [NEVER, 'unspecified or "this network" address'];
  if (a === 127) return [PRIVATE, 'loopback address'];
  if (a === 10) return [PRIVATE, 'private (RFC 1918) address'];
  if (a === 172 && b >= 16 && b <= 31) return [PRIVATE, 'private (RFC 1918) address'];
  if (a === 192 && b === 168) return [PRIVATE, 'private (RFC 1918) address'];
  if (a === 100 && b >= 64 && b <= 127) return [PRIVATE, 'carrier-grade NAT address'];
  if (a === 169 && b === 254) return [NEVER, 'link-local or cloud-metadata address'];
  if (a === 192 && b === 0 && c === 0) return [NEVER, 'IETF protocol-assignment address'];
  if (a === 192 && b === 0 && c === 2) return [NEVER, 'documentation address'];
  if (a === 198 && (b === 18 || b === 19)) return [NEVER, 'benchmarking address'];
  if (a === 198 && b === 51 && c === 100) return [NEVER, 'documentation address'];
  if (a === 203 && b === 0 && c === 113) return [NEVER, 'documentation address'];
  if (a >= 224 && a <= 239) return [NEVER, 'multicast address'];
  if (a >= 240) return [NEVER, 'reserved or broadcast address'];
  return [PUBLIC, ''];
}

/**
 * @param {string} text an IP literal in any form (brackets allowed)
 * @returns {{ ip: boolean, class: 'public'|'private'|'never', reason: string }}
 *   `ip:false` when `text` is not an IP at all (a hostname).
 */
export function classifyIp(text) {
  const b = parseIp(text);
  if (!b) return { ip: false, class: PUBLIC, reason: '' };
  const zeros = (from, to) => { for (let i = from; i < to; i += 1) if (b[i] !== 0) return false; return true; };
  const embedded = () => classifyV4(b[12], b[13], b[14]);
  const done = ([cls, reason]) => ({ ip: true, class: cls, reason });
  // IPv4-mapped ::ffff:0:0/96 and IPv4-compatible ::/96 (but not :: and ::1)
  if (zeros(0, 10) && b[10] === 0xff && b[11] === 0xff) return done(embedded());
  if (zeros(0, 12)) {
    if (zeros(12, 15) && b[15] === 0) return done([NEVER, 'unspecified address']);
    if (zeros(12, 15) && b[15] === 1) return done([PRIVATE, 'loopback address']);
    return done(embedded());
  }
  // NAT64 64:ff9b::/96 (and 64:ff9b:1::/48 local-use) embed an IPv4 target
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zeros(4, 12)) return done(embedded());
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && b[4] === 0 && b[5] === 1) return done([NEVER, 'NAT64 local-use address']);
  // 6to4 2002::/16 embeds the IPv4 address in bytes 2..5
  if (b[0] === 0x20 && b[1] === 0x02) return done(classifyV4(b[2], b[3], b[4]));
  // Teredo 2001::/32
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0 && b[3] === 0) return done([NEVER, 'Teredo tunnel address']);
  if (b[0] === 0xff) return done([NEVER, 'multicast address']);
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return done([NEVER, 'link-local address']);
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0xc0) return done([PRIVATE, 'site-local address']);
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return done([NEVER, 'documentation address']);
  if ((b[0] & 0xfe) === 0xfc) {
    const meta = parseIp(METADATA_V6);
    if (meta.every((v, i) => v === b[i])) return done([NEVER, 'cloud-metadata address']);
    return done([PRIVATE, 'unique-local (ULA) address']);
  }
  return done([PUBLIC, '']);
}

/** The refusal for an address under the given posture, or null when it is fine. */
export function ipRefusal(address, { allowPrivate = false } = {}) {
  const c = classifyIp(address);
  if (!c.ip) return null;
  if (c.class === NEVER) return `${c.reason} (${address}); never allowed`;
  if (c.class === PRIVATE && !allowPrivate) return `${c.reason} (${address}); not allowed for this provider`;
  return null;
}
