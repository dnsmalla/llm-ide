// The App's session lifecycle without React: auto-connect, pairing, adopting a session, and tearing it down when the
// host revokes this browser. App.tsx renders it; tests drive it with a fake socket.
import { HostApiError, HostConnection, MISMATCH_NOTICE, type ConnectionState, type HostConnectionOptions, type TokenStore } from "./host-api/connection.ts";
import { browserPushEnv } from "./push/controller.ts";
import { checkHostUrl } from "./host-api/url.ts";
import { lastHostUrl, projectStoreFor, tokenStoreFor } from "./host-api/storage.ts";
import { createChatController, type ChatController } from "./chat/controller.ts";
import { createComposeController, type ComposeController } from "./chat/compose.ts";
import { createProjectsController, type ProjectsController } from "./projects/controller.ts";

import { createReadController, type ReadController } from "./read/controller.ts";

export interface Session {
  url: string; tokens: TokenStore; connection: HostConnection; projects: ProjectsController;
  controller: ChatController; read: ReadController; compose: ComposeController;
}
export interface AppState { session: Session | null; busy: boolean; error: string | null; notice: string | null }

export const REVOKED = "The desktop removed or expired this browser's access. Pair again with a new PIN from the desktop app's Settings.";
export const WRONG_PIN = "Wrong or expired PIN. Show a new one in the desktop app's Settings.";
export const FORGET_CONFIRM = "Forget this host? This browser will need a new PIN to connect again.";
export const REVOKE_IN_DESKTOP = "Revoke this browser in the desktop app's Settings as well.";
export const throttled = (ms: number | null) =>
  ms ? `Too many attempts — wait ${Math.ceil(ms / 1000)} s and try again.` : "Too many attempts — wait a moment and try again.";

// A short blip must not unmount Chat (its draft) or start sync storage traffic. With the default backoff the 5th
// attempt starts about 15 s after the socket was lost; "failed" counts at once.
export const SYNC_AFTER_ATTEMPTS = 5;
// Before the session was ever live on this page (desktop off at load) there is no chat to keep: unreachable at once.
// Each retry passes through "connecting"; `lastReconnect` (the preceding reconnecting state, null once ready) keeps the
// verdict stable across that phase so the screen and sync pause/resume do not flip on every retry.
export const hostUnreachable = (c: ConnectionState | null, wasLive: boolean, lastReconnect: ConnectionState | null = null): boolean => {
  const eff = c?.kind === "connecting" && lastReconnect?.kind === "reconnecting" ? lastReconnect : c;
  return eff?.kind === "failed" || (eff?.kind === "reconnecting" && (!wasLive || eff.attempt >= SYNC_AFTER_ATTEMPTS));
};

/** Which screen the App shows. `view` is the user's choice: "sync" (Open offline copy), "host" (Connect desktop). */
export type AppView = "auto" | "host" | "sync";
export function chooseScreen(o: { hub: boolean; syncPhase: string; session: boolean; down: boolean; view: AppView }): "sync" | "chat" | "pairing" {
  if (!o.hub && o.syncPhase === "pairing") return "sync";
  const linked = !o.hub && o.syncPhase !== "none";
  // Offline copy on its own only for a paired desktop that is unreachable; with no desktop paired, Pairing stays reachable.
  if (linked && (o.view === "sync" || (o.view === "auto" && o.session && o.down))) return "sync";
  return o.session ? "chat" : "pairing";
}

/** Sync storage traffic runs only when it is shown or the desktop is really unreachable, never during a blip. */
export const syncShouldRun = (o: { hub: boolean; session: boolean; busy: boolean; down: boolean; view: AppView }): boolean =>
  !o.hub && (o.view === "sync" || (!o.session && !o.busy) || (o.session && o.down));

/** Applied on every change; disposing is left to unmount, since a disposed controller never starts again. start() runs
 *  once (it loads the linked device, so the App knows sync is linked) and is a no-op after; a hub never needs it. */
export function driveSync(sync: { start(): Promise<void>; pause(): void; resume(): void }, o: { hub: boolean; run: boolean }): void {
  if (o.run) sync.resume(); else sync.pause();
  if (!o.hub) void sync.start();
}

const dropBrowserPush = async () => { await (await browserPushEnv().subscription())?.unsubscribe(); };

export interface AppDeps {
  tokensFor: (url: string, from?: string | null) => TokenStore;
  remember: (url: string) => void;
  confirm: (message: string) => boolean;
  connection: Partial<HostConnectionOptions>; // test seam: createSocket, timers
  dropPush: () => Promise<void>; // this browser's push subscription, unsubscribed on forget
}

const errorText = (e: unknown) =>
  e instanceof HostApiError && e.code === "auth_failed" ? (e.retryable ? throttled(e.retryAfterMs) : WRONG_PIN)
  : e instanceof Error ? e.message : "Could not connect."; // host_unreachable carries ORIGIN_HINT only when the socket never opened

export function createAppModel(initialUrl: string, deps: Partial<AppDeps> = {}) {
  const d: AppDeps = {
    tokensFor: (url, from) => tokenStoreFor(url, undefined, from), remember: (url) => lastHostUrl().set(url), confirm: (m) => globalThis.confirm?.(m) ?? true, connection: {},
    dropPush: dropBrowserPush, ...deps,
  };
  let state: AppState = { session: null, busy: false, error: null, notice: null };
  let live: Session | null = null;
  let offState: (() => void) | null = null;
  let disposed = false;
  const subs = new Set<() => void>();
  const set = (p: Partial<AppState>) => { state = { ...state, ...p }; for (const fn of subs) fn(); };

  const open = (url: string, from: string | null = null): Session => {
    const tokens = d.tokensFor(url, from);
    const connection = new HostConnection({ url, clientName: "LLM-IDE Web", clientVersion: __APP_VERSION__, tokens, ...d.connection });
    let controller: ChatController | null = null;
    let compose: ComposeController | null = null;
    let read: ReadController | null = null;
    const projects = createProjectsController(connection, {
      storage: projectStoreFor(url),
      // A project switch rewires every scoped view: the chat, the compose options and the read-only
      // history (which clears the previous project's list before loading the new one).
      onSelectionChange: () => { void controller?.resync(); void compose?.load(); void read?.projectChanged(); },
    });
    const onProjectRefused = (e: unknown) => { projects.noteRefusal(e); };
    controller = createChatController(connection, {
      projectId: () => projects.getSelectedId(),
      scopeReady: () => projects.whenLoaded(),
      onProjectRefused,
    });
    compose = createComposeController(connection, { projectId: () => projects.getSelectedId(), onProjectRefused });
    read = createReadController(connection, { projectId: () => projects.getSelectedId() });
    return { url, tokens, connection, projects, controller, read, compose };
  };
  const shut = (s: Session) => { s.projects.dispose(); s.controller.dispose(); s.read.dispose(); s.compose.dispose(); s.connection.close(); };
  const adopt = (s: Session | null, notice: string | null = null) => {
    offState?.(); offState = null;
    if (live && live !== s) shut(live);
    live = s;
    // A token revoked or expired mid-session: the connection deleted it and now waits for a PIN only Pairing can take.
    if (s) offState = s.connection.onState((c) => { if (c.kind === "needsPin") adopt(null, c.mismatch ? MISMATCH_NOTICE : REVOKED); });
    set({ session: s, notice });
  };

  let initial = initialUrl;
  const attempt = async (url: string, pin?: string, from: string | null = null) => {
    const s = open(url, from);
    live = s; // so dispose closes it mid-connect
    set({ busy: true, error: null });
    try {
      const r = await s.connection.connect(pin);
      if (disposed) return;
      if (r === "ready") { d.remember(url); adopt(s); }
      else { const mismatch = s.connection.mismatch; shut(s); live = null; set({ notice: mismatch ? MISMATCH_NOTICE : REVOKED }); }
    } catch (e) {
      if (disposed) return;
      // Paired but the desktop is down: keep the connection's backoff retry; Chat shows Reconnecting and resyncs on ready.
      if (e instanceof HostApiError && e.code === "host_unreachable" && s.tokens.get()) return adopt(s);
      shut(s); live = null;
      set({ error: errorText(e) });
    } finally { if (!disposed) set({ busy: false }); }
  };

  return {
    get initialUrl() { return initial; },
    getState: () => state,
    subscribe: (fn: () => void) => { subs.add(fn); return () => { subs.delete(fn); }; },
    attempt,
    start() { if (d.tokensFor(initialUrl).get()) void attempt(initialUrl); },
    /** Reconnect the paired desktop at a new address. The stored token is reused only when the host there has the same
     *  certificate fingerprint; the record and the remembered address move on success. Returns an error text, or null. */
    async changeAddress(raw: string): Promise<string | null> {
      const old = live;
      const checked = checkHostUrl(raw);
      if (!old) return "Not connected to a desktop.";
      if (!checked.ok) return checked.reason;
      if (checked.url === old.url) return null;
      const next = open(checked.url, old.url);
      try {
        const r = await next.connection.connect();
        if (disposed) { shut(next); return null; }
        if (r === "ready") { d.remember(checked.url); adopt(next); return null; }
        // Another desktop (or a refused token): the PIN path. The old record stays until the user re-pairs or forgets.
        const mismatch = next.connection.mismatch;
        shut(next); d.remember(checked.url); initial = checked.url;
        adopt(null, mismatch ? MISMATCH_NOTICE : REVOKED);
        return null;
      } catch (e) {
        shut(next);
        return errorText(e);
      }
    },
    forget() {
      const s = live;
      if (!s || !d.confirm(FORGET_CONFIRM)) return;
      offState?.(); offState = null; // forget() closes the connection itself; not a revocation
      // Best effort and never awaited: a forgotten host must not keep pushing to this browser.
      if (s.connection.capabilities.has("push")) void s.connection.send("push.unregister", {}).done.catch(() => {});
      void d.dropPush().catch(() => {});
      void s.connection.forget().then((revoked) => { if (!disposed) adopt(null, revoked ? null : REVOKE_IN_DESKTOP); });
    },
    dispose() { disposed = true; offState?.(); offState = null; if (live) shut(live); live = null; subs.clear(); },
  };
}

export type AppModel = ReturnType<typeof createAppModel>;
