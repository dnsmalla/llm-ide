// Binds the signed-in session to the desktop host's chat store (host commands `chat_bind_session` /
// `chat_unbind_session`, desktop/src-tauri/src/chat_cmds.rs). The host verifies the token with the core and derives
// the user id itself; the token stays in host memory (the quit-time archive and the start-up sweep need it).
//
// Wiring: after sign-in -> bind with the access token; every refresh -> rebind (the host's copy would otherwise
// expire); sign-out or a dropped session -> unbind. The webview never names a user or a path.
import type { CoreClient } from "./core";

export type BindState = "unbound" | "binding" | "bound" | "failed";

export interface BindSnapshot {
  state: BindState;
  /** Stable error code from the host when `failed`. */
  error: string | null;
}

export interface ChatBinding {
  getSnapshot(): BindSnapshot;
  subscribe(listener: () => void): () => void;
  /** Resolves once a bind succeeded; rejects with the host's code when the latest attempt failed or on timeout. */
  whenBound(timeoutMs?: number): Promise<void>;
  /** Stops listening (tests). */
  dispose(): void;
}

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

function codeOf(e: unknown): string {
  if (e && typeof e === "object" && typeof (e as { code?: unknown }).code === "string") return (e as { code: string }).code;
  return "bind_failed";
}

/** `enabled` is read at each token event: the host bridge is installed after this module loads. */
export function createChatBinding(client: Pick<CoreClient, "subscribeAccessToken">, invoke: Invoke, enabled: () => boolean = () => true): ChatBinding {
  let snap: BindSnapshot = { state: "unbound", error: null };
  const listeners = new Set<() => void>();
  const waiters = new Set<{ ok: () => void; fail: (c: string) => void }>();
  let generation = 0;
  // Binds are serialised: a refresh arriving mid-bind waits, and only the newest token is sent.
  let chain: Promise<void> = Promise.resolve();

  const set = (next: BindSnapshot) => {
    if (next.state === snap.state && next.error === snap.error) return;
    snap = next;
    for (const l of [...listeners]) l();
    if (next.state === "bound") for (const w of [...waiters]) w.ok();
    if (next.state === "failed") for (const w of [...waiters]) w.fail(next.error ?? "bind_failed");
  };

  const onToken = (token: string | null) => {
    if (!enabled()) return;
    const gen = ++generation;
    chain = chain.then(async () => {
      if (gen !== generation) return; // superseded by a newer token or a sign-out
      if (token === null) {
        set({ state: "unbound", error: null });
        try {
          await invoke("chat_unbind_session");
        } catch {
          // nothing to do: the host drops the token on its own at exit
        }
        return;
      }
      if (snap.state !== "bound") set({ state: "binding", error: null });
      try {
        await invoke("chat_bind_session", { token });
        if (gen === generation) set({ state: "bound", error: null });
      } catch (e) {
        if (gen === generation) set({ state: snap.state === "bound" ? "bound" : "failed", error: codeOf(e) });
      }
    });
  };

  const off = client.subscribeAccessToken(onToken);

  return {
    getSnapshot: () => snap,
    subscribe(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    whenBound(timeoutMs = 10_000) {
      if (snap.state === "bound") return Promise.resolve();
      if (snap.state === "failed") return Promise.reject(new Error(snap.error ?? "bind_failed"));
      return new Promise<void>((resolve, reject) => {
        const w = {
          ok: () => done(resolve),
          fail: (c: string) => done(() => reject(new Error(c))),
        };
        const t = setTimeout(() => w.fail(snap.state === "unbound" ? "not_bound" : "bind_timeout"), timeoutMs);
        const done = (fn: () => void) => {
          clearTimeout(t);
          waiters.delete(w);
          fn();
        };
        waiters.add(w);
      });
    },
    dispose() {
      off();
      listeners.clear();
      waiters.clear();
    },
  };
}
