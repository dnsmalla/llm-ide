// A small typed event bus for cross-screen requests ("open this file in Explorer", "go to a section").
// Screens never import each other: the sender publishes, the owner of the target subscribes.
//
// A target section is mounted lazily, so a request can arrive before its subscriber exists. Events marked
// `sticky` are therefore kept (latest one per type) until the target acknowledges them; a late subscriber
// asks `takePending(type)` once on mount, and a target that handled an event live calls it too (acknowledge). Paths are always PROJECT-RELATIVE with `/` separators: the webview
// never passes an absolute path to a host command, and a request that does not look relative is refused here.
import type { SectionId } from "./sections";

export type ShellEvent =
  /** Open a file of the open project in Explorer (switches to the Explorer section). */
  | { type: "open-file"; path: string; line?: number }
  /** Switch section; `anchor` is a section-specific sub-page id (Settings: "about", "providers", ...). */
  | { type: "goto-section"; section: SectionId; anchor?: string };

export type ShellEventType = ShellEvent["type"];
type Handler<T extends ShellEventType> = (ev: Extract<ShellEvent, { type: T }>) => void;

/** A pending request older than this is stale (the user moved on). */
export const PENDING_TTL_MS = 10_000;

const STICKY: ReadonlySet<ShellEventType> = new Set<ShellEventType>(["open-file", "goto-section"]);

/** Project-relative path check: no absolute form, no `..`, no NUL, bounded. Returns the normalised path or null. */
export function safeRelativePath(raw: string): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 4096 || raw.includes("\0")) return null;
  const p = raw.replaceAll("\\", "/");
  if (p.startsWith("/") || /^[A-Za-z]:/.test(p)) return null;
  const parts: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") return null;
    parts.push(seg);
  }
  return parts.length ? parts.join("/") : null;
}

/** Turns a path found in model/tool output into a project-relative one, or null when it is outside the project. */
export function relativeToProject(raw: string, projectRoot: string | null): string | null {
  if (!projectRoot || typeof raw !== "string") return null;
  const norm = (s: string) => s.replaceAll("\\", "/").replace(/\/+$/, "");
  const root = norm(projectRoot);
  const p = raw.replaceAll("\\", "/");
  const abs = p.startsWith("/") || /^[A-Za-z]:/.test(p);
  if (!abs) return safeRelativePath(p);
  const insensitive = /^[A-Za-z]:/.test(root); // Windows drive paths compare case-insensitively
  const a = insensitive ? p.toLowerCase() : p;
  const r = insensitive ? root.toLowerCase() : root;
  if (!a.startsWith(r + "/")) return null;
  return safeRelativePath(p.slice(root.length + 1));
}

export interface ShellBus {
  publish(ev: ShellEvent): void;
  subscribe<T extends ShellEventType>(type: T, handler: Handler<T>): () => void;
  /** The latest unacknowledged sticky event of this type (and clears it), for a subscriber that mounted late. */
  takePending<T extends ShellEventType>(type: T): Extract<ShellEvent, { type: T }> | null;
}

export function createShellBus(now: () => number = Date.now): ShellBus {
  const handlers = new Map<ShellEventType, Set<(ev: ShellEvent) => void>>();
  const pending = new Map<ShellEventType, { ev: ShellEvent; at: number }>();
  return {
    publish(raw) {
      let ev = raw;
      if (ev.type === "open-file") {
        const path = safeRelativePath(ev.path);
        if (path === null) return;
        ev = { ...ev, path };
      }
      const subs = handlers.get(ev.type);
      if (STICKY.has(ev.type)) pending.set(ev.type, { ev, at: now() });
      for (const h of [...(subs ?? [])]) {
        try {
          h(ev);
        } catch {
          // a broken subscriber must not stop the others
        }
      }
    },
    subscribe(type, handler) {
      let set = handlers.get(type);
      if (!set) handlers.set(type, (set = new Set()));
      const h = handler as (ev: ShellEvent) => void;
      set.add(h);
      return () => set.delete(h);
    },
    takePending(type) {
      const p = pending.get(type);
      pending.delete(type);
      if (!p || now() - p.at > PENDING_TTL_MS) return null;
      return p.ev as Extract<ShellEvent, { type: typeof type }>;
    },
  };
}

/** The app-wide bus. */
export const shellBus: ShellBus = createShellBus();
