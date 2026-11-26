// Settings → Server & Backend → SSH server: the pure part (validation, decoders, error text and a small observable
// model). The core runs on a Linux server and is reached through an ssh port forward; this model drives the host's
// `remote_ssh_server_*` commands. No visual component lives here.
//
// Rules:
// - the password is an argument of the action that needs it. It is passed to the host and never stored in this
//   observable state, in an error, or in a closure that outlives the call.
// - `connect` is refused until the last test shows the server's host key as trusted. Changing host or port drops the
//   test result, because it was about the old server.
// - the io is injected, so tests exercise every branch with no host and no ssh. `createSshServerIo` is the production
//   adapter over the host `invoke`.

import { decodePrefsView, type SshAuth } from "../shell/host-prefs.ts";
import type { SshServerLink, SshServerStatus, SshServerTarget, SshServerTest } from "./host.ts";
import { isValidHost, isValidKeyPath, isValidUser, parseSshPort } from "./remote-model.ts";
import { Store } from "./store.ts";
import { isRecord } from "../../kit/src/decode.ts";
import { hostErrorText, type HostErrorTable } from "../../kit/src/host-error.ts";
import { sshLinkPresentation, type SshLinkTone } from "../../kit/src/ssh-link.ts";
// Re-exported: the Welcome screen and tests import the link wording from here.
export { sshLinkPresentation, type SshLinkTone };

export type SshServerField = "host" | "port" | "user" | "keyPath";
export type SshServerFieldErrors = Partial<Record<SshServerField, string>>;
export type SshServerBusy = "test" | "confirm" | "connect" | "disconnect" | "status" | "stop" | "uninstall" | "install_key";

const isNullableString = (v: unknown): v is string | null => v === null || typeof v === "string";
const SSH_LINKS: readonly SshServerLink[] = ["off", "restart_required", "connecting", "connected", "reconnecting", "needs_password", "failed", "stopped"];
const GLIBC_VERSION = /^\d+\.\d+$/;
/** The stop, uninstall or connect the foreign-core prompt asks to repeat with `force` (or, for a connect, `takeOver`). */
export type SshForeignAction = "stop" | "uninstall" | "connect";
/** Shown for a server another computer started. The same sentence for stop and for uninstall. */
export const SSH_FOREIGN_TEXT = "Another computer started the server on this account. Stopping it ends that computer's work.";
/** Shown when Connect finds a server part that this desktop's session record does not own. The user must click Take over. */
export const SSH_TAKE_OVER_TEXT = "A server part from an earlier session is still running on this account (another computer, or this one before its app data was reset). Taking over stops it; any work running in it ends.";
/**
 * Shown for SSH_CORE_FOREIGN wherever no Take over button is offered (the app's startup, the live link, a failed start).
 * The prompt that does offer the button shows SSH_TAKE_OVER_TEXT instead.
 */
export const SSH_FOREIGN_NEXT_STEP_TEXT = "A server part from an earlier session is still running on this account. To replace it, open Welcome, choose Connect to SSH server and use Take over.";
const isForeignCore = (e: unknown): boolean => isRecord(e) && e.code === "SSH_CORE_FOREIGN";

/** Strict decode of `remote_ssh_server_test` / `_confirm`; any wrong type reads as null (the host answered something unknown). */
export function decodeSshServerTest(raw: unknown): SshServerTest | null {
  if (!isRecord(raw)) return null;
  const { hostKeyType, fingerprint, trusted, changed, os, arch, freeMb, installedVersion, claude, glibc } = raw;
  if (typeof hostKeyType !== "string" || hostKeyType.length === 0) return null;
  if (typeof fingerprint !== "string" || fingerprint.length === 0) return null;
  if (typeof trusted !== "boolean" || typeof changed !== "boolean") return null;
  if (!isNullableString(os) || !isNullableString(arch) || !isNullableString(installedVersion) || !isNullableString(claude)) return null;
  if (freeMb !== null && (typeof freeMb !== "number" || !Number.isFinite(freeMb))) return null;
  // glibc is optional: an older host build does not send it, and a wrong type must not fail the whole test answer.
  const glibcVersion = typeof glibc === "string" && GLIBC_VERSION.test(glibc) ? glibc : null;
  return { hostKeyType, fingerprint, trusted, changed, os, arch, freeMb, installedVersion, claude, glibc: glibcVersion };
}

/** Strict decode of a `remote_ssh_server_*` status. An unknown link reads as `failed`, like the core status does. */
export function decodeSshServerStatus(raw: unknown): SshServerStatus | null {
  if (!isRecord(raw)) return null;
  const { link, host, port, user, localUrl, version, claude, error } = raw;
  if (typeof link !== "string") return null;
  if (typeof host !== "string" || typeof user !== "string" || typeof localUrl !== "string") return null;
  if (typeof version !== "string" || typeof claude !== "string") return null;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (error !== null && typeof error !== "string") return null;
  const known = SSH_LINKS.includes(link as SshServerLink) ? (link as SshServerLink) : "failed";
  const warning = typeof raw.warning === "string" && raw.warning.length > 0 ? raw.warning.slice(0, 300) : null;
  return { link: known, host, port, user, localUrl, version, claude, error, bundleAvailable: raw.bundleAvailable !== false, ...(warning === null ? {} : { warning }) };
}

/** Shown beside the disabled SSH actions when the host reports no server bundle in this build. */
export const SSH_NO_BUNDLE_TEXT = "This build does not include the server files that SSH mode needs.";

/** The one rule for the SSH actions: off, with the reason in visible text, when the build has no bundle. */
export function sshBundleBlock(status: SshServerStatus | null): string | null {
  return status?.bundleAvailable === false ? SSH_NO_BUNDLE_TEXT : null;
}

const SSH_REQUEST_FAILED = "The SSH server request failed.";
/** The host's own sentence names the next step (or the command and folder), so it wins over a fixed text. */
const hostSentence = (fallback: string) => (message: string): string => (message.length > 0 ? message.slice(0, 300) : fallback);

const SSH_ERROR_TEXT: HostErrorTable = {
  SSH_AUTH_FAILED: "The server refused this login.",
  SSH_PASSWORD_REQUIRED: "Enter the password for this server.",
  SSH_UNREACHABLE: "Could not reach the server.",
  SSH_HOST_KEY_UNCONFIRMED: "Test the connection and confirm the server's host key first.",
  SSH_HOST_KEY_CHANGED: "The server's host key changed. Test the connection again and confirm the new fingerprint.",
  SSH_CORE_FOREIGN: SSH_FOREIGN_NEXT_STEP_TEXT,
  SSH_TIMEOUT: "The server did not answer in time.",
  SSH_START_BUSY: "The server is already starting. Try again in a moment.",
  SSH_FORWARD_FAILED: hostSentence(SSH_REQUEST_FAILED),
  SSH_GLIBC_TOO_OLD: hostSentence(SSH_REQUEST_FAILED),
  confirm_mismatch: hostSentence(SSH_REQUEST_FAILED),
  SSH_BUNDLE_MISSING: hostSentence("This build has no Linux server bundle."),
  // Key install: the sentences say what the user can do next.
  SSH_KEY_NOT_NEEDED: "This server already uses a key.",
  SSH_KEY_VERIFY_FAILED: "The server did not accept the new key. Your password login is unchanged.",
  SSH_KEYGEN_FAILED: "Could not create a key on this computer.",
  SSH_KEY_INSTALL_FAILED: "The key could not be added on the server.",
  SSH_KEY_INVALID: "The new key was not accepted.",
};

/** Fixed, clear sentences for the host's ssh server codes; any other code shows the host's own message. */
export function sshServerErrorText(e: unknown): string {
  if (typeof e === "string" && e.trim().length > 0) return e.trim().slice(0, 300);
  return hostErrorText(e, SSH_ERROR_TEXT, SSH_REQUEST_FAILED);
}

/** Shown when the switch from SSH to Local asks first. Same sentence as the hub's text, naming the SSH server. */
export const SSH_LOCAL_CONFIRM = "Switching to Local desktop stops using the SSH server and restarts the core on this computer.";

export const SSH_TEXT = {
  uninstallMismatch: "Type the server's host name to uninstall.",
  unconfirmed: "Test the connection and confirm the server's host key first.",
  checkFields: "Check the highlighted fields before continuing.",
  testFirst: "Test the connection first.",
} as const;

/** Field rules, mirroring `validateRemote` in remote-model.ts. The key path is required only for key login. */
export function validateSshServer(state: { host: string; port: string; user: string; keyPath: string; auth: SshAuth }): SshServerFieldErrors {
  const errors: SshServerFieldErrors = {};
  if (!isValidHost(state.host)) {
    errors.host = state.host.trim().length === 0
      ? "Enter the server's hostname or IP address."
      : "That host is not valid. Use a hostname or IP address without spaces, user@, or a leading '-'.";
  }
  if (parseSshPort(state.port) === null) errors.port = "Enter an SSH port between 1 and 65535 (the default is 22).";
  if (!isValidUser(state.user)) {
    errors.user = state.user.trim().length === 0
      ? "Enter the SSH user name."
      : "That user name is not valid. Use letters, digits, '.', '_' or '-', not a leading '-'.";
  }
  if (state.auth === "key" && !isValidKeyPath(state.keyPath)) {
    errors.keyPath = state.keyPath.trim().length === 0
      ? "Enter the path to your private key file."
      : "Use an absolute path to the private key (for example ~/.ssh/id_ed25519 is not enough: write the full path).";
  }
  return errors;
}

/** The saved SSH target as the host stores it. Never a password; the key path only, never key contents. */
export interface SshSavedSettings {
  host: string;
  port: number;
  user: string;
  keyPath: string;
  auth: SshAuth;
}

/** Host name typed for Uninstall: trimmed and case-insensitive, the same check the host makes. */
export function uninstallConfirmed(typed: string, host: string): boolean {
  const name = host.trim().toLowerCase();
  return name.length > 0 && typed.trim().toLowerCase() === name;
}

/**
 * The one line the toolbar and the card show for a live link; null when there is nothing to show for it. `folder` is the
 * open server folder's name: it follows the host, as in VS Code's remote indicator.
 */
export function sshBadgeText(link: string | null, host: string, folder?: string): string | null {
  const name = host.trim();
  if (name.length === 0) return null;
  const at = folder?.trim() ? ` · ${folder.trim()}` : "";
  if (link === "connected") return `SSH: ${name}${at}`;
  if (link === "reconnecting") return `Reconnecting to ${name}…${at}`;
  return null;
}

/** One server the Welcome screen remembers. Never a password; the key path only, never key contents. */
export interface SshRecentServer {
  host: string;
  port: number;
  user: string;
  keyPath: string;
  auth: SshAuth;
  /** Epoch milliseconds of the last successful connect. The list is already sorted, most recent first. */
  lastUsed: number;
  /** The password is in the Keychain (a flag only: the host reads it, the webview never gets it back). */
  passwordSaved: boolean;
}
/** The fields that identify one saved server (its login), which is what Forget removes. */
export type SshRecentRef = Pick<SshRecentServer, "host" | "port" | "user">;
/** The recent list shows at most this many servers; the host keeps no more than this for the list. */
export const SSH_RECENT_MAX = 10;

/**
 * Strict decode of `remote_ssh_server_recent`. One malformed entry makes the whole answer unreadable: a partly
 * readable list would show rows the host did not vouch for.
 */
export function decodeSshRecentList(raw: unknown): SshRecentServer[] | null {
  if (!Array.isArray(raw)) return null;
  const out: SshRecentServer[] = [];
  for (const item of raw) {
    if (!isRecord(item)) return null;
    const { host, port, user, keyPath, auth, lastUsed } = item;
    if (typeof host !== "string" || host.length === 0) return null;
    if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) return null;
    if (typeof user !== "string" || typeof keyPath !== "string") return null;
    if (auth !== "key" && auth !== "password") return null;
    if (typeof lastUsed !== "number" || !Number.isFinite(lastUsed)) return null;
    // An older host does not send the flag, and a wrong type must not make the whole list unreadable.
    out.push({ host, port, user, keyPath, auth, lastUsed, passwordSaved: auth === "password" && item.passwordSaved === true });
  }
  return out;
}

/**
 * What a test or connect says about the password and the running core, besides the typed password. These are flags
 * only: the host reads a stored password itself and the webview never receives it.
 */
export interface SshPasswordOptions {
  /** Sign in with the password stored in the Keychain (none typed). */
  useSaved?: boolean;
  /** The "Remember password in Keychain" checkbox: true stores the typed password, false removes the stored one. */
  remember?: boolean;
  /** Connect only: stop the server part another session left running, then continue. Set only by the Take over click. */
  takeOver?: boolean;
}

export interface SshServerIo {
  saved(): Promise<SshSavedSettings>;
  /** The saved servers, most recent first. Rejects when the host does not know the command (an older desktop build). */
  recent(): Promise<SshRecentServer[]>;
  /** Remove one saved server and its saved host-key pin. */
  forget(entry: SshRecentRef): Promise<void>;
  installKey(password: string): Promise<SshServerStatus>;
  test(target: SshServerTarget, password?: string, options?: SshPasswordOptions): Promise<SshServerTest>;
  confirm(target: SshServerTarget, hostKeyType: string, fingerprint: string): Promise<SshServerTest>;
  connect(target: SshServerTarget, password?: string, options?: SshPasswordOptions): Promise<SshServerStatus>;
  disconnect(): Promise<SshServerStatus>;
  status(): Promise<SshServerStatus>;
  /** The target is the form's current one: the host stops the server only when it is the saved one. */
  stop(target: SshServerTarget, password: string | undefined, force: boolean): Promise<SshServerStatus>;
  uninstall(password: string | undefined, confirmHost: string, force: boolean): Promise<SshServerStatus>;
}

export type SshInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

function decodeOrThrow<T>(raw: unknown, decode: (v: unknown) => T | null): T {
  const value = decode(raw);
  if (value === null) throw new Error("the desktop host returned an SSH server answer this app cannot read");
  return value;
}

/** The production io: the host commands with their camelCase arguments. The password is added only when given. */
export function createSshServerIo(invoke: SshInvoke): SshServerIo {
  const withPassword = (args: Record<string, unknown>, password: string | undefined) => (password === undefined ? args : { ...args, password });
  const withOptions = (args: Record<string, unknown>, options: SshPasswordOptions | undefined) => {
    if (options === undefined) return args;
    const out = { ...args };
    if (options.useSaved) out.useSavedPassword = true;
    if (options.remember !== undefined) out.rememberPassword = options.remember;
    if (options.takeOver) out.takeOver = true;
    return out;
  };
  return {
    async test(target, password, options) {
      return decodeOrThrow(await invoke<unknown>("remote_ssh_server_test", withOptions(withPassword({ target }, password), options)), decodeSshServerTest);
    },
    async confirm(target, hostKeyType, fingerprint) {
      return decodeOrThrow(await invoke<unknown>("remote_ssh_server_confirm", { target, hostKeyType, fingerprint }), decodeSshServerTest);
    },
    async connect(target, password, options) {
      return decodeOrThrow(await invoke<unknown>("remote_ssh_server_connect", withOptions(withPassword({ target }, password), options)), decodeSshServerStatus);
    },
    async disconnect() {
      return decodeOrThrow(await invoke<unknown>("remote_ssh_server_disconnect"), decodeSshServerStatus);
    },
    async status() {
      return decodeOrThrow(await invoke<unknown>("remote_ssh_server_status"), decodeSshServerStatus);
    },
    async stop(target, password, force) {
      return decodeOrThrow(await invoke<unknown>("remote_ssh_server_stop", withPassword({ target, force }, password)), decodeSshServerStatus);
    },
    async uninstall(password, confirmHost, force) {
      return decodeOrThrow(await invoke<unknown>("remote_ssh_server_uninstall", withPassword({ confirmHost, force }, password)), decodeSshServerStatus);
    },
    async saved() {
      const view = decodePrefsView(await invoke<unknown>("get_prefs"));
      if (!view) throw new Error("the desktop host returned preferences this app cannot read");
      const r = view.stored.remoteServer;
      return { host: r.host, port: r.port, user: r.user, keyPath: r.keyPath, auth: r.sshAuth };
    },
    async installKey(password) {
      return decodeOrThrow(await invoke<unknown>("remote_ssh_server_install_key", { password }), decodeSshServerStatus);
    },
    async recent() {
      return decodeOrThrow(await invoke<unknown>("remote_ssh_server_recent"), decodeSshRecentList).slice(0, SSH_RECENT_MAX);
    },
    async forget(entry) {
      await invoke<unknown>("remote_ssh_server_forget", { host: entry.host, port: entry.port, user: entry.user });
    },
  };
}

const rejectNoHost = async (): Promise<never> => {
  throw new Error("The SSH server needs the desktop host, which is not connected in this build.");
};
/** Stands in for the host when there is none (a plain browser or a test without a host), so a model always exists. */
export const UNAVAILABLE_SSH_IO: SshServerIo = {
  saved: rejectNoHost,
  recent: rejectNoHost,
  forget: rejectNoHost,
  installKey: rejectNoHost,
  test: rejectNoHost,
  confirm: rejectNoHost,
  connect: rejectNoHost,
  disconnect: rejectNoHost,
  status: rejectNoHost,
  stop: rejectNoHost,
  uninstall: rejectNoHost,
};

export interface SshServerState {
  host: string;
  /** Text, like the other settings forms; `target()` parses it. */
  port: string;
  user: string;
  keyPath: string;
  auth: SshAuth;
  fieldErrors: SshServerFieldErrors;
  /** The action in progress; one at a time. */
  busy: SshServerBusy | null;
  /** The last host-key test (or confirmation). Null after a failed test or a change of host or port. */
  test: SshServerTest | null;
  /** The last status the host reported. */
  status: SshServerStatus | null;
  error: string | null;
  /**
   * Set when a stop, uninstall or connect found a core another computer started: the action waits for an explicit
   * "anyway" (for a connect, the Take over click).
   */
  foreign: SshForeignAction | null;
  /** The "Remember password in Keychain" checkbox. Not a secret; the password itself is never in this state. */
  rememberPassword: boolean;
  /** The host says a password is stored in the Keychain for this login (from the recent list). */
  passwordSaved: boolean;
}

export const SSH_SERVER_INITIAL: SshServerState = {
  host: "",
  port: "22",
  user: "",
  keyPath: "",
  auth: "key",
  fieldErrors: {},
  busy: null,
  test: null,
  status: null,
  error: null,
  foreign: null,
  rememberPassword: false,
  passwordSaved: false,
};

export class SshServerModel extends Store<SshServerState> {
  readonly #io: SshServerIo;
  /** Bumped by every change of the target fields. A host answer that started under an older value is stale. */
  #generation = 0;
  constructor(io: SshServerIo) {
    super({ ...SSH_SERVER_INITIAL, fieldErrors: {} });
    this.#io = io;
  }

  setField(field: SshServerField, value: string): void {
    this.#generation += 1;
    const fieldErrors = { ...this.getState().fieldErrors };
    delete fieldErrors[field];
    const patch: Partial<SshServerState> = { fieldErrors, error: null, foreign: null };
    // The stored password belongs to one login (user@host:port): a different one has none.
    if (field !== "keyPath") patch.passwordSaved = false;
    if (field === "host") patch.host = value;
    else if (field === "port") patch.port = value;
    else if (field === "user") patch.user = value;
    else patch.keyPath = value;
    // The host key belongs to the server's address: a new host or port needs a new test.
    if (field === "host" || field === "port") patch.test = null;
    this.set(patch);
  }

  setAuth(auth: SshAuth): void {
    this.#generation += 1;
    const fieldErrors = { ...this.getState().fieldErrors };
    delete fieldErrors.keyPath;
    this.set({ auth, fieldErrors, error: null, foreign: null });
  }

  /**
   * Fill the form from a remembered server. The last test goes: its host key was about the server the form showed
   * before. No password is taken here; the dialog holds it for one call.
   */
  loadFrom(entry: SshRecentServer): void {
    this.#generation += 1;
    // A Keychain warning belongs to the connect that raised it, not to the server loaded next.
    const status = this.getState().status;
    const { warning: _dropped, ...withoutWarning } = status ?? ({} as SshServerStatus);
    this.set({
      status: status === null ? null : withoutWarning,
      host: entry.host, port: String(entry.port), user: entry.user, keyPath: entry.keyPath, auth: entry.auth,
      fieldErrors: {}, test: null, error: null, foreign: null,
      passwordSaved: entry.auth === "password" && entry.passwordSaved, rememberPassword: entry.auth === "password" && entry.passwordSaved,
    });
  }

  /**
   * The dialog was closed or cancelled: every answer still on its way is dropped (a scoped run returns null), so a late
   * `restart_required` cannot make the closed form switch the app. The host call itself cannot be recalled.
   */
  cancel(): void {
    this.#generation += 1;
  }

  /** The "Remember password in Keychain" checkbox. */
  setRemember(remember: boolean): void {
    this.set({ rememberPassword: remember });
  }

  /**
   * Empty the form for a new server. `busy` is kept on purpose: an action still running finishes on its own, and a
   * second one must not start beside it.
   */
  reset(): void {
    this.#generation += 1;
    this.set({ ...SSH_SERVER_INITIAL, fieldErrors: {}, busy: this.getState().busy });
  }

  /** The target the host receives: exactly the non-secret fields. */
  target(): SshServerTarget {
    const s = this.getState();
    return { host: s.host.trim(), port: parseSshPort(s.port) ?? 0, user: s.user.trim(), keyPath: s.keyPath.trim(), auth: s.auth };
  }

  validate(): boolean {
    const fieldErrors = validateSshServer(this.getState());
    this.set({ fieldErrors });
    return Object.keys(fieldErrors).length === 0;
  }

  /** Probe the server: fetches its host key (and, once trusted, its probe). The password is used for this call only. */
  async test(password?: string): Promise<void> {
    if (this.getState().busy) return;
    if (!this.validate()) {
      this.set({ test: null, error: SSH_TEXT.checkFields });
      return;
    }
    this.set({ busy: "test", error: null, test: null });
    const generation = this.#generation;
    try {
      const options = this.#passwordOptions(password);
      const test = await (options === undefined ? this.#io.test(this.target(), password) : this.#io.test(this.target(), password, options));
      if (generation !== this.#generation) return;
      // A Test never changes the Keychain (the host applies the checkbox only after a connect), so the flag stays.
      this.set({ test, error: null });
    } catch (e) {
      if (generation !== this.#generation) return;
      this.set({ test: null, error: sshServerErrorText(e) });
    } finally {
      this.set({ busy: null });
    }
  }

  /** Trust the host key of the last test (the host shows its own native confirmation). */
  async confirmFingerprint(): Promise<void> {
    const state = this.getState();
    if (state.busy) return;
    const last = state.test;
    if (!last) {
      this.set({ error: SSH_TEXT.testFirst });
      return;
    }
    this.set({ busy: "confirm", error: null });
    const generation = this.#generation;
    try {
      const test = await this.#io.confirm(this.target(), last.hostKeyType, last.fingerprint);
      if (generation !== this.#generation) return;
      // The host forgets the passwords saved for a server whose key was replaced: the next sign-in is typed.
      this.set(last.changed ? { test, error: null, passwordSaved: false } : { test, error: null });
    } catch (e) {
      if (generation !== this.#generation) return;
      this.set({ error: sshServerErrorText(e) });
    } finally {
      this.set({ busy: null });
    }
  }

  /** Fill the form from the saved settings and read the live link. Called once when the card mounts. */
  async load(): Promise<void> {
    const generation = this.#generation;
    try {
      const saved = await this.#io.saved();
      if (generation === this.#generation && saved.host.length > 0) {
        this.set({ host: saved.host, port: String(saved.port), user: saved.user, keyPath: saved.keyPath, auth: saved.auth, test: null });
        await this.#loadPasswordFlag(generation);
      }
    } catch {
      // Nothing saved, or the host could not read it: the form starts empty and the user enters the server again.
    }
    await this.refreshStatus();
  }

  /** Whether the saved server has a password in the Keychain, read from the recent list (never from the Keychain). */
  async #loadPasswordFlag(generation: number): Promise<void> {
    try {
      const s = this.getState();
      const entry = (await this.#io.recent()).find((e) => e.host === s.host && e.port === Number(s.port) && e.user === s.user);
      if (generation === this.#generation && entry !== undefined) {
        this.set({ passwordSaved: entry.passwordSaved, rememberPassword: entry.passwordSaved });
      }
    } catch {
      // An older host has no recent list: no password is remembered.
    }
  }

  /** What the host needs to know about the password for this call; undefined when there is nothing to say. */
  #passwordOptions(password: string | undefined, takeOver = false): SshPasswordOptions | undefined {
    const s = this.getState();
    const options: SshPasswordOptions = {};
    if (s.auth === "password") {
      if (password === undefined && s.passwordSaved) options.useSaved = true;
      options.remember = s.rememberPassword;
    }
    if (takeOver) options.takeOver = true;
    return Object.keys(options).length > 0 ? options : undefined;
  }

  /** The Keychain choice was applied by the host after a good login: the saved flag now follows the checkbox. */
  #syncPasswordFlag(): void {
    const s = this.getState();
    if (s.auth === "password" && s.passwordSaved !== s.rememberPassword) this.set({ passwordSaved: s.rememberPassword });
  }

  /** The fingerprint prompt's "Trust this key": confirm the last test's key, then test again so the probe is filled in. */
  async trustAndTest(password?: string): Promise<void> {
    const replacedKey = this.getState().test?.changed === true;
    await this.confirmFingerprint();
    if (this.getState().error !== null || this.getState().test?.trusted !== true) return;
    // After a changed key the saved password is gone (the host forgot it): it must be typed again, never sent silently.
    if (replacedKey && this.getState().auth === "password" && password === undefined) {
      this.set({ error: sshServerErrorText({ code: "SSH_PASSWORD_REQUIRED", message: "" }) });
      return;
    }
    await this.test(password);
  }

  /**
   * The one-Connect flow's host-key step: trust the key the user confirmed, probe the server, and connect. Any step
   * that fails stops there with its error shown; the key is never trusted without the user's click on Trust.
   */
  async trustAndConnect(password?: string): Promise<SshServerStatus | null> {
    await this.trustAndTest(password);
    const state = this.getState();
    if (state.error !== null || state.test?.trusted !== true || state.test.os === null) return null;
    return this.connect(password);
  }

  /**
   * Connect for the reconnect prompt. After a restart the last test is gone, so the key is checked again first: a
   * changed key stops here and is shown, never connected silently.
   */
  async connectWithTest(password?: string, options: { takeOver?: boolean } = {}): Promise<SshServerStatus | null> {
    if (this.getState().test?.trusted !== true) {
      await this.test(password);
      if (this.getState().test?.trusted !== true) return null;
    }
    return this.connect(password, options);
  }

  /** Start the forward. Refused client-side until the last test trusts the host key. */
  async connect(password?: string, options: { takeOver?: boolean } = {}): Promise<SshServerStatus | null> {
    if (this.getState().busy) return null;
    if (!this.validate()) {
      this.set({ error: SSH_TEXT.checkFields });
      return null;
    }
    if (this.getState().test?.trusted !== true) {
      this.set({ error: SSH_TEXT.unconfirmed });
      return null;
    }
    const target = this.target();
    const passwordOptions = this.#passwordOptions(password, options.takeOver === true);
    const status = await this.run("connect", () => (passwordOptions === undefined ? this.#io.connect(target, password) : this.#io.connect(target, password, passwordOptions)), true, "connect");
    // A warning means the Keychain step failed: the box and the flag must not claim a saved password.
    if (status !== null && !status.warning) this.#syncPasswordFlag();
    return status;
  }

  refreshStatus(): Promise<SshServerStatus | null> {
    return this.run("status", () => this.#io.status());
  }

  disconnect(): Promise<SshServerStatus | null> {
    return this.run("disconnect", () => this.#io.disconnect());
  }

  /**
   * Stop the server process on the server. The form's current target is sent, so the host stops the server the
   * dialog names. `force` repeats the call after the user accepted the foreign-core prompt.
   */
  stopServer(password?: string, options: { force?: boolean } = {}): Promise<SshServerStatus | null> {
    const target = this.target();
    const force = options.force === true;
    return this.run("stop", () => this.#io.stop(target, password, force), false, "stop");
  }

  /** The user chose Cancel on the foreign-core prompt: nothing is sent. */
  dismissForeign(): void {
    this.set({ foreign: null });
  }

  /**
   * Create a key on this computer, add it to the server and switch the saved login to it. The password is used for
   * this call only; afterwards the saved settings are read so Key file and the key path show.
   */
  async installKey(password: string): Promise<SshServerStatus | null> {
    const status = await this.run("install_key", () => this.#io.installKey(password));
    if (status !== null) await this.reloadSaved();
    return status;
  }

  /**
   * Remove the server install. The typed host name is checked here, against the target, before anything is sent;
   * a mismatch is refused with an error and no host call. The host checks the saved name again.
   */
  uninstall(password: string | undefined, typedHost: string, options: { force?: boolean } = {}): Promise<SshServerStatus | null> {
    const target = this.getState().host.trim();
    if (!uninstallConfirmed(typedHost, target)) {
      this.set({ error: SSH_TEXT.uninstallMismatch });
      return Promise.resolve(null);
    }
    const force = options.force === true;
    return this.run("uninstall", () => this.#io.uninstall(password, target, force), false, "uninstall");
  }

  private async reloadSaved(): Promise<void> {
    try {
      const saved = await this.#io.saved();
      this.set({ auth: saved.auth, keyPath: saved.keyPath });
    } catch (e) {
      this.set({ error: sshServerErrorText(e) });
    }
  }

  /**
   * `scoped`: the answer is about the target it was asked for, so a change of target while it runs drops it.
   * `foreignAction`: a stop, uninstall or connect, whose SSH_CORE_FOREIGN answer asks for confirmation (force, or Take over) instead of showing an error.
   */
  private async run(busy: SshServerBusy, action: () => Promise<SshServerStatus>, scoped = false, foreignAction: SshForeignAction | null = null): Promise<SshServerStatus | null> {
    if (this.getState().busy) return null;
    this.set({ busy, error: null });
    const generation = this.#generation;
    try {
      const status = await action();
      if (scoped && generation !== this.#generation) return null;
      // A background status read does not count as an action: it must not close a prompt the user has not answered.
      this.set(busy === "status" ? { status, error: null } : { status, error: null, foreign: null });
      return status;
    } catch (e) {
      if (scoped && generation !== this.#generation) return null;
      if (foreignAction !== null && isForeignCore(e)) {
        this.set({ foreign: foreignAction, error: null });
        return null;
      }
      this.set(foreignAction !== null ? { error: sshServerErrorText(e), foreign: null } : { error: sshServerErrorText(e) });
      return null;
    } finally {
      this.set({ busy: null });
    }
  }
}
