// Settings → Server & Backend → Remote server: the pure part (validation + a small observable model).
//
// The primary flow is URL-first: a running hub's https URL plus an email/password, a `connect` that
// logs in through the desktop host (`/auth/login`, keychain session), and an explicit switch back to
// Local that restarts the core. SSH deploy/update/uninstall live behind an Advanced section and use
// the same model's SSH fields; they are never the default.
//
// Rules:
// - the password is passed to `connect` and never stored in this observable state; only non-secret
//   SSH fields (host, user, the private-key PATH, label) live here.
// - validation mirrors desktop/src-tauri/src/remote.rs and remote_tls.rs; the host command remains
//   the authority.
// - the runner is injected, so tests exercise URL validation, login success/failure, pin vs WebPKI,
//   mode switching and the Advanced section with no real hub or SSH.

import type { RemoteServerConfig, RemoteSshResult, ServerMode } from "./host.ts";
import { Store } from "./store.ts";

export const LOCAL_COPY = "Desktop uses MEGA sync for web/mobile while it is online.";

export const REMOTE_TEXT = {
  hint: "Use a hub that is already running. Enter its https URL and your hub email/password; the desktop stores a refresh token in the OS keychain and talks to the hub after a restart. No SSH or deploy step is needed.",
  advanced: "Install or manage server over SSH",
  advancedHint: "Deploy, update, back up or uninstall a hub on a Linux server over SSH. Not needed to connect to an existing hub.",
  keyOnly: "Key files only. Enter the path to an existing private key; passwords and passphrases are not supported. The key's contents are never stored.",
  testHint: "Runs the system ssh with BatchMode=yes and a 10 second connect timeout. The first connection learns the host key (accept-new) and shows its fingerprint; a changed host key is refused.",
  noKey: "No private key file was found at that path.",
  pinHint: "Optional fallback only. A public CA certificate is verified automatically and needs no pin. Pin only when you explicitly trust this server's certificate.",
  localConfirm: "Switching to Local desktop stops using the hub and restarts the core on this computer.",
} as const;

export type RemoteField = "host" | "port" | "user" | "keyPath" | "label" | "hubUrl" | "email" | "password";
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

const HUB_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const LOCAL_TLDS = new Set(["local", "localhost", "internal", "lan", "home", "test", "invalid", "onion", "alt"]);

export interface HubUrlOptions { allowLocalhost?: boolean }
export type HubUrlResult = { ok: true; url: string; host: string; port: number } | { ok: false; error: string };

function isIpLiteral(host: string): boolean {
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return true;
  return host.includes(":");
}

/** Mirrors the host's URL-first rule: https, public domain, no path/userinfo; localhost only in dev. */
export function validateHubUrl(raw: string, opts: HubUrlOptions = {}): HubUrlResult {
  const text = raw.trim();
  if (text.length === 0) return { ok: false, error: "Enter the hub's https:// URL." };
  if (text.length > 300) return { ok: false, error: "That URL is too long." };
  if (!/^https:\/\//i.test(text)) return { ok: false, error: "The hub URL must start with https://." };
  const rest = text.slice("https://".length);
  if (/[\s\r\n]/.test(rest) || /[\/@?#]/.test(rest)) return { ok: false, error: "Use only https://host[:port] — no path, user, query or fragment." };
  const match = /^([^:]+)(?::(\d{1,5}))?$/.exec(rest);
  if (!match) return { ok: false, error: "The hub host is not valid." };
  const host = match[1].toLowerCase();
  const port = match[2] ? Number(match[2]) : 443;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, error: "The hub port must be between 1 and 65535." };
  const local = host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  if (local) {
    if (!opts.allowLocalhost) return { ok: false, error: "Use the hub's public HTTPS domain. localhost is allowed only in a development build." };
  } else {
    if (isIpLiteral(host)) return { ok: false, error: "Enter a public domain name (for example hub.example.com), not an IP address." };
    const labels = host.split(".");
    const tld = labels[labels.length - 1] ?? "";
    if (labels.length < 2 || LOCAL_TLDS.has(tld) || /^\d+$/.test(tld) || labels.some((l) => !HUB_LABEL.test(l))) {
      return { ok: false, error: "Enter a public domain name (for example hub.example.com)." };
    }
  }
  const url = port === 443 ? `https://${host}` : `https://${host}:${port}`;
  return { ok: true, url, host, port };
}

export interface HubUser { id: string; email: string; displayName: string | null; role: string }
export interface HubProject { id: string; name: string; role: string }
export interface HubCheck { hubUrl: string; webPki: boolean; pin: string; status: string; apiVersion: number; hub: boolean; dbOk: boolean }
export interface HubLogin { hubUrl: string; user: HubUser; role: string; projects: HubProject[]; webPki: boolean; pin: string }

const hubText = (v: unknown, max = 300) => (typeof v === "string" ? v.slice(0, max) : "");
export function decodeHubCheck(raw: unknown): HubCheck | null {
  if (!isRecord(raw) || typeof raw.hubUrl !== "string" || typeof raw.webPki !== "boolean" || typeof raw.pin !== "string") return null;
  if (typeof raw.status !== "string" || typeof raw.apiVersion !== "number" || typeof raw.hub !== "boolean" || typeof raw.dbOk !== "boolean") return null;
  return { hubUrl: hubText(raw.hubUrl), webPki: raw.webPki, pin: hubText(raw.pin, 80), status: hubText(raw.status, 40), apiVersion: raw.apiVersion, hub: raw.hub, dbOk: raw.dbOk };
}

export function decodeHubLogin(raw: unknown): HubLogin | null {
  if (!isRecord(raw) || typeof raw.hubUrl !== "string" || typeof raw.role !== "string" || typeof raw.webPki !== "boolean" || typeof raw.pin !== "string") return null;
  if (!isRecord(raw.user) || typeof raw.user.id !== "string" || typeof raw.user.email !== "string" || typeof raw.user.role !== "string") return null;
  if (!Array.isArray(raw.projects)) return null;
  const projects: HubProject[] = [];
  for (const p of raw.projects) {
    if (!isRecord(p) || typeof p.id !== "string" || typeof p.name !== "string" || typeof p.role !== "string") return null;
    projects.push({ id: p.id, name: p.name, role: p.role });
  }
  const displayName = raw.user.displayName === null || typeof raw.user.displayName === "string" ? raw.user.displayName : null;
  return { hubUrl: hubText(raw.hubUrl), user: { id: raw.user.id, email: raw.user.email, displayName, role: raw.user.role }, role: raw.role, projects, webPki: raw.webPki, pin: hubText(raw.pin, 80) };
}

/** Clear, fixed sentences for the host's hub command codes. */
export function hubErrorText(e: unknown): string {
  if (typeof e === "string" && e.trim().length > 0) return e.trim().slice(0, 300);
  const record = isRecord(e) ? e : null;
  const code = typeof record?.code === "string" ? record.code : null;
  const message = typeof record?.message === "string" ? record.message.trim() : "";
  switch (code) {
    case "invalid_hub_url": return message || "Enter the hub's public HTTPS URL.";
    case "invalid_email": return "Enter the email address you use on the hub.";
    case "invalid_password": return "Enter the hub password.";
    case "invalid_credentials": return "The email or password is incorrect.";
    case "forbidden": return "This account is not allowed to sign in to that hub.";
    case "rate_limited": return "Too many sign-in attempts. Wait a minute and try again.";
    case "not_a_hub": return "That URL answered, but it does not look like an LLM-IDE hub.";
    case "tls_untrusted": return "The hub's TLS certificate is not trusted by a public certificate authority. Check the domain, or use the optional certificate pin if you trust this server.";
    case "tls_pin_mismatch": return "The hub's certificate changed. Probe it again in Advanced and trust the new pin, or remove the pin to use public-CA trust.";
    case "unreachable": return "The hub did not answer. Check the URL, DNS, firewall and that the hub service is running.";
    case "project_access_denied": return "This account can sign in but has no project access on that hub. Ask a hub owner to add it to a project.";
    case "projects_unavailable": return "Signed in, but the hub's project list could not be read. Try again.";
    case "keychain_unavailable": return "The hub signed in, but the OS keychain could not store the session. Unlock the keychain and try again.";
    case "prefs_unavailable": return "The hub signed in, but the connection could not be saved (no app data folder).";
    default:
      if (message.length > 0) return message;
      return e instanceof Error && e.message ? e.message : "The hub connection failed. Check the URL and try again.";
  }
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
    case "host_key_unconfirmed": return "Confirm the server's host-key fingerprint with Test SSH before deploying.";
    case "host_key_changed": return "The server's host key no longer matches the fingerprint you confirmed. Test SSH again and compare it before deploying.";
    case "host_key_unavailable": return "The host key could not be read for verification, so nothing was changed.";
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
  /** R-034 #7: remember the fingerprint for this app session; absent on a host without the command. */
  confirm?(config: RemoteServerConfig, hostKeyType: string, fingerprint: string): Promise<void>;
  /** URL-first: reachability + TLS/health without a password. */
  check?(hubUrl: string): Promise<HubCheck>;
  /** URL-first: hub `/auth/login`; the host stores the refresh token in the OS keychain. */
  login?(hubUrl: string, email: string, password: string): Promise<HubLogin>;
  /** Clear the stored hub session (the host keychain entry). */
  signOut?(): Promise<void>;
  /** Also drop the in-memory core session (the settings client owns it). */
  logoutCore?(): Promise<void>;
  /** Restart the app so a mode change takes effect. */
  restart?(): Promise<void>;
  /** Remove the optional TLS pin and return to public-CA trust. */
  unpin?(hubUrl: string): Promise<void>;
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
  /** The fingerprint was confirmed with the host in this session. */
  confirmed: boolean;
  confirming: boolean;
  fieldErrors: RemoteFieldErrors;
  error: string | null;
  hubBusy: "check" | "connect" | "switch" | null;
  hubCheck: HubCheck | null;
  hubLogin: HubLogin | null;
  hubError: string | null;
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
  confirmed: false,
  confirming: false,
  fieldErrors: {},
  error: null,
  hubBusy: null,
  hubCheck: null,
  hubLogin: null,
  hubError: null,
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
    this.set({ mode, result: null, confirmed: false, error: null, saved: false, fieldErrors: {} });
  }

  setField(field: RemoteField, value: string): void {
    const state = this.getState();
    const fieldErrors = { ...state.fieldErrors };
    delete fieldErrors[field];
    const patch: Partial<RemoteServerState> = { fieldErrors, result: null, confirmed: false, error: null, saved: false };
    if (field === "host") patch.host = value;
    else if (field === "port") patch.port = value;
    else if (field === "user") patch.user = value;
    else if (field === "keyPath") patch.keyPath = value;
    else if (field === "hubUrl") { patch.hubUrl = value; patch.hubCheck = null; patch.hubLogin = null; patch.hubError = null; }
    else patch.label = value;
    this.set(patch);
  }

  /** The URL-first card's field: typing a new address invalidates a previous check/login. */
  setHubUrl(value: string): void {
    this.setField("hubUrl", value);
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

  /** URL-first validation: the public HTTPS address (localhost only when the caller allows it). */
  validateHub(allowLocalhost = false): boolean {
    const state = this.getState();
    const result = validateHubUrl(state.hubUrl, { allowLocalhost });
    const fieldErrors = result.ok ? {} : { hubUrl: result.error };
    this.set({ fieldErrors });
    return result.ok;
  }

  /** The Advanced SSH fields; local mode never needs them. */
  validateSsh(): boolean {
    const state = this.getState();
    const fieldErrors = state.mode === "remote" ? validateRemote(this.config()) : {};
    this.set({ fieldErrors });
    return Object.keys(fieldErrors).length === 0;
  }

  /** Back-compat alias used by the card/tests: in remote mode the URL is the primary requirement. */
  validate(): boolean {
    if (this.getState().mode === "remote") return this.validateHub();
    this.set({ fieldErrors: {} });
    return true;
  }

  /** Test connection: TLS/health only, no credentials and no mode change. */
  async checkConnection(allowLocalhost = false): Promise<HubCheck | null> {
    const state = this.getState();
    if (state.hubBusy) return null;
    const url = validateHubUrl(state.hubUrl, { allowLocalhost });
    if (!url.ok) {
      this.set({ fieldErrors: { hubUrl: url.error }, hubCheck: null, hubError: null });
      return null;
    }
    if (!this.#io.check) { this.set({ hubError: "Test connection needs the desktop host." }); return null; }
    this.set({ hubBusy: "check", hubError: null, hubCheck: null, fieldErrors: {} });
    try {
      const check = await this.#io.check(url.url);
      this.set({ hubCheck: check, hubUrl: check.hubUrl, tlsPin: check.pin, hubBusy: null });
      return check;
    } catch (e) {
      this.set({ hubCheck: null, hubError: hubErrorText(e), hubBusy: null });
      return null;
    }
  }

  /** Connect: log in at the hub, store the keychain session, save remote mode, then restart. */
  async connect(email: string, password: string, allowLocalhost = false): Promise<HubLogin | null> {
    const state = this.getState();
    if (state.hubBusy) return null;
    const url = validateHubUrl(state.hubUrl, { allowLocalhost });
    if (!url.ok) {
      this.set({ fieldErrors: { hubUrl: url.error }, hubError: null });
      return null;
    }
    if (email.trim().length === 0) { this.set({ fieldErrors: { email: "Enter the email address you use on the hub." }, hubError: null }); return null; }
    if (password.length === 0) { this.set({ fieldErrors: { password: "Enter the hub password." }, hubError: null }); return null; }
    if (!this.#io.login) { this.set({ hubError: "Connecting needs the desktop host." }); return null; }
    this.set({ hubBusy: "connect", hubError: null, hubCheck: null, fieldErrors: {} });
    try {
      const login = await this.#io.login(url.url, email.trim(), password);
      this.set({ hubLogin: login, hubUrl: login.hubUrl, tlsPin: login.pin, mode: "remote", saved: true, hubBusy: null });
      await this.#io.restart?.();
      return login;
    } catch (e) {
      this.set({ hubBusy: null, hubError: hubErrorText(e) });
      return null;
    }
  }

  /** Explicit Local switch: writes local mode, then restarts the core (never silent). */
  async switchToLocal(): Promise<boolean> {
    const state = this.getState();
    if (state.hubBusy || state.saving) return false;
    this.set({ hubBusy: "switch", hubError: null });
    try {
      const saved = await this.#io.save({ ...this.config(), mode: "local" });
      this.apply(saved);
      this.set({ mode: "local", hubLogin: null, hubCheck: null, hubBusy: null, saved: true });
      await this.#io.restart?.();
      return true;
    } catch (e) {
      this.set({ hubBusy: null, hubError: hubErrorText(e) });
      return false;
    }
  }

  /** Sign out of the hub session: clear the keychain entry and the in-memory session. */
  async signOut(): Promise<void> {
    try {
      await this.#io.signOut?.();
      await this.#io.logoutCore?.();
      this.set({ hubLogin: null, hubCheck: null, hubError: null });
    } catch (e) {
      this.set({ hubError: hubErrorText(e) });
    }
  }

  /** Remove the optional pin and return to ordinary public-CA trust at the next connection. */
  async unpin(allowLocalhost = false): Promise<void> {
    const url = validateHubUrl(this.getState().hubUrl, { allowLocalhost });
    if (!url.ok) { this.set({ fieldErrors: { hubUrl: url.error } }); return; }
    if (!this.#io.unpin) { this.set({ hubError: "Removing the pin needs the desktop host." }); return; }
    try {
      await this.#io.unpin(url.url);
      this.set({ tlsPin: "", hubCheck: null, hubError: null });
    } catch (e) {
      this.set({ hubError: hubErrorText(e) });
    }
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
      this.set({ result, confirmed: false, error: null });
    } catch (e) {
      this.set({ result: null, error: remoteSshErrorText(e) });
    } finally {
      this.set({ testing: false });
    }
  }

  /** R-034 #7: confirm the fingerprint the Test SSH just showed. Deploy/update/uninstall need this. */
  async confirm(): Promise<void> {
    const state = this.getState();
    const result = state.result;
    if (state.confirming || !result || !this.#io.confirm) return;
    this.set({ confirming: true, error: null });
    try {
      await this.#io.confirm(this.config(), result.hostKeyType, result.fingerprint);
      this.set({ confirmed: true, confirming: false });
    } catch (e) {
      this.set({ confirmed: false, confirming: false, error: remoteSshErrorText(e) });
    }
  }

  /** Save the non-secret fields (Advanced SSH, or a URL typed without connecting). */
  async save(): Promise<void> {
    const state = this.getState();
    if (state.saving) return;
    const config = this.config();
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

  /** Advanced SSH save: the SSH target must be complete before deploy is offered. */
  async saveAdvanced(): Promise<void> {
    if (!this.validateSsh()) {
      this.set({ saved: false, error: "Check the highlighted SSH fields before saving." });
      return;
    }
    await this.save();
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
      confirmed: false,
      confirming: false,
      saved: false,
      fieldErrors: {},
    });
  }
}
