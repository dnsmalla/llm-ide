// Typed client for the Rust host commands (Tauri `invoke`), with a non-Tauri fallback so
// components render and test in a plain browser, `vite dev` or `node --test`.
//
// Rules (from the Phase 3 plan, sections 3.2 and 5; the plan is no longer in the repo):
//  - The webview never supplies filesystem paths: project open/recent go through the host's
//    native dialog and its own recent list (indexes only).
//  - This module holds no secrets. Anything secret stays in the host or the core process.
//  - Other slices import `host` (and `invokeHost` for commands of their own) from here instead
//    of importing `@tauri-apps/api` themselves, so tests can swap one bridge.

import { decodePrefsView } from "./host-prefs.ts";
import { hostErrorWorthReporting, reportAppError } from "./self-heal.ts";

/** `ssh`: the core runs on a Linux server and is reached through the ssh port forward (see `link`). */
export type CoreState = "starting" | "ready" | "restarting" | "failed" | "stopped" | "remote" | "ssh";
export type CoreTrust = "pending" | "spawned" | "adopted_unverified" | "remote_pinned" | "ssh_forward";
/** Ssh mode only (`null` otherwise): the forward's state. Mirrors the host's SSH link states. */
export type SshLink = "connecting" | "connected" | "reconnecting" | "needs_password" | "failed" | "stopped";
export type ClaudeState = "unknown" | "found" | "missing";

/** Mirrors the Rust `CoreStatus` (desktop/src-tauri/src/core_host.rs). Additive fields default when absent. */
export interface CoreStatus {
  url: string;
  /** `local`, `remote` (hub) or `ssh`; absent on older hosts reads as local. */
  mode: "local" | "remote" | "ssh";
  adopted: boolean;
  pid: number | null;
  ms_to_healthy: number | null;
  state: CoreState;
  error: string | null;
  trust: CoreTrust;
  notice: string | null;
  restarts: number;
  restart_in_ms: number | null;
  fatal: boolean;
  claude: ClaudeState;
  claude_source: string | null;
  claude_notice: string | null;
  /** Absolute path of the redacted core failure log (path only; the file exists after a failure). */
  core_log_path: string | null;
  /** Additive: a server this app did NOT start holds the live port. It is never used or stopped. */
  foreign_core: ForeignCore | null;
  /** Additive: machine-readable failure reason, e.g. `ports_busy`. */
  error_code: string | null;
  /** Additive: the spawn ports the host tried (with `ports_busy`). */
  ports_tried: number[];
  /** Additive: the spawned core holds :3456, so the Chrome extension can reach it. */
  extensionReachable: boolean;
  /** Additive: the ssh forward's state; `null` outside ssh mode. An unknown value reads as `failed`. */
  link: SshLink | null;
}

export interface ForeignCore {
  port: number;
  detected: boolean;
  pid: number | null;
  command: string | null;
}

/** Mirrors `ProjectInfo` in src-tauri/src/project.rs. */
export interface ProjectInfo {
  name: string;
  root: string;
}

/** One recent project as the host lists it (`project_recent_all`): paths and reasons are untrusted text. */
export interface RecentEntry {
  name: string;
  root: string;
  /** `ok` can be opened; `missing` (moved, deleted, volume not mounted) and `refused` (too broad) cannot. */
  status: "ok" | "missing" | "refused";
  /** Why it cannot be opened (host wording), or null. */
  reason: string | null;
  /** Index for `projectOpenRecent` (only `ok` entries). */
  openIndex: number | null;
  /** Position in the stored list, for `projectForgetRecent`. */
  storedIndex: number;
  /** When the project was last opened (RFC 3339 UTC), or null for entries stored before times were kept. */
  openedAt: string | null;
}

export interface RecentList {
  entries: RecentEntry[];
  /** The stored list was unreadable and was ignored: the user should be told it was reset. */
  reset: boolean;
}

export const MAX_RECENT_SHOWN = 20;

/** Defensive decode of `project_recent_all`: anything malformed reads as an empty list. */
export function decodeRecentList(raw: unknown): RecentList {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const list = Array.isArray(r.entries) ? r.entries : [];
  const entries: RecentEntry[] = [];
  for (const e of list.slice(0, MAX_RECENT_SHOWN)) {
    if (!e || typeof e !== "object") continue;
    const o = e as Record<string, unknown>;
    if (typeof o.root !== "string" || typeof o.name !== "string") continue;
    const status = o.status === "ok" || o.status === "missing" || o.status === "refused" ? o.status : "missing";
    const storedIndex = typeof o.stored_index === "number" && Number.isInteger(o.stored_index) && o.stored_index >= 0 ? o.stored_index : -1;
    const openIndex = typeof o.open_index === "number" && Number.isInteger(o.open_index) && o.open_index >= 0 ? o.open_index : null;
    if (storedIndex < 0) continue;
    const openedAt = typeof o.opened_at === "string" && o.opened_at.length <= 40 ? o.opened_at : null;
    entries.push({ name: o.name, root: o.root, status: status === "ok" && openIndex === null ? "missing" : status, reason: asStr(o.reason), openIndex: status === "ok" ? openIndex : null, storedIndex, openedAt });
  }
  return { entries, reset: r.reset === true };
}

/** What `invoke` needs; the default talks to Tauri, tests inject their own. */
export interface HostBridge {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
}

/** Thrown by every host call when there is no Tauri host and no injected bridge. */
export class HostUnavailableError extends Error {
  constructor(command: string) {
    super(`host command "${command}" is not available outside the desktop app`);
    this.name = "HostUnavailableError";
  }
}

/** Core URL used by the browser/dev fallback (the core's default port). */
export const DEV_CORE_URL = "http://127.0.0.1:3456";

let injected: HostBridge | null = null;

/**
 * Install the bridge. The desktop entry (`desktop/src/main.tsx`) installs Tauri's `invoke` when it
 * runs inside the Tauri webview, so screen code never imports `@tauri-apps/api` (it is not
 * resolvable from `ui/screens`); tests install a fake. `null` removes it (browser fallback).
 */
export function setHostBridge(bridge: HostBridge | null): void {
  injected = bridge;
}

/** True when a host bridge is installed (inside the desktop app, or a test fake). */
export function isHostAvailable(): boolean {
  return injected !== null;
}

/**
 * R-034 #12: the commands a remote-mode webview may still call. Everything else touches THIS computer
 * (files, git, projects, terminals, local chat archives) and must never run against the wrong machine.
 * The list is one place; `invokeHost` is the one wrapper every slice uses.
 */
const REMOTE_SAFE_COMMANDS = new Set([
  "core_status", "core_start", "core_stop", "core_restart",
  "get_prefs", "set_prefs", "app_restart", "host_platform", "ping",
  "open_external_url", "trust_confirm",
  // The saved repository list is app configuration, not hub data. Refusing it in remote mode would let a later
  // local launch overwrite edits made meanwhile, so it stays reachable in both modes.
  "repo_config_load", "repo_config_save",
]);
const REMOTE_SAFE_PREFIXES = ["remote_", "update_", "notify_", "tray_"];

export class RemoteModeError extends Error {
  readonly code = "remote_mode";
  // NOTE: an explicit field, not a constructor parameter property: node tests load this file with
  // --experimental-strip-types, which cannot run parameter properties (ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX).
  readonly command: string;
  constructor(command: string) {
    super(sshModeProvider()
    ? "This action uses the local computer and is unavailable in SSH server mode."
    : "This action uses the local computer and is unavailable in remote mode.");
    this.name = "RemoteModeError";
    this.command = command;
  }
}

let remoteModeProvider: () => boolean = () => false;
let sshModeProvider: () => boolean = () => false;
/** Wired by `runtime.ts` to the live core status; a plain browser/test leaves it local. */
export function setRemoteModeProvider(provider: () => boolean): void {
  remoteModeProvider = provider;
}

/**
 * Wired by `runtime.ts`: true only in ssh mode, where the host runs the Explorer's commands on the server. Hub mode is
 * also "remote" but has no server folder to browse, so it keeps refusing them.
 */
export function setSshModeProvider(provider: () => boolean): void {
  sshModeProvider = provider;
}

/** True in ssh server mode: the project is a folder on the server, so local project actions are not offered. */
export function inSshMode(): boolean {
  return sshModeProvider();
}

function remoteSafe(command: string): boolean {
  return REMOTE_SAFE_COMMANDS.has(command) || REMOTE_SAFE_PREFIXES.some((p) => command.startsWith(p));
}

/**
 * Commands ssh mode admits on top of the remote-safe set: the Explorer's files, git, search, watch, project and terminal
 * commands, which the host runs on the server while a server folder is open. `fs_open_pdf` stays refused: it opens the
 * file in this computer's viewer. Everything else that touches this computer stays refused, as in hub mode.
 */
const SSH_EXPLORER_EXACT = new Set([
  "project_search_start", "project_search_cancel", "project_active", "project_close",
  "fs_watch_start", "fs_watch_set", "fs_watch_stop",
]);
/**
 * Project setup on the server folder: the Paths and Memory cards, the graph and chat reads of the folder's own files, and
 * the clone into `<root>/code`. The host confines each of them to the server folder. `project_create` (New project) and
 * the reveal commands stay refused: they are local dialogs or write the layout in the user's home.
 */
const SSH_PROJECT_SETUP_EXACT = new Set([
  "project_paths", "project_memory", "project_rebuild_folders", "read_graph_file", "repo_clone",
]);
function sshExplorerAdmitted(command: string): boolean {
  if (command === "fs_open_pdf") return false;
  return SSH_EXPLORER_EXACT.has(command) || SSH_PROJECT_SETUP_EXACT.has(command)
    || command.startsWith("fs_") || command.startsWith("git_") || command.startsWith("pty_");
}

// The server folder vanished (ssh mode): listeners return the app to the server home. One hook here covers every
// Explorer, git, search and watch call, because they all pass through invokeHost; the Explorer's own error views
// would otherwise each need the same check.
type RootMissingListener = (message: string) => void;
const rootMissingListeners = new Set<RootMissingListener>();

/** Called when a host call in ssh mode answers `root_missing`. Returns the unsubscribe function. */
export function subscribeRootMissing(listener: RootMissingListener): () => void {
  rootMissingListeners.add(listener);
  return () => rootMissingListeners.delete(listener);
}

// A folder change (an open in progress, or a folder opened or refused) starts a new epoch. A root_missing answer counts
// only for a call that started in the current epoch, and never while an open is in progress: a late answer about the
// previous folder must not close the one that was just opened.
let serverFolderEpoch = 0;
let serverFolderOpening = false;

/** Called by the picker's open flow before the host opens a folder. */
export function beginServerFolderOpen(): void {
  serverFolderOpening = true;
  serverFolderEpoch += 1;
}

/** Called when the open answered, either way. */
export function endServerFolderOpen(): void {
  serverFolderOpening = false;
  serverFolderEpoch += 1;
}

// ssh mode: the open server folder is gone from the host (the backend was reset, for example by a disconnect or a stop).
// Listeners re-read the active project, so the shell does not keep showing a folder the Explorer can no longer reach.
type NoProjectListener = () => void;
const noProjectListeners = new Set<NoProjectListener>();

/** Called when a host call in ssh mode answers `no_project`. Returns the unsubscribe function. */
export function subscribeNoProject(listener: NoProjectListener): () => void {
  noProjectListeners.add(listener);
  return () => noProjectListeners.delete(listener);
}

/** Commands that report their own refusals inline; the root_missing and no_project hooks must not fire for them. */
function ownsItsRefusal(command: string): boolean {
  return command.startsWith("remote_ssh_workspace_") || command === "remote_ssh_project_create";
}

/**
 * Generic typed call for commands a slice owns. Prefer adding a wrapper to `host` for shared ones.
 * The workspace and project-create commands are excluded from the root_missing and no_project hooks: their own refusals
 * (for example a missing folder while opening one, or a name that exists) are shown where they happen, not as a return home.
 */
export async function invokeHost<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const bridge = injected;
  if (!bridge) throw new HostUnavailableError(command);
  if (remoteModeProvider() && !remoteSafe(command) && !(sshModeProvider() && sshExplorerAdmitted(command))) {
    throw new RemoteModeError(command);
  }
  const epoch = serverFolderEpoch;
  try {
    return await bridge.invoke<T>(command, args);
  } catch (e) {
    const record = typeof e === "object" && e !== null ? (e as { code?: unknown; message?: unknown }) : null;
    const current = epoch === serverFolderEpoch && !serverFolderOpening;
    if (record?.code === "root_missing" && current && sshModeProvider() && !ownsItsRefusal(command)) {
      const message = typeof record.message === "string" ? record.message : "This folder is no longer on the server.";
      for (const listener of [...rootMissingListeners]) listener(message);
    }
    if (record?.code === "no_project" && sshModeProvider() && !ownsItsRefusal(command)) {
      for (const listener of [...noProjectListeners]) listener();
    }
    // Every host command passes here, so one check covers them all; expected refusals are filtered out.
    if (hostErrorWorthReporting(command, e)) reportAppError(`host:${command}`, e);
    throw e;
  }
}

/**
 * Saves ssh as the server mode for the next start. Only the Switch confirmation calls it (Cancel saves nothing). The host
 * refuses with `invalid_host` when no SSH server is saved, or with the pin code when its host key is not trusted yet.
 */
export async function switchToSshMode(call: <T>(command: string, args?: Record<string, unknown>) => Promise<T> = invokeHost): Promise<void> {
  await call<unknown>("remote_ssh_switch_mode");
}

const STATES: readonly CoreState[] = ["starting", "ready", "restarting", "failed", "stopped", "remote", "ssh"];
const SSH_LINKS: readonly SshLink[] = ["connecting", "connected", "reconnecting", "needs_password", "failed", "stopped"];

/** True when the core runs on another machine (a hub or the SSH server): local-only commands must not run here. */
export function isRemoteCoreMode(mode: string | null | undefined): boolean {
  return mode === "remote" || mode === "ssh";
}

/**
 * True when the ssh forward can carry requests and credentials. Shared by the trust gate and the core base URL so
 * both agree on what "the server is reachable" means. Only `connected` counts: while the link reconnects, the local
 * port is free and another local process could bind it and receive the token or the login password.
 */
export function sshForwardReady(s: CoreStatus): boolean {
  return s.mode === "ssh" && s.state === "ssh" && s.trust === "ssh_forward" && s.link === "connected" && s.url !== "";
}

/**
 * The core URL the shell may hand out for requests: a ready core the host spawned, or a usable ssh forward. Anything
 * else is `null`, so no request (and no credential) is sent to a port that is not verified right now.
 */
export function coreBaseUrl(s: CoreStatus | null): string | null {
  return s && s.url && (s.state === "ready" || sshForwardReady(s)) ? s.url : null;
}

const asStr = (v: unknown): string | null => (typeof v === "string" ? v : null);
const asNum = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

const asPort = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v > 0 && v < 65536 ? v : null);

function normalizeForeign(raw: unknown): ForeignCore | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const port = asPort(r.port);
  if (r.detected !== true || port === null) return null;
  const pid = asNum(r.pid);
  return { port, detected: true, pid: pid !== null && Number.isInteger(pid) && pid > 0 ? pid : null, command: asStr(r.command) };
}

/** Defensive decode of `core_status`: unknown state -> `failed`, missing additive fields -> defaults. */
export function normalizeCoreStatus(raw: unknown): CoreStatus {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const state = STATES.includes(r.state as CoreState) ? (r.state as CoreState) : "failed";
  const trust: CoreTrust = r.trust === "spawned" || r.trust === "adopted_unverified" || r.trust === "remote_pinned" || r.trust === "ssh_forward" ? r.trust : "pending";
  // Outside ssh mode the host sends no link; an unknown value in ssh mode is a state the UI cannot show, so it reads as failed.
  const link: SshLink | null = r.link === null || r.link === undefined ? null : SSH_LINKS.includes(r.link as SshLink) ? (r.link as SshLink) : "failed";
  const claude: ClaudeState = r.claude === "found" || r.claude === "missing" ? r.claude : "unknown";
  return {
    url: asStr(r.url) ?? "",
    mode: r.mode === "remote" || r.mode === "ssh" ? r.mode : "local",
    adopted: r.adopted === true,
    pid: asNum(r.pid),
    ms_to_healthy: asNum(r.ms_to_healthy),
    state,
    error: asStr(r.error) ?? (state === "failed" && r.state !== "failed" ? "unrecognised core state" : null),
    trust,
    notice: asStr(r.notice),
    restarts: asNum(r.restarts) ?? 0,
    restart_in_ms: asNum(r.restart_in_ms),
    fatal: r.fatal === true,
    claude,
    claude_source: asStr(r.claude_source),
    claude_notice: asStr(r.claude_notice),
    core_log_path: asStr(r.core_log_path),
    foreign_core: normalizeForeign(r.foreign_core),
    error_code: asStr(r.error_code),
    ports_tried: Array.isArray(r.ports_tried) ? r.ports_tried.map(asPort).filter((p): p is number => p !== null).slice(0, 8) : [],
    extensionReachable: r.extensionReachable === true,
    link,
  };
}

/** Status used outside the desktop app: assume a dev core is running on the default port. */
export function devCoreStatus(url: string = DEV_CORE_URL): CoreStatus {
  return normalizeCoreStatus({
    url,
    adopted: true,
    state: "ready",
    trust: "adopted_unverified",
    notice: "Browser mode: no desktop host, using a dev core.",
  });
}

export const host = {
  /** True inside the desktop app. */
  isAvailable: isHostAvailable,

  /** Current core supervision state. Outside Tauri: a synthetic `ready` status for the dev core. */
  async coreStatus(): Promise<CoreStatus> {
    if (!isHostAvailable()) return devCoreStatus();
    return normalizeCoreStatus(await invokeHost<unknown>("core_status"));
  },

  /** Native folder dialog; resolves `null` when the user cancels. */
  async projectOpen(): Promise<ProjectInfo | null> {
    if (!isHostAvailable()) return null;
    return invokeHost<ProjectInfo | null>("project_open");
  },

  /** Re-open the `index`th entry of `projectRecent()`. The host owns the paths. */
  async projectOpenRecent(index: number): Promise<ProjectInfo> {
    if (!Number.isInteger(index) || index < 0) throw new RangeError("recent project index must be a non-negative integer");
    return invokeHost<ProjectInfo>("project_open_recent", { index });
  },

  /** The open project, or `null` when none. */
  async projectActive(): Promise<ProjectInfo | null> {
    if (!isHostAvailable()) return null;
    return invokeHost<ProjectInfo | null>("project_active");
  },

  /**
   * New project: the host opens a folder dialog for the PARENT, creates `<parent>/<name>` and scaffolds it
   * like the Mac app, then makes it active. `null` when the user cancels. The name is validated again by the host.
   */
  async projectCreate(name: string): Promise<ProjectInfo | null> {
    if (!isHostAvailable()) return null;
    return invokeHost<ProjectInfo | null>("project_create", { name });
  },

  /** Close the active project (no project open). Never deletes or changes any file. */
  async projectClose(): Promise<void> {
    if (!isHostAvailable()) return;
    await invokeHost<unknown>("project_close");
  },

  /**
   * Recent list with a status per entry (missing/moved folders are reported, not dropped). In ssh mode the list is the
   * desktop's local one, which the host refuses there; it is empty instead, so the project refresh still works.
   */
  async projectRecentAll(): Promise<RecentList> {
    if (!isHostAvailable() || inSshMode()) return { entries: [], reset: false };
    return decodeRecentList(await invokeHost<unknown>("project_recent_all"));
  },

  /** Removes one entry from the recent list only (never touches files). `false` when the list changed meanwhile. */
  async projectForgetRecent(storedIndex: number, root: string): Promise<boolean> {
    if (!Number.isInteger(storedIndex) || storedIndex < 0) throw new RangeError("recent project index must be a non-negative integer");
    return (await invokeHost<unknown>("project_forget_recent", { index: storedIndex, root })) === true;
  },

  /** Recent projects, newest first (host-owned list). Empty in ssh mode (see `projectRecentAll`). */
  async projectRecent(): Promise<ProjectInfo[]> {
    if (!isHostAvailable() || inSshMode()) return [];
    return invokeHost<ProjectInfo[]>("project_recent");
  },

  /** Shows the open project's root folder in the OS file manager (Mac: "Reveal in Finder"). The host re-checks the root. */
  async projectReveal(): Promise<void> {
    if (!isHostAvailable()) return;
    await invokeHost<unknown>("reveal_in_os", { relPath: "" });
  },

  /** R-034 #10 / URL-first: the saved hub URL and optional pin (empty = public-CA trust). */
  async remoteServerTarget(): Promise<{ hubUrl: string; pin: string } | null> {
    if (!isHostAvailable()) return null;
    const v = decodePrefsView(await invokeHost<unknown>("get_prefs"));
    const r = v?.stored.remoteServer;
    return r && r.hubUrl ? { hubUrl: r.hubUrl, pin: r.tlsPin } : null;
  },

  /** The stored hub refresh token, only when the hub URL and TLS pin still match. */
  async remoteSessionLoad(hubUrl: string, pin: string): Promise<string | null> {
    if (!isHostAvailable()) return null;
    const t = await invokeHost<unknown>("remote_session_load", { hub: hubUrl, pin });
    return typeof t === "string" && t.length > 0 ? t : null;
  },

  async remoteSessionStore(hubUrl: string, pin: string, refresh: string): Promise<void> {
    if (!isHostAvailable()) return;
    await invokeHost<unknown>("remote_session_store", { hub: hubUrl, pin, refresh });
  },

  async remoteSessionClear(): Promise<void> {
    if (!isHostAvailable()) return;
    await invokeHost<unknown>("remote_session_clear");
  },

  /**
   * Local mode: the saved local login (email, password, refresh token) in the OS keychain. The password goes to the
   * host only here, on save; the host never returns it, and `localLoginStatus` returns the email alone.
   */
  async localLoginSave(email: string, password: string): Promise<string | null> {
    if (!isHostAvailable()) return null;
    // The host signs in with the local core first; nothing is stored unless the core accepts the password.
    const t = await invokeHost<unknown>("local_login_save", { email, password });
    return typeof t === "string" && t.length > 0 ? t : null;
  },

  /** The stored refresh token for this data dir (the host refuses unless the local core is trusted). */
  async localLoginSession(): Promise<string | null> {
    if (!isHostAvailable()) return null;
    const t = await invokeHost<unknown>("local_login_session");
    return typeof t === "string" && t.length > 0 ? t : null;
  },

  /** Signs in again with the saved password on the host; returns the new refresh token. Never returns the password. */
  async localLoginRelogin(): Promise<string | null> {
    if (!isHostAvailable()) return null;
    const t = await invokeHost<unknown>("local_login_relogin");
    return typeof t === "string" && t.length > 0 ? t : null;
  },

  /** Updates the saved refresh token only when `email` is the saved account (the host compares case-insensitively). */
  async localLoginStoreRefresh(email: string, refresh: string): Promise<void> {
    if (!isHostAvailable()) return;
    await invokeHost<unknown>("local_login_store_refresh", { email, refresh });
  },

  async localLoginStatus(): Promise<{ saved: boolean; email: string | null }> {
    if (!isHostAvailable()) return { saved: false, email: null };
    const v = await invokeHost<unknown>("local_login_status");
    const o = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
    return { saved: o.saved === true, email: typeof o.email === "string" && o.email.length > 0 ? o.email : null };
  },

  async localLoginForget(): Promise<void> {
    if (!isHostAvailable()) return;
    await invokeHost<unknown>("local_login_forget");
  },

  /** The host copy of the saved repository list (JSON text), or null when there is none yet. */
  async repoConfigLoad(): Promise<string | null> {
    if (!isHostAvailable()) return null;
    const t = await invokeHost<unknown>("repo_config_load");
    return typeof t === "string" && t.length > 0 ? t : null;
  },

  async repoConfigSave(json: string): Promise<void> {
    if (!isHostAvailable()) return;
    await invokeHost<unknown>("repo_config_save", { json });
  },
};
