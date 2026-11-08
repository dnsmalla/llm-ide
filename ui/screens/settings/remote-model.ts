// Settings → Server & Backend → Remote server: the pure part (validation + a small observable model).
// Phase 1 stores where the backend should run and tests an SSH key connection. It does not deploy anything
// or move the running core; phase 2 (documented in docs/how-to/configure-remote-server.md) adds deploy.
//
// Rules:
// - only NON-SECRET fields live here: host, port, user, the private-key PATH and an optional label. There is
//   deliberately no field for key contents, a passphrase or a password.
// - validation mirrors desktop/src-tauri/src/remote.rs; the host command remains the authority.
// - the runner is injected, so tests exercise mode switch / validation / success / failure with no real SSH.

import type { RemoteServerConfig, RemoteSshResult, ServerMode } from "./host.ts";
import { Store } from "./store.ts";

export const LOCAL_COPY = "Desktop uses MEGA sync for web/mobile while it is online.";

export const REMOTE_TEXT = {
  hint: "Run the backend on a remote Linux or macOS host over SSH. Phase 1 saves the connection and tests it; deploy/install arrives with phase 2.",
  keyOnly: "Key files only. Enter the path to an existing private key; passwords and passphrases are not supported in phase 1. The key's contents are never stored.",
  testHint: "Runs the system ssh with BatchMode=yes and a 10 second connect timeout. The first connection learns the host key (accept-new) and shows its fingerprint; a changed host key is refused.",
  noKey: "No private key file was found at that path.",
} as const;

export type RemoteField = "host" | "port" | "user" | "keyPath" | "label" | "hubUrl";
export type RemoteFieldErrors = Partial<Record<RemoteField, string>>;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const HOST_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

/** IPv6-ish literal: hex digits, colons and dots. The host command parses it with std::net for the final word. */
function looksLikeIpv6(host: string): boolean {
  return host.includes(":") && /^[0-9A-Fa-f:.]+$/.test(host) && !host.includes(":::") && host.split(":").length >= 3;
}

/** Mirrors the host's hostname/IP rule (no option prefixes, whitespace or `@`). */
export function isValidHost(raw: string): boolean {
  const host = raw.trim();
  if (host.length === 0 || host.length > 253 || host.startsWith("-") || host.endsWith(".")) return false;
  if (/[\s\u0000-\u001f\u007f]/.test(host)) return false;
  if (looksLikeIpv6(host)) return true;
  if (host.includes(":")) return false;
  return host.split(".").every((label) => HOST_LABEL.test(label));
}

/** A plain user name: letters/digits plus `.`, `_`, `-`; never option-like. */
export function isValidUser(raw: string): boolean {
  const user = raw.trim();
  return user.length > 0 && user.length <= 64 && !user.startsWith("-") && !user.startsWith(".") && /^[A-Za-z0-9._-]+$/.test(user);
}

/** Absolute path shape only (Unix, drive or UNC); the host checks that the file exists. */
export function isValidKeyPath(raw: string): boolean {
  const path = raw.trim();
  if (path.length === 0 || path.length > 4096 || path.startsWith("-")) return false;
  if (/[\u0000-\u001f\u007f]/.test(path)) return false;
  return path.startsWith("/") || path.startsWith("\\\\") || /^[A-Za-z]:[\\/]/.test(path);
}

/** `22` / `2222` -> number; anything else (blank, non-digits, out of range) -> null. */
export function parseSshPort(raw: string): number | null {
  const text = raw.trim();
  if (!/^\d{1,5}$/.test(text)) return null;
  const port = Number(text);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

export function validateRemote(config: RemoteServerConfig): RemoteFieldErrors {
  const errors: RemoteFieldErrors = {};
  if (!isValidHost(config.host)) {
    errors.host = config.host.trim().length === 0
      ? "Enter the server's hostname or IP address."
      : "That host is not valid. Use a hostname or IP address without spaces, user@, or a leading '-'.";
  }
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
    errors.port = "Enter an SSH port between 1 and 65535 (the default is 22).";
  }
  if (!isValidUser(config.user)) {
    errors.user = config.user.trim().length === 0
      ? "Enter the SSH user name."
      : "That user name is not valid. Use letters, digits, '.', '_' or '-', not a leading '-'.";
  }
  if (!isValidKeyPath(config.keyPath)) {
    errors.keyPath = config.keyPath.trim().length === 0
      ? "Enter the path to your private key file."
      : "Use an absolute path to the private key (for example ~/.ssh/id_ed25519 is not enough: write the full path).";
  }
  if (config.label.trim().length > 80) errors.label = "Keep the label under 80 characters.";
  return errors;
}

export function decodeRemoteServerConfig(raw: unknown): RemoteServerConfig | null {
  if (!isRecord(raw)) return null;
  const mode: ServerMode = raw.mode === "remote" ? "remote" : raw.mode === "local" ? "local" : "local";
  const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
  const port = typeof raw.port === "number" && Number.isInteger(raw.port) && raw.port >= 1 && raw.port <= 65535 ? raw.port : 22;
  return { mode, host: str(raw.host, 253), port, user: str(raw.user, 64), keyPath: str(raw.keyPath, 4096), label: str(raw.label, 80), hubUrl: str(raw.hubUrl, 300), tlsPin: str(raw.tlsPin, 80) };
}

/** Defensive decode of `remote_ssh_test`; null means the host answered something this version cannot read. */
export function decodeRemoteSshResult(raw: unknown): RemoteSshResult | null {
  if (!isRecord(raw)) return null;
  const required = [raw.host, raw.user, raw.hostKeyType, raw.fingerprint, raw.uname];
  if (!required.every((v) => typeof v === "string" && v.length > 0)) return null;
  if (typeof raw.port !== "number" || !Number.isInteger(raw.port) || raw.port < 1 || raw.port > 65535) return null;
  if (typeof raw.node !== "boolean") return null;
  const optional = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : null);
  return {
    host: raw.host as string,
    port: raw.port,
    user: raw.user as string,
    hostKeyType: raw.hostKeyType as string,
    fingerprint: raw.fingerprint as string,
    uname: raw.uname as string,
    node: raw.node,
    nodePath: optional(raw.nodePath),
    nodeVersion: optional(raw.nodeVersion),
  };
}

/** Fixed, clear sentences for the host command's codes; an ssh failure keeps its one-line detail. */
export function remoteSshErrorText(e: unknown): string {
  if (typeof e === "string" && e.trim().length > 0) return e.trim().slice(0, 300);
  const record = isRecord(e) ? e : null;
  const code = typeof record?.code === "string" ? record.code : null;
  const message = typeof record?.message === "string" ? record.message.trim() : "";
  switch (code) {
    case "invalid_host": return "The host is not valid. Use a hostname or IP address without spaces or a leading '-'.";
    case "invalid_user": return "The SSH user is not valid. Use letters, digits, '.', '_' or '-'.";
    case "invalid_key_path": return "The private key path is not valid. Use an absolute path to a regular key file.";
    case "invalid_port": return "The SSH port must be between 1 and 65535.";
    case "key_not_found": return REMOTE_TEXT.noKey;
    case "ssh_missing": return "The system ssh command is not available on this computer.";
    case "no_host_key": return "SSH connected but did not report the server's host key fingerprint, so the server was not accepted.";
    case "no_uname": return "SSH connected but the remote shell did not answer with its uname.";
    case "ssh_failed": return message.length > 0 ? message : "SSH could not connect. Check the host, port, user and private key.";
    default:
      if (message.length > 0) return message;
      return e instanceof Error && e.message ? e.message : "The SSH test failed. Check the connection details and try again.";
  }
}

export interface RemoteServerIo {
  load(): Promise<RemoteServerConfig>;
  save(config: RemoteServerConfig): Promise<RemoteServerConfig>;
  test(config: RemoteServerConfig): Promise<RemoteSshResult>;
}

export interface RemoteServerState {
  mode: ServerMode;
  host: string;
  port: string;
  user: string;
  keyPath: string;
  label: string;
  hubUrl: string;
  tlsPin: string;
  loaded: boolean;
  loadFailed: boolean;
  saving: boolean;
  saved: boolean;
  testing: boolean;
  result: RemoteSshResult | null;
  fieldErrors: RemoteFieldErrors;
  error: string | null;
}

export const REMOTE_SERVER_INITIAL: RemoteServerState = {
  mode: "local",
  host: "",
  port: "22",
  user: "",
  keyPath: "",
  label: "",
  hubUrl: "",
  tlsPin: "",
  loaded: false,
  loadFailed: false,
  saving: false,
  saved: false,
  testing: false,
  result: null,
  fieldErrors: {},
  error: null,
};

export class RemoteServerModel extends Store<RemoteServerState> {
  readonly #io: RemoteServerIo;
  constructor(io: RemoteServerIo) {
    super({ ...REMOTE_SERVER_INITIAL, fieldErrors: {} });
    this.#io = io;
  }

  async load(): Promise<void> {
    try {
      const config = await this.#io.load();
      this.apply(config);
      this.set({ loaded: true, loadFailed: false, error: null });
    } catch (e) {
      this.set({ loaded: true, loadFailed: true, error: remoteSshErrorText(e) });
    }
  }

  setMode(mode: ServerMode): void {
    if (mode === this.getState().mode) return;
    this.set({ mode, result: null, error: null, saved: false, fieldErrors: {} });
  }

  setField(field: RemoteField, value: string): void {
    const state = this.getState();
    const fieldErrors = { ...state.fieldErrors };
    delete fieldErrors[field];
    const patch: Partial<RemoteServerState> = { fieldErrors, result: null, error: null, saved: false };
    if (field === "host") patch.host = value;
    else if (field === "port") patch.port = value;
    else if (field === "user") patch.user = value;
    else if (field === "keyPath") patch.keyPath = value;
    else if (field === "hubUrl") patch.hubUrl = value;
    else patch.label = value;
    this.set(patch);
  }

  /** The trimmed config the host receives; `port` is 0 only when the text is not a valid port (validation catches it). */
  config(): RemoteServerConfig {
    const s = this.getState();
    return {
      mode: s.mode,
      host: s.host.trim(),
      port: parseSshPort(s.port) ?? 0,
      user: s.user.trim(),
      keyPath: s.keyPath.trim(),
      label: s.label.trim(),
      hubUrl: s.hubUrl.trim(),
      tlsPin: s.tlsPin.trim(),
    };
  }

  /** Sets `fieldErrors` and returns true when the remote fields are valid. Local mode never needs them. */
  validate(): boolean {
    const state = this.getState();
    const fieldErrors = state.mode === "remote" ? validateRemote(this.config()) : {};
    this.set({ fieldErrors });
    return Object.keys(fieldErrors).length === 0;
  }

  async test(): Promise<void> {
    const state = this.getState();
    if (state.testing) return;
    const config = this.config();
    const fieldErrors = validateRemote(config);
    if (Object.keys(fieldErrors).length > 0) {
      this.set({ fieldErrors, result: null, error: "Check the highlighted fields before testing." });
      return;
    }
    this.set({ testing: true, error: null, result: null, fieldErrors: {} });
    try {
      const result = await this.#io.test(config);
      this.set({ result, error: null });
    } catch (e) {
      this.set({ result: null, error: remoteSshErrorText(e) });
    } finally {
      this.set({ testing: false });
    }
  }

  async save(): Promise<void> {
    const state = this.getState();
    if (state.saving) return;
    const config = this.config();
    if (state.mode === "remote") {
      const fieldErrors = validateRemote(config);
      if (Object.keys(fieldErrors).length > 0) {
        this.set({ fieldErrors, saved: false, error: "Check the highlighted fields before saving." });
        return;
      }
    }
    this.set({ saving: true, saved: false, error: null });
    try {
      const saved = await this.#io.save(config);
      this.apply(saved);
      this.set({ saved: true, error: null, fieldErrors: {} });
    } catch (e) {
      this.set({ error: remoteSshErrorText(e) });
    } finally {
      this.set({ saving: false });
    }
  }

  private apply(config: RemoteServerConfig): void {
    this.set({
      mode: config.mode,
      host: config.host,
      port: String(config.port),
      user: config.user,
      keyPath: config.keyPath,
      label: config.label,
      hubUrl: config.hubUrl,
      tlsPin: config.tlsPin,
      result: null,
      saved: false,
      fieldErrors: {},
    });
  }
}
