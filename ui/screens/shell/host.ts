// Typed client for the Rust host commands (Tauri `invoke`), with a non-Tauri fallback so
// components render and test in a plain browser, `vite dev` or `node --test`.
//
// Rules (docs/superpowers/plans/2026-10-31-tauri-phase3-plan.md, sections 3.2, 5):
//  - The webview never supplies filesystem paths: project open/recent go through the host's
//    native dialog and its own recent list (indexes only).
//  - This module holds no secrets. Anything secret stays in the host or the core process.
//  - Other slices import `host` (and `invokeHost` for commands of their own) from here instead
//    of importing `@tauri-apps/api` themselves, so tests can swap one bridge.

export type CoreState = "starting" | "ready" | "restarting" | "failed";
export type CoreTrust = "pending" | "spawned" | "adopted_unverified";
export type ClaudeState = "unknown" | "found" | "missing";

/** Mirrors the Rust `CoreStatus` (desktop/src-tauri/src/core_host.rs). Additive fields default when absent. */
export interface CoreStatus {
  url: string;
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

/** Generic typed call for commands a slice owns. Prefer adding a wrapper to `host` for shared ones. */
export async function invokeHost<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const bridge = injected;
  if (!bridge) throw new HostUnavailableError(command);
  return bridge.invoke<T>(command, args);
}

const STATES: readonly CoreState[] = ["starting", "ready", "restarting", "failed"];
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
  const trust: CoreTrust = r.trust === "spawned" || r.trust === "adopted_unverified" ? r.trust : "pending";
  const claude: ClaudeState = r.claude === "found" || r.claude === "missing" ? r.claude : "unknown";
  return {
    url: asStr(r.url) ?? "",
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

  /** Recent projects, newest first (host-owned list). */
  async projectRecent(): Promise<ProjectInfo[]> {
    if (!isHostAvailable()) return [];
    return invokeHost<ProjectInfo[]>("project_recent");
  },
};
