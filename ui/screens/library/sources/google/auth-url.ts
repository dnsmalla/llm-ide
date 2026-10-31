// The one check between the core's `authUrl` and the host opener. The core never opens a browser; the UI does,
// through `open_external_url` (which asks the user once per site). Before handing anything to it, this check
// requires an address that is exactly a Google sign-in page and nothing else: https, host `accounts.google.com`
// (no port, no credentials, no look-alike host), the OAuth path, the code flow, and the `state` we were given.
// A redirect_uri, when present, must be this machine's loopback on the port the core announced.
// The state value itself is never shown or logged.

export const GOOGLE_AUTH_HOST = "accounts.google.com";
const AUTH_PATHS: readonly string[] = ["/o/oauth2/v2/auth", "/o/oauth2/auth"];
const MAX_URL = 4096;

export interface AuthUrlExpect {
  state: string;
  /** The loopback port the core announced; when 0 or absent a redirect_uri is not checked for its port. */
  redirectPort: number;
}

/** The normalised URL when it is a safe Google sign-in address for this flow; otherwise null. */
export function validateAuthUrl(raw: unknown, expect: AuthUrlExpect): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_URL) return null;
  // No whitespace, control characters, backslashes or non-ASCII anywhere (blocks userinfo and parser tricks).
  if (/[^\x21-\x7e]/.test(raw) || raw.includes("\\")) return null;
  // The literal text must start with the exact origin: `https://accounts.google.com/` (lowercase host, no port).
  if (!raw.startsWith(`https://${GOOGLE_AUTH_HOST}/`)) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.hostname !== GOOGLE_AUTH_HOST || u.port !== "" || u.username !== "" || u.password !== "" || u.hash !== "") return null;
  if (!AUTH_PATHS.includes(u.pathname)) return null;
  const q = u.searchParams;
  for (const k of ["client_id", "response_type", "state", "redirect_uri", "code_challenge_method", "scope"]) if (q.getAll(k).length > 1) return null;
  if (q.get("response_type") !== "code") return null;
  const clientId = q.get("client_id");
  if (!clientId || !/^[A-Za-z0-9._-]{5,300}$/.test(clientId)) return null;
  if (typeof expect.state !== "string" || expect.state === "" || q.get("state") !== expect.state) return null;
  const redirect = q.get("redirect_uri");
  if (redirect !== null) {
    let r: URL;
    try {
      r = new URL(redirect);
    } catch {
      return null;
    }
    if (r.protocol !== "http:" || r.hostname !== "127.0.0.1" || r.username !== "" || r.password !== "" || r.pathname !== "/oauth2/callback" || r.search !== "" || r.hash !== "") return null;
    if (expect.redirectPort > 0 && r.port !== String(expect.redirectPort)) return null;
  }
  const method = q.get("code_challenge_method");
  if (method !== null && method !== "S256") return null;
  return u.href;
}
