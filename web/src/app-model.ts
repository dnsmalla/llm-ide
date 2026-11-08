// The App's session lifecycle without React: auto-connect, pairing, adopting a session, and tearing it down when the
// host revokes this browser. App.tsx renders it; tests drive it with a fake socket.
import { HostApiError, HostConnection, type HostConnectionOptions, type TokenStore } from "./host-api/connection.ts";
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

export interface AppDeps {
  tokensFor: (url: string) => TokenStore;
  remember: (url: string) => void;
  confirm: (message: string) => boolean;
  connection: Partial<HostConnectionOptions>; // test seam: createSocket, timers
}

const errorText = (e: unknown) =>
  e instanceof HostApiError && e.code === "auth_failed" ? (e.retryable ? throttled(e.retryAfterMs) : WRONG_PIN)
  : e instanceof Error ? e.message : "Could not connect."; // host_unreachable carries ORIGIN_HINT only when the socket never opened

export function createAppModel(initialUrl: string, deps: Partial<AppDeps> = {}) {
  const d: AppDeps = {
    tokensFor: tokenStoreFor, remember: (url) => lastHostUrl().set(url), confirm: (m) => globalThis.confirm?.(m) ?? true, connection: {}, ...deps,
  };
  let state: AppState = { session: null, busy: false, error: null, notice: null };
  let live: Session | null = null;
  let offState: (() => void) | null = null;
  let disposed = false;
  const subs = new Set<() => void>();
  const set = (p: Partial<AppState>) => { state = { ...state, ...p }; for (const fn of subs) fn(); };

  const open = (url: string): Session => {
    const tokens = d.tokensFor(url);
    const connection = new HostConnection({ url, clientName: "LLM-IDE Web", clientVersion: __APP_VERSION__, tokens, ...d.connection });
    let controller: ChatController | null = null;
    let compose: ComposeController | null = null;
    const projects = createProjectsController(connection, {
      storage: projectStoreFor(url),
      onSelectionChange: () => { void controller?.resync(); void compose?.load(); },
    });
    const onProjectRefused = (e: unknown) => { projects.noteRefusal(e); };
    controller = createChatController(connection, { projectId: () => projects.getSelectedId(), onProjectRefused });
    compose = createComposeController(connection, { projectId: () => projects.getSelectedId(), onProjectRefused });
    return { url, tokens, connection, projects, controller, read: createReadController(connection), compose };
  };
  const shut = (s: Session) => { s.projects.dispose(); s.controller.dispose(); s.read.dispose(); s.compose.dispose(); s.connection.close(); };
  const adopt = (s: Session | null, notice: string | null = null) => {
    offState?.(); offState = null;
    if (live && live !== s) shut(live);
    live = s;
    // A token revoked or expired mid-session: the connection deleted it and now waits for a PIN only Pairing can take.
    if (s) offState = s.connection.onState((c) => { if (c.kind === "needsPin") adopt(null, REVOKED); });
    set({ session: s, notice });
  };

  const attempt = async (url: string, pin?: string) => {
    const s = open(url);
    live = s; // so dispose closes it mid-connect
    set({ busy: true, error: null });
    try {
      const r = await s.connection.connect(pin);
      if (disposed) return;
      if (r === "ready") { d.remember(url); adopt(s); }
      else { shut(s); live = null; set({ notice: REVOKED }); }
    } catch (e) {
      if (disposed) return;
      // Paired but the desktop is down: keep the connection's backoff retry; Chat shows Reconnecting and resyncs on ready.
      if (e instanceof HostApiError && e.code === "host_unreachable" && s.tokens.get()) return adopt(s);
      shut(s); live = null;
      set({ error: errorText(e) });
    } finally { if (!disposed) set({ busy: false }); }
  };

  return {
    initialUrl,
    getState: () => state,
    subscribe: (fn: () => void) => { subs.add(fn); return () => { subs.delete(fn); }; },
    attempt,
    start() { if (d.tokensFor(initialUrl).get()) void attempt(initialUrl); },
    forget() {
      const s = live;
      if (!s || !d.confirm(FORGET_CONFIRM)) return;
      offState?.(); offState = null; // forget() closes the connection itself; not a revocation
      void s.connection.forget().then((revoked) => { if (!disposed) adopt(null, revoked ? null : REVOKE_IN_DESKTOP); });
    },
    dispose() { disposed = true; offState?.(); offState = null; if (live) shut(live); live = null; subs.clear(); },
  };
}

export type AppModel = ReturnType<typeof createAppModel>;
