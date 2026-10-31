// Browser-mode fallback for opening a link (no desktop host): only public https URLs. The desktop app goes through
// the host's `open_external_url`, which validates again; this keeps `window.open` from becoming a way to reach
// local services (127.0.0.1, 192.168.x.x, internal names) or non-web schemes with a URL the core or a source gave us.

const PRIVATE_V4 = (a: number, b: number): boolean =>
  a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;

/** The normalised URL when it is a public https address without credentials; otherwise null. */
export function publicHttpsUrl(raw: string): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048 || /[\u0000- \u007f]/.test(raw)) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username !== "" || u.password !== "") return null;
  const h = u.hostname.toLowerCase().replace(/\.$/, "");
  if (h === "" || h.startsWith("[") || h.includes(":")) return null; // IPv6 literals are never needed for a docs/auth page
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".lan") || h.endsWith(".home.arpa") || !h.includes(".")) return null;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (v4.slice(1).some((x) => Number(x) > 255) || PRIVATE_V4(a, b)) return null;
  } else if (/^[0-9.x]+$/i.test(h)) {
    return null; // octal/hex/short IPv4 spellings
  }
  return u.href;
}
