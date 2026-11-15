/** Normalize a remote host address to a Host API WebSocket URL. `https` and bare hosts become `wss://`. */
export function normalizeRemoteUrl(raw: string): string {
  const v = raw.trim();
  if (!v) throw new Error("Enter the host address.");
  const withScheme = /^wss?:\/\//.test(v) ? v : `wss://${v.replace(/^https?:\/\//, "")}`;
  const u = new URL(withScheme);
  if (u.protocol !== "wss:" && u.protocol !== "ws:") throw new Error("The address must be ws:// or wss://.");
  if (!u.pathname || u.pathname === "/") u.pathname = "/host-api/v1";
  return u.toString();
}

/** Origins the webview CSP (`connect-src` in desktop/src-tauri/tauri.conf.json) lets the workspace socket reach. Keep in sync. */
export const ALLOWED_HOST_API_ORIGINS: readonly string[] = ["wss://llm-ide.com"];

/**
 * The Host API socket is opened by the webview, so any other origin is blocked by the CSP and would fail with an
 * opaque network error. Refuse it up front with a message that says why. Throws on a blocked origin.
 */
export function assertAllowedHostApiUrl(raw: string): string {
  const url = normalizeRemoteUrl(raw);
  const origin = new URL(url).origin;
  if (!ALLOWED_HOST_API_ORIGINS.includes(origin)) {
    throw new Error(`This app can only open workspaces on ${ALLOWED_HOST_API_ORIGINS.join(", ")}; ${origin} is blocked by the app's content security policy. The workspace address must be on an allowed origin.`);
  }
  return url;
}
