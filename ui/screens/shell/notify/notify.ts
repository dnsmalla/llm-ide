// Native notifications and the tray, webview side. The HOST builds every word a notification shows from a fixed
// table (desktop/src-tauri/src/notify.rs). This side names only a kind, an opaque de-dup key and a count, so chat
// text, paths, captions, tokens and device names cannot reach a notification. Pure helpers; wiring is in bridge.ts.
import { invokeHost, isHostAvailable } from "../host";
import type { NotifyPrefs } from "../host-prefs";
import { SECTIONS, type SectionId } from "../sections";

export type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

/** The host bridge, or a no-op outside the desktop app (plain browser, tests). */
export const defaultInvoke: Invoke = (cmd, args) => (isHostAvailable() ? invokeHost<unknown>(cmd, args) : Promise.resolve(null));

/** Kinds the webview may raise (`Kind::from_webview` in notify.rs; a test keeps both lists in step). */
export const WEBVIEW_KINDS = [
  "approval_chat", "approval_job", "loop_done", "loop_failed", "autotask_done", "autotask_failed",
  "graph_done", "graph_failed", "docgen_done", "docgen_failed", "sync_attention",
] as const;
export type NotifyKind = (typeof WEBVIEW_KINDS)[number];
export type TaskSource = "loop" | "autotask" | "graph" | "docgen";

export const taskKind = (source: TaskSource, ok: boolean): NotifyKind => `${source}_${ok ? "done" : "failed"}` as NotifyKind;

/** Best effort: no host, a switched-off category, a refused permission or a missing notification daemon is silent. */
export async function notifyUser(kind: NotifyKind, opts: { key?: string; count?: number } = {}, invoke: Invoke = defaultInvoke): Promise<void> {
  try {
    await invoke("notify_user", { kind, key: opts.key ?? null, count: opts.count ?? null });
  } catch {
    // best effort
  }
}

/** A long task ended (Loop, Auto Task, Graph, Doc Gen). */
export const notifyTask = (source: TaskSource, ok: boolean): Promise<void> => notifyUser(taskKind(source, ok));

/** Tells the host which section the window shows (no notification for the place the user is looking at). */
export async function reportSection(section: SectionId, invoke: Invoke = defaultInvoke): Promise<void> {
  try {
    await invoke("notify_focus", { section });
  } catch {
    // best effort
  }
}

export type TrayAction = { type: "capture" } | { type: "sync" } | { type: "inbox" } | { type: "goto"; section: SectionId; anchor?: string };

const IDS: ReadonlySet<string> = new Set(SECTIONS.map((s) => s.id));
const ANCHOR = /^[a-z][a-z0-9-]{0,40}$/;

/** A `tray-action` payload from the host -> what the shell does; anything else is ignored. */
export function trayAction(payload: unknown): TrayAction | null {
  if (payload === "capture_toggle") return { type: "capture" };
  if (payload === "sync_toggle") return { type: "sync" };
  if (typeof payload !== "string" || payload.length > 80 || !payload.startsWith("route:")) return null;
  const [section, anchor, extra] = payload.slice("route:".length).split(":");
  if (section === "inbox") return anchor === undefined ? { type: "inbox" } : null;
  if (!IDS.has(section) || extra !== undefined || (anchor !== undefined && !ANCHOR.test(anchor))) return null;
  return anchor === undefined ? { type: "goto", section: section as SectionId } : { type: "goto", section: section as SectionId, anchor };
}

export type SyncReport = "unknown" | "on" | "paused";

/** The tray's sync item from a decoded `/kb/sync/status` (null = unavailable). */
export const syncReport = (s: { configured: boolean; enabled: boolean } | null): SyncReport => (!s || !s.configured ? "unknown" : s.enabled ? "on" : "paused");

/** Activity kinds that mean "sync needs the user" (extension/kb/activity.mjs). */
export const SYNC_ACTIVITY_KINDS: ReadonlySet<string> = new Set(["sync_attention", "sync_device_removed"]);

/** New sync rows after `sinceId`, and the new high-water mark. */
export function syncAlerts(items: readonly { id: number; kind: string | null }[], sinceId: number): { ids: number[]; lastId: number } {
  const fresh = items.filter((i) => i.id > sinceId);
  return {
    ids: fresh.filter((i) => i.kind !== null && SYNC_ACTIVITY_KINDS.has(i.kind)).map((i) => i.id),
    lastId: fresh.reduce((m, i) => Math.max(m, i.id), sinceId),
  };
}

/** A Doc Gen run's end from two phases: true = done, false = failed, null = not an end (a cancel goes to idle). */
export function generationEnded(prev: string, next: string): boolean | null {
  if (prev !== "generating" && prev !== "reading") return null;
  return next === "done" ? true : next === "error" ? false : null;
}

/** The Settings card's switches (keys = desktop prefs::NotifyPrefs fields; a test keeps them in step). */
export const NOTIFY_SWITCHES: ReadonlyArray<{ key: keyof NotifyPrefs; label: string; hint: string }> = [
  { key: "approvals", label: "Approvals waiting", hint: "A tool in Chat, or a job from your phone, the web app or a schedule, waits for you." },
  { key: "tasks", label: "Long tasks finished", hint: "A Loop run, an Auto Task, a code graph generation or a Doc Gen document finished or failed." },
  { key: "sync", label: "Sync needs attention", hint: "Sync turned itself off (login or server identity problem) or removed a device." },
  { key: "updates", label: "Update available", hint: "A signed LLM-IDE update can be installed." },
  { key: "core", label: "Backend stopped", hint: "The local backend stopped unexpectedly." },
];

/** The tray-missing note for a `tray_status` answer, or null when the tray works. */
export function trayNote(raw: unknown): string | null {
  const r = raw && typeof raw === "object" ? raw as Record<string, unknown> : null;
  if (!r || r.available !== false) return null;
  return "The menu-bar / tray icon is not available on this desktop, so approvals and status show only in the window. On Linux, install libayatana-appindicator3-1; on GNOME, also enable the AppIndicator extension, then restart LLM-IDE.";
}
