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

import type { SshAuth } from "../shell/host-prefs.ts";
import type { SshServerLink, SshServerStatus, SshServerTarget, SshServerTest } from "./host.ts";
import { isValidHost, isValidKeyPath, isValidUser, parseSshPort } from "./remote-model.ts";
import { Store } from "./store.ts";

export type SshServerField = "host" | "port" | "user" | "keyPath";
export type SshServerFieldErrors = Partial<Record<SshServerField, string>>;
export type SshServerBusy = "test" | "confirm" | "connect" | "disconnect" | "status" | "stop" | "uninstall";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isNullableString = (v: unknown): v is string | null => v === null || typeof v === "string";
const SSH_LINKS: readonly SshServerLink[] = ["off", "restart_required", "connecting", "connected", "reconnecting", "needs_password", "failed", "stopped"];

/** Strict decode of `remote_ssh_server_test` / `_confirm`; any wrong type reads as null (the host answered something unknown). */
export function decodeSshServerTest(raw: unknown): SshServerTest | null {
  if (!isRecord(raw)) return null;
  const { hostKeyType, fingerprint, trusted, changed, os, arch, freeMb, installedVersion, claude } = raw;
  if (typeof hostKeyType !== "string" || hostKeyType.length === 0) return null;
  if (typeof fingerprint !== "string" || fingerprint.length === 0) return null;
  if (typeof trusted !== "boolean" || typeof changed !== "boolean") return null;
  if (!isNullableString(os) || !isNullableString(arch) || !isNullableString(installedVersion) || !isNullableString(claude)) return null;
  if (freeMb !== null && (typeof freeMb !== "number" || !Number.isFinite(freeMb))) return null;
  return { hostKeyType, fingerprint, trusted, changed, os, arch, freeMb, installedVersion, claude };
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
  return { link: known, host, port, user, localUrl, version, claude, error };
}

/** Fixed, clear sentences for the host's ssh server codes; any other code shows the host's own message. */
export function sshServerErrorText(e: unknown): string {
  if (typeof e === "string" && e.trim().length > 0) return e.trim().slice(0, 300);
  const record = isRecord(e) ? e : null;
  const code = typeof record?.code === "string" ? record.code : null;
  const message = typeof record?.message === "string" ? record.message.trim() : "";
  switch (code) {
    case "SSH_AUTH_FAILED": return "The server refused this login.";
    case "SSH_PASSWORD_REQUIRED": return "Enter the password for this server.";
    case "SSH_UNREACHABLE": return "Could not reach the server.";
    case "SSH_HOST_KEY_UNCONFIRMED": return "Test the connection and confirm the server's host key first.";
    case "SSH_HOST_KEY_CHANGED": return "The server's host key changed. Test the connection again and confirm the new fingerprint.";
    case "SSH_CORE_FOREIGN": return "Another computer started the server on this account. This version supports one desktop per server account.";
    case "SSH_BUNDLE_MISSING": return "This build has no Linux server bundle.";
    default:
      if (message.length > 0) return message.slice(0, 300);
      return e instanceof Error && e.message ? e.message : "The SSH server request failed.";
  }
}

export const SSH_TEXT = {
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

export interface SshServerIo {
  test(target: SshServerTarget, password?: string): Promise<SshServerTest>;
  confirm(target: SshServerTarget, hostKeyType: string, fingerprint: string): Promise<SshServerTest>;
  connect(target: SshServerTarget, password?: string): Promise<SshServerStatus>;
  disconnect(): Promise<SshServerStatus>;
  status(): Promise<SshServerStatus>;
  stop(password?: string): Promise<SshServerStatus>;
  uninstall(password: string | undefined, confirmHost: string): Promise<SshServerStatus>;
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
  return {
    async test(target, password) {
      return decodeOrThrow(await invoke<unknown>("remote_ssh_server_test", withPassword({ target }, password)), decodeSshServerTest);
    },
    async confirm(target, hostKeyType, fingerprint) {
      return decodeOrThrow(await invoke<unknown>("remote_ssh_server_confirm", { target, hostKeyType, fingerprint }), decodeSshServerTest);
    },
    async connect(target, password) {
      return decodeOrThrow(await invoke<unknown>("remote_ssh_server_connect", withPassword({ target }, password)), decodeSshServerStatus);
    },
    async disconnect() {
      return decodeOrThrow(await invoke<unknown>("remote_ssh_server_disconnect"), decodeSshServerStatus);
    },
    async status() {
      return decodeOrThrow(await invoke<unknown>("remote_ssh_server_status"), decodeSshServerStatus);
    },
    async stop(password) {
      return decodeOrThrow(await invoke<unknown>("remote_ssh_server_stop", withPassword({}, password)), decodeSshServerStatus);
    },
    async uninstall(password, confirmHost) {
      return decodeOrThrow(await invoke<unknown>("remote_ssh_server_uninstall", withPassword({ confirmHost }, password)), decodeSshServerStatus);
    },
  };
}

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
    const patch: Partial<SshServerState> = { fieldErrors, error: null };
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
    this.set({ auth, fieldErrors, error: null });
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
      const test = await this.#io.test(this.target(), password);
      if (generation !== this.#generation) return;
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
      this.set({ test, error: null });
    } catch (e) {
      if (generation !== this.#generation) return;
      this.set({ error: sshServerErrorText(e) });
    } finally {
      this.set({ busy: null });
    }
  }

  /** Start the forward. Refused client-side until the last test trusts the host key. */
  async connect(password?: string): Promise<SshServerStatus | null> {
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
    return this.run("connect", () => this.#io.connect(target, password), true);
  }

  refreshStatus(): Promise<SshServerStatus | null> {
    return this.run("status", () => this.#io.status());
  }

  disconnect(): Promise<SshServerStatus | null> {
    return this.run("disconnect", () => this.#io.disconnect());
  }

  /** Stop the server process on the server. */
  stopServer(password?: string): Promise<SshServerStatus | null> {
    return this.run("stop", () => this.#io.stop(password));
  }

  /** Remove the server install. `confirmHost` must name the host (the host checks it again). */
  uninstall(password: string | undefined, confirmHost: string): Promise<SshServerStatus | null> {
    return this.run("uninstall", () => this.#io.uninstall(password, confirmHost));
  }

  /** `scoped`: the answer is about the target it was asked for, so a change of target while it runs drops it. */
  private async run(busy: SshServerBusy, action: () => Promise<SshServerStatus>, scoped = false): Promise<SshServerStatus | null> {
    if (this.getState().busy) return null;
    this.set({ busy, error: null });
    const generation = this.#generation;
    try {
      const status = await action();
      if (scoped && generation !== this.#generation) return null;
      this.set({ status, error: null });
      return status;
    } catch (e) {
      if (scoped && generation !== this.#generation) return null;
      this.set({ error: sshServerErrorText(e) });
      return null;
    } finally {
      this.set({ busy: null });
    }
  }
}
