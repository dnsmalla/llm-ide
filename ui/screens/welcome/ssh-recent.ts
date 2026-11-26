// Welcome → Connect to SSH server: the rules behind the recent list and the connect dialog, with no rendering. The
// views (RecentSshServers, SshConnectDialog) and the container (SshWelcome) only show what these return.
import type { SshRecentRef, SshRecentServer, SshServerIo, SshServerModel, SshServerState } from "../settings/ssh-server-model.ts";

/**
 * What a Connect from the list led to. `connected`: the link is up, nothing more to show. `switch`: the connection
 * works, the app must restart to use it. `dialog`: the host key or the password needs the user, so the dialog opens.
 * `failed`: the row shows the reason.
 */
export type RecentOutcome = "connected" | "switch" | "dialog" | "failed";

/** The message a row shows under itself: progress while its action runs, or the reason it failed. */
export interface RowMessage { key: string; tone: "busy" | "error"; text: string }

/** One row per saved login. It is also the key the list uses to find the row an action belongs to. */
export function recentKey(entry: SshRecentRef): string {
  return `${entry.user}@${entry.host}:${entry.port}`;
}

/** The Forget question. It names the login and says the saved host key goes too, so the user knows what is lost. */
export function forgetQuestion(entry: SshRecentRef): string {
  return `Forget ${entry.user}@${entry.host}? Its saved host key is removed too.`;
}

/** The switch confirmation. The restart is named, and so is what it stops, because Loop and agent work are local. */
export function switchQuestion(host: string): string {
  return `The app restarts and works on ${host}. Running Loop or agent work on this computer stops.`;
}

/**
 * What the restart after Connect does. The restart ends Loop work running on this computer, so it asks only then;
 * with nothing running, Connect already was the user's answer. Without a signal the caller passes `true`, so it asks.
 */
export function switchDecision(hasLiveWork: boolean): "ask" | "switch" {
  return hasLiveWork ? "ask" : "switch";
}

/** The recent list is optional: an older desktop build has no such command, and then no list shows, not an error. */
export async function loadRecent(io: SshServerIo): Promise<SshRecentServer[]> {
  try {
    return await io.recent();
  } catch {
    return [];
  }
}

/**
 * Connect a remembered server without the dialog, in one click. The form is filled from the entry first. Only a
 * connected link or a restart need no user; a changed or unknown host key, a running server part to take over, a
 * password request, or a failure is shown to the user. A password server connects from the list only when its
 * password is in the Keychain (the host reads it; the list never has it). Otherwise the dialog asks for the password.
 */
export async function connectRecentServer(m: SshServerModel, entry: SshRecentServer): Promise<RecentOutcome> {
  m.loadFrom(entry);
  if (entry.auth === "password" && !entry.passwordSaved) return "dialog";
  const status = await m.connectWithTest();
  if (status?.link === "connected") return "connected";
  if (status?.link === "restart_required") return "switch";
  if (status?.link === "needs_password") return "dialog";
  // A server part another session left running needs the user's Take over click, which the dialog shows.
  if (m.getState().foreign === "connect") return "dialog";
  // An untrusted host key opens the dialog, which shows the fingerprint to confirm. A test that could not run at all
  // (unreachable host, bad key path, timeout) leaves no test behind: that error stays in the row, not in the dialog.
  const test = m.getState().test;
  if (test !== null && test.trusted !== true) return "dialog";
  // A remembered password that no longer works (changed on the server): the dialog asks for the new one.
  if (entry.auth === "password" && m.getState().test === null && m.getState().error !== null) return "dialog";
  return "failed";
}

/** What Escape closes: the switch confirmation while it is open, otherwise the whole dialog. */
export function escapeTarget(confirming: boolean): "confirmation" | "dialog" {
  return confirming ? "confirmation" : "dialog";
}

/** The message for the row whose action is `active`. Other rows show nothing; the dialog shows its own errors. */
export function recentRowMessage(state: Pick<SshServerState, "busy" | "error" | "status">, active: string | null, key: string): RowMessage | null {
  if (active === null || active !== key) return null;
  if (state.busy !== null) return { key, tone: "busy", text: "Connecting…" };
  if (state.error !== null) return { key, tone: "error", text: state.error };
  if (state.status?.link === "failed") return { key, tone: "error", text: state.status.error ?? "The SSH connection could not be opened." };
  return null;
}
