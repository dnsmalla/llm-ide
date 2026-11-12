// The section lives in the URL hash (#/ask, #/history, #/settings/sources) so a reload or a shared link lands on it.
// No router library: one hashchange subscription. `?a=b` after the path carries parameters (the dev gallery uses it).
import { useSyncExternalStore } from "react";

export interface Route { section: string | null; sub: string | null; params: URLSearchParams }
/** Old or friendly names that map onto section ids. */
const ALIAS: Record<string, string> = { chat: "ask", tasks: "tasks", "auto-tasks": "tasks", autotasks: "tasks" };

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#\/?/, "");
  const q = raw.indexOf("?");
  const path = q < 0 ? raw : raw.slice(0, q);
  const params = new URLSearchParams(q < 0 ? "" : raw.slice(q + 1));
  const [first, second] = path.split("/").filter(Boolean);
  const section = first ? (ALIAS[first.toLowerCase()] ?? first.toLowerCase()) : null;
  return { section, sub: second ? second.toLowerCase() : null, params };
}
export const formatHash = (section: string, sub?: string | null) => `#/${section}${sub ? `/${sub}` : ""}`;

const read = () => globalThis.location?.hash ?? "";
const subscribe = (fn: () => void) => { globalThis.addEventListener?.("hashchange", fn); return () => globalThis.removeEventListener?.("hashchange", fn); };
/** The current route, re-rendered on every hash change. */
export function useRoute(): Route {
  const h = useSyncExternalStore(subscribe, read, () => "");
  return parseHash(h);
}
export function navigate(section: string, sub?: string | null, replace = false) {
  const next = formatHash(section, sub);
  if (!globalThis.location || globalThis.location.hash === next) return;
  if (replace) globalThis.history.replaceState(null, "", next);
  else globalThis.location.hash = next;
  if (replace) globalThis.dispatchEvent?.(new HashChangeEvent("hashchange"));
}
