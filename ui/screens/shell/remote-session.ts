// R-034 #10: persist the hub session across app launches. The desktop core's refresh token lives in
// the OS keychain, bound to the saved hub URL + TLS pin (remote_session.rs). On mount in remote mode
// this binder loads it, exchanges it at /auth/refresh, and stores the rotated token after every
// refresh. A sign-out or a 401 clears it; a network failure keeps it for the next launch.
import { host, isHostAvailable, type CoreStatus } from "./host";
import { core } from "./runtime";

/**
 * True once a remote core can take the session exchange. It reads the RAW `core_status` state: the derived
 * StatusView has no `state`, and waiting for remote/ready avoids a first attempt against a null base URL.
 */
export function isRemoteSessionReady(status: Pick<CoreStatus, "mode" | "state"> | null | undefined): boolean {
  return status?.mode === "remote" && (status.state === "remote" || status.state === "ready");
}

export interface RemoteSessionHost {
  remoteServerTarget(): Promise<{ hubUrl: string; pin: string } | null>;
  remoteSessionLoad(hubUrl: string, pin: string): Promise<string | null>;
  remoteSessionStore(hubUrl: string, pin: string, refresh: string): Promise<void>;
  remoteSessionClear(): Promise<void>;
}

export interface RemoteSessionCore {
  subscribeRefreshToken(listener: (token: string | null) => void): () => void;
  restoreSession(refreshToken: string): Promise<unknown>;
}

/** Testable binder: no singleton access, so a fake host/core can drive every branch. */
export function createRemoteSessionBinder(sessionCore: RemoteSessionCore, sessionHost: RemoteSessionHost): () => void {
  let stopped = false;
  let target: { hubUrl: string; pin: string } | null = null;
  let targetPromise: Promise<{ hubUrl: string; pin: string } | null> | null = null;
  const loadTarget = () => {
    targetPromise ??= sessionHost.remoteServerTarget().then((t) => { target = t; return t; }).catch(() => null);
    return targetPromise;
  };
  const persist = async (refresh: string | null) => {
    const t = target ?? await loadTarget();
    if (!t || stopped) return;
    if (refresh) await sessionHost.remoteSessionStore(t.hubUrl, t.pin, refresh);
    else await sessionHost.remoteSessionClear();
  };

  const off = sessionCore.subscribeRefreshToken((refresh) => {
    if (!stopped) void persist(refresh).catch(() => undefined);
  });

  void (async () => {
    const t = await loadTarget();
    if (!t || stopped) return;
    let stored: string | null = null;
    try { stored = await sessionHost.remoteSessionLoad(t.hubUrl, t.pin); } catch { return; }
    if (!stored || stopped) return;
    try {
      await sessionCore.restoreSession(stored);
    } catch (e) {
      // A rejected token is gone for good; a network failure keeps it for the next launch.
      const status = typeof (e as { status?: unknown })?.status === "number" ? (e as { status: number }).status : 0;
      if (status === 401 || status === 403) await sessionHost.remoteSessionClear().catch(() => undefined);
    }
  })();

  return () => { stopped = true; off(); };
}

/** Called by the shell only while remote mode is active. */
export function bindRemoteSession(): () => void {
  if (!isHostAvailable()) return () => {};
  return createRemoteSessionBinder(core as unknown as RemoteSessionCore, host as unknown as RemoteSessionHost);
}
