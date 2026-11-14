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
