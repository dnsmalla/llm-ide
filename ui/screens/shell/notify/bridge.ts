// Wires the shell's stores to the host's notifications and tray: approval counts -> `tray_report` and the
// `approval_chat` notification, new sync activity rows -> `sync_attention`, the host's `tray-action` events ->
// navigation, Live capture and the sync switch. No timer of its own: it rides the inbox and activity polls.
import type { ShellEvent } from "../bus";
import { notifyUser, syncAlerts, syncReport, trayAction, type Invoke, type SyncReport } from "./notify";

export interface Store<S> { getSnapshot(): S; subscribe(l: () => void): () => void }
type SyncStatus = { configured: boolean; enabled: boolean } | null;

export interface BridgeDeps {
  invoke: Invoke;
  /** Subscribe to a host event; resolves to the unsubscribe function. */
  listen(event: string, cb: (payload: unknown) => void): Promise<() => void>;
  chatApprovals: Store<number>;
  inbox: Store<{ items: readonly unknown[] }>;
  activity: Store<{ loaded: boolean; feed: { lastId: number; items: readonly { id: number; kind: string | null }[] } }>;
  session: Store<{ signedIn: boolean }>;
  /** GET /kb/sync/status, decoded (throws when unavailable). */
  syncStatus(): Promise<SyncStatus>;
  setSyncEnabled(on: boolean): Promise<SyncStatus>;
  publish(ev: ShellEvent): void;
  openInbox(): void;
}

export function installNotifyBridge(d: BridgeDeps): () => void {
  let chat = d.chatApprovals.getSnapshot();
  let sync: SyncReport = "unknown";
  let sent = "";
  const a0 = d.activity.getSnapshot();
  let since: number | null = a0.loaded ? a0.feed.lastId : null;
  let signedIn = d.session.getSnapshot().signedIn;
  let gone = false;
  let offListen: (() => void) | null = null;

  const report = () => {
    const args = { chatApprovals: d.chatApprovals.getSnapshot(), jobApprovals: d.inbox.getSnapshot().items.length, sync };
    const key = JSON.stringify(args);
    if (key === sent) return;
    sent = key;
    d.invoke("tray_report", args).catch(() => { sent = ""; });
  };
  const readSync = async (p: Promise<SyncStatus>) => {
    try { sync = syncReport(await p); } catch { sync = "unknown"; }
    if (!gone) report();
  };

  const offChat = d.chatApprovals.subscribe(() => {
    const next = d.chatApprovals.getSnapshot();
    if (next > chat) void notifyUser("approval_chat", { count: next }, d.invoke);
    chat = next;
    report();
  });
  const offInbox = d.inbox.subscribe(report);
  const offActivity = d.activity.subscribe(() => {
    const s = d.activity.getSnapshot();
    if (!s.loaded) return;
    if (since === null) { since = s.feed.lastId; return; } // rows that existed before this launch never notify
    const a = syncAlerts(s.feed.items, since);
    since = a.lastId;
    if (a.ids.length) {
      void notifyUser("sync_attention", { key: `activity:${a.ids[a.ids.length - 1]}` }, d.invoke);
      void readSync(d.syncStatus());
    }
  });
  const offSession = d.session.subscribe(() => {
    const now = d.session.getSnapshot().signedIn;
    if (now === signedIn) return;
    signedIn = now;
    if (now) void readSync(d.syncStatus());
    else { sync = "unknown"; report(); }
  });

  d.listen("tray-action", (payload) => {
    const a = trayAction(payload);
    if (!a) return;
    if (a.type === "capture") { d.publish({ type: "goto-section", section: "live" }); d.publish({ type: "live-capture" }); }
    else if (a.type === "sync") { if (sync !== "unknown") void readSync(d.setSyncEnabled(sync !== "on")); }
    else if (a.type === "inbox") d.openInbox();
    else d.publish(a.anchor === undefined ? { type: "goto-section", section: a.section } : { type: "goto-section", section: a.section, anchor: a.anchor });
  }).then((un) => { if (gone) un(); else offListen = un; }, () => undefined);

  if (signedIn) void readSync(d.syncStatus());
  report();
  return () => { gone = true; offChat(); offInbox(); offActivity(); offSession(); offListen?.(); };
}
