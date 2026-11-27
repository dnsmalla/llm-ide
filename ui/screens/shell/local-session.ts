// Local and ssh-server modes: the signed-in account is remembered on this computer (the OS keychain, through the host;
// in ssh mode per server). Once the spawned local core is ready (or the ssh forward is connected), this binder restores
// the saved session, so a launch or a reconnect does not ask for the password again. Each refresh rotation is stored back under the signed-in user's email. Only an explicit sign-out
// forgets the saved login: a null token (expiry, 401) keeps it.
//
// The host decides whether the credentials may be used at all (only the core it spawned, or the server it verified
// through the forward, checked again at each use); the webview only asks and reacts. The password is never read here: the host returns the
// refresh token only.
import { canKeepLogin, host, isHostAvailable, type CoreStatus } from "./host";
import { core, coreStatusStore } from "./runtime";
import {
  clearSavedLoginRejected,
  setSavedLoginForgetFailed,
  setSavedLoginNote,
  setSavedLoginRejected,
} from "./saved-login-state";

export interface LocalSessionHost {
  localLoginSession(): Promise<string | null>;
  localLoginRelogin(): Promise<string | null>;
  localLoginStoreRefresh(email: string, refresh: string): Promise<void>;
  localLoginStatus(): Promise<{ saved: boolean; email: string | null }>;
  localLoginForget(): Promise<void>;
}

export interface LocalSessionCore {
  subscribeRefreshToken(listener: (token: string | null) => void): () => void;
  restoreSession(refreshToken: string): Promise<unknown>;
  getSnapshot(): { signedIn: boolean; user: { email: string } | null };
}

export interface LocalSessionOptions {
  /** True while the status says the core is trusted (`canKeepLogin`). Only then is a refused read worth one retry. */
  isTrustedCore?: () => boolean;
  /** Waits before the retry. Injected so the tests need no timers. */
  pause?: (ms: number) => Promise<void>;
}

/**
 * The host probes the core's `/health` once per use, with a short timeout. A core that is busy or has just started can
 * miss that probe, which reads as untrusted. One retry after this pause covers it.
 */
export const RESTORE_RETRY_MS = 1500;

function statusOf(e: unknown): number {
  return typeof (e as { status?: unknown })?.status === "number" ? (e as { status: number }).status : 0;
}

function codeOf(e: unknown): string {
  const code = (e as { code?: unknown })?.code;
  return typeof code === "string" ? code : "";
}

/**
 * Testable binder: no singleton access, so a fake host and core can drive every branch.
 * `onRejected(true)` means the saved password was refused; `onRejected(false)` means a session was restored.
 * An untrusted core (for example an adopted dev core) is not an error here: the binder just does not restore.
 */
export function createLocalSessionBinder(
  sessionCore: LocalSessionCore,
  sessionHost: LocalSessionHost,
  onRejected: (refused: boolean) => void = () => undefined,
  options: LocalSessionOptions = {},
): () => void {
  const isTrustedCore = options.isTrustedCore ?? (() => false);
  const pause = options.pause ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let stopped = false;
  const off = sessionCore.subscribeRefreshToken((refresh) => {
    // A null token is a sign-out or an expired session: the saved login stays. A rotated token is stored only under
    // the email of the user it belongs to; the host refuses a different account too.
    const email = sessionCore.getSnapshot().user?.email;
    if (stopped || !refresh || !email) return;
    void sessionHost.localLoginStoreRefresh(email, refresh).catch(() => undefined);
  });

  // Reads the stored token. A refused core gets one retry after a pause, but only while the status says the core is trusted.
  const readToken = async (): Promise<string | null> => {
    try {
      return await sessionHost.localLoginSession();
    } catch (e) {
      if (codeOf(e) !== "untrusted_core" || !isTrustedCore()) throw e;
      await pause(RESTORE_RETRY_MS);
      return await sessionHost.localLoginSession();
    }
  };

  void (async () => {
    // Already signed in (for example the login panel completed first): nothing to restore.
    if (sessionCore.getSnapshot().signedIn) return;
    let token: string | null = null;
    try { token = await readToken(); } catch { return; }
    if (stopped) return;
    if (token) {
      try {
        await sessionCore.restoreSession(token);
        onRejected(false);
        return;
      } catch (e) {
        // A network failure keeps the stored token for the next launch; only a refused token needs a new sign-in.
        const refused = statusOf(e) === 401 || statusOf(e) === 403;
        if (!refused) return;
      }
    } else {
      // No token yet (the first launch after saving): sign in with the saved password, if there is one.
      let saved = false;
      try { saved = (await sessionHost.localLoginStatus()).saved; } catch { return; }
      if (!saved || stopped) return;
    }
    let fresh: string | null = null;
    try {
      fresh = await sessionHost.localLoginRelogin();
    } catch (e) {
      // An untrusted core (adopted, or not verified right now) simply gets no automatic sign-in: no error is shown.
      if (!stopped && codeOf(e) === "login_rejected") onRejected(true);
      return;
    }
    if (!fresh || stopped) return;
    try {
      await sessionCore.restoreSession(fresh);
      onRejected(false);
    } catch {
      // Stays on the login panel; the stored password is kept so the user can sign in to update it.
    }
  })();

  return () => { stopped = true; off(); };
}

/** Called by the shell once the spawned local core is ready, or the ssh forward is connected (never in hub mode). */
export function bindLocalSession(): () => void {
  if (!isHostAvailable()) return () => {};
  return createLocalSessionBinder(
    core as unknown as LocalSessionCore,
    host as unknown as LocalSessionHost,
    (refused) => setSavedLoginRejected(refused),
    {
      isTrustedCore: () => canKeepLogin(coreStatusStore.getSnapshot().status),
    },
  );
}

/**
 * Explicit sign-out in local or ssh mode also forgets the saved login (so the next launch or connect asks for the
 * password; in ssh mode it is the login kept for the connected server). Never in hub mode: a hub sign-out must not
 * touch it. Not tied to `canKeepLogin`: a forget must work even while the forward is reconnecting.
 */
export async function forgetSavedLoginFor(
  status: CoreStatus | null,
  sessionHost: Pick<LocalSessionHost, "localLoginForget">,
): Promise<void> {
  if (status?.mode !== "local" && status?.mode !== "ssh") return;
  await sessionHost.localLoginForget();
}

export async function forgetSavedLocalLogin(): Promise<void> {
  if (!isHostAvailable()) return;
  await forgetSavedLoginFor(coreStatusStore.getSnapshot().status, host as unknown as LocalSessionHost);
}

/**
 * Explicit sign-out from the shell (account menu, disconnect-all). The core session ends first. If the keychain
 * refuses the forget, the sign-out still completes, and the failure is kept in `savedLoginForgetFailed` so the
 * Settings "Saved login" row shows it; the user can then forget the login there.
 */
export async function signOutExplicitly(): Promise<void> {
  await core.logout();
  clearSavedLoginRejected();
  setSavedLoginNote(null);
  try {
    await forgetSavedLocalLogin();
    setSavedLoginForgetFailed(false);
  } catch {
    setSavedLoginForgetFailed(true);
  }
}
