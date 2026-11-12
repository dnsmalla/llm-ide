// Typed view of the host's `get_prefs` / `set_prefs` (desktop/src-tauri/src/prefs.rs). Pure: decode only.
// The host is the authority (strict schema, unknown keys refused); this side decodes defensively so a
// malformed answer reads as "unavailable" instead of showing invented values.

export type LtaModeValue = "off" | "shadow" | "on";
export type ProtectedPathPolicy = "revert" | "stop" | "warn" | "off";

/** App-wide defaults for loops added to a newly detected project (see desktop prefs::LoopDefaults). */
export interface LoopDefaults {
  maxIterations: number;
  consecutiveFailureStop: number;
  wallClockMinutes: number;
  maxRepairsPerStage: number;
  pauseTimeoutMinutes: number;
  protectedPathPolicy: ProtectedPathPolicy;
  writeSummaryNote: boolean;
}

export const DEFAULT_LOOP_DEFAULTS: LoopDefaults = Object.freeze({
  maxIterations: 10, consecutiveFailureStop: 2, wallClockMinutes: 0,
  maxRepairsPerStage: 3, pauseTimeoutMinutes: 30, protectedPathPolicy: "revert", writeSummaryNote: false,
});

/** Per-category notification switches (desktop prefs::NotifyPrefs). Apply at once. */
export interface NotifyPrefs { approvals: boolean; tasks: boolean; sync: boolean; updates: boolean; core: boolean }
export const DEFAULT_NOTIFY_PREFS: NotifyPrefs = Object.freeze({ approvals: true, tasks: true, sync: true, updates: true, core: true });
/** Defensive decode: anything but an explicit `false` reads as on (the host default). */
export function decodeNotifyPrefs(raw: unknown): NotifyPrefs {
  const r = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  return { approvals: r.approvals !== false, tasks: r.tasks !== false, sync: r.sync !== false, updates: r.updates !== false, core: r.core !== false };
}
/** Settings → Server & Backend → Remote server (desktop prefs::RemoteServerPrefs). */
export type ServerModeValue = "local" | "remote";
export interface RemoteServerPrefs {
  mode: ServerModeValue;
  host: string;
  port: number;
  user: string;
  /** The private key PATH only. Its contents are never stored. */
  keyPath: string;
  label: string;
  hubUrl: string;
  tlsPin: string;
}
export const DEFAULT_REMOTE_SERVER: RemoteServerPrefs = Object.freeze({ mode: "local", host: "", port: 22, user: "", keyPath: "", label: "", hubUrl: "", tlsPin: "" });

export interface HostPrefs {
  ltaMode: LtaModeValue;
  router: boolean;
  cap: boolean;
  compress: boolean;
  learn: boolean;
  /** Continue ended chats from a summary (beta, bench-gated); read at the next backend start. */
  continueSummary: boolean;
  terminal: boolean;
  theme: "dark" | "light" | "midnight";
  /** The feature profile: an explicit subset of the server's feature keys; empty = every feature. */
  features: string[];
  /** Run the core from a source checkout instead of the bundled copy. */
  backendSource: boolean;
  /** Source checkout: node binary and `extension` folder (empty = auto-detect). */
  backendNode: string;
  backendDir: string;
  /** Source checkout: loopback port (0 = the app's default range). */
  backendPort: number;
  /** Start the core when the app launches. */
  backendAutoStart: boolean;
  /** Remote server choice and non-secret SSH fields; phase 1 stores them but does not act on them yet. */
  remoteServer: RemoteServerPrefs;
  /** Host API v1 capabilities passed to the spawned core (exact `1`); all apply at the next core start. */
  hostApiTls: boolean;
  hostApiRead: boolean;
  hostApiCompose: boolean;
  hostApiPush: boolean;
  hostApiToolApprovals: boolean;
  /** Browser origins allowed to connect directly (`LLMIDE_HOST_API_WEB_ORIGINS`); the host normalises them on save. */
  hostApiWebOrigins: string[];
  /** Host-owned marker of the one-time migration that turned read/compose/tool approvals on; never set from the UI. */
  hostApiCapsMigrated: boolean;
  /** Defaults applied to loops the Loop screen re-adds to a project. */
  loopDefaults: LoopDefaults;
  /** Minutes between automatic Code Graph refreshes; 0 = off. Host raises 1-4 to 5. */
  graphAutoUpdateMinutes: number;
  /** Daily signed-update check; applies at once. */
  updateChecks: boolean;
  /** Per-category notification switches; apply at once. */
  notifications: NotifyPrefs;
}

export interface HostPrefsView {
  stored: HostPrefs;
  /** What this launch runs with. */
  launch: HostPrefs;
  restartNeeded: boolean;
  persisted: boolean;
}

export type HostPrefsPatch = Partial<HostPrefs>;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Defensive decode of the Loop defaults; absent/bad values fall back to the shipped defaults. */
export function decodeLoopDefaults(raw: unknown): LoopDefaults {  if (!isObj(raw)) return { ...DEFAULT_LOOP_DEFAULTS };
  const n = (v: unknown, fallback: number, max: number) => (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= max ? v : fallback);
  const policy = raw.protectedPathPolicy;
  return {
    maxIterations: n(raw.maxIterations, DEFAULT_LOOP_DEFAULTS.maxIterations, 100) || DEFAULT_LOOP_DEFAULTS.maxIterations,
    consecutiveFailureStop: n(raw.consecutiveFailureStop, DEFAULT_LOOP_DEFAULTS.consecutiveFailureStop, 20) || DEFAULT_LOOP_DEFAULTS.consecutiveFailureStop,
    wallClockMinutes: n(raw.wallClockMinutes, DEFAULT_LOOP_DEFAULTS.wallClockMinutes, 1440),
    maxRepairsPerStage: n(raw.maxRepairsPerStage, DEFAULT_LOOP_DEFAULTS.maxRepairsPerStage, 20),
    pauseTimeoutMinutes: n(raw.pauseTimeoutMinutes, DEFAULT_LOOP_DEFAULTS.pauseTimeoutMinutes, 240),
    protectedPathPolicy: policy === "stop" || policy === "warn" || policy === "off" ? policy : "revert",
    writeSummaryNote: raw.writeSummaryNote === true,
  };
}

/** Defensive decode of the remote block; an older prefs file (or a bad value) reads as Local desktop. */
export function decodeRemoteServer(raw: unknown): RemoteServerPrefs {
  if (!isObj(raw)) return { ...DEFAULT_REMOTE_SERVER };
  const text = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
  return {
    mode: raw.mode === "remote" ? "remote" : "local",
    host: text(raw.host, 253),
    port: typeof raw.port === "number" && Number.isInteger(raw.port) && raw.port >= 1 && raw.port <= 65535 ? raw.port : 22,
    user: text(raw.user, 64),
    keyPath: text(raw.keyPath, 4096),
    label: text(raw.label, 80),
    hubUrl: text(raw.hubUrl, 300),
    tlsPin: text(raw.tlsPin, 80),
  };
}

export function decodePrefs(raw: unknown): HostPrefs | null {
  if (!isObj(raw)) return null;
  const { ltaMode, router, cap, compress, learn, terminal, theme } = raw;
  if (ltaMode !== "off" && ltaMode !== "shadow" && ltaMode !== "on") return null;
  if (theme !== "dark" && theme !== "light" && theme !== "midnight") return null;
  for (const b of [router, cap, compress, learn, terminal]) if (typeof b !== "boolean") return null;
  // Older prefs files have no features field; that reads as "every feature", the historical behaviour.
  const features = Array.isArray(raw.features)
    ? raw.features.filter((x): x is string => typeof x === "string" && x.length > 0 && x.length <= 40).slice(0, 32)
    : [];
  const backendSource = raw.backendSource === true;
  const backendNode = typeof raw.backendNode === "string" ? raw.backendNode.slice(0, 4096) : "";
  const backendDir = typeof raw.backendDir === "string" ? raw.backendDir.slice(0, 4096) : "";
  const backendPort = typeof raw.backendPort === "number" && Number.isInteger(raw.backendPort) && raw.backendPort >= 0 && raw.backendPort <= 65535 ? raw.backendPort : 0;
  const backendAutoStart = raw.backendAutoStart !== false;
  const loopDefaults = decodeLoopDefaults(raw.loopDefaults);
  const graphAutoUpdateMinutes = typeof raw.graphAutoUpdateMinutes === "number" && Number.isInteger(raw.graphAutoUpdateMinutes) && raw.graphAutoUpdateMinutes >= 0 && raw.graphAutoUpdateMinutes <= 1440
    ? (raw.graphAutoUpdateMinutes === 0 ? 0 : Math.max(5, raw.graphAutoUpdateMinutes))
    : 0;
  const updateChecks = raw.updateChecks !== false;
  const continueSummary = raw.continueSummary === true;
  const remoteServer = decodeRemoteServer(raw.remoteServer);
  return { ltaMode, router: router as boolean, cap: cap as boolean, compress: compress as boolean, learn: learn as boolean, continueSummary, terminal: terminal as boolean, theme, features, backendSource, backendNode, backendDir, backendPort, backendAutoStart, remoteServer,
    hostApiTls: raw.hostApiTls === true, hostApiRead: raw.hostApiRead === true, hostApiCompose: raw.hostApiCompose === true, hostApiPush: raw.hostApiPush === true, hostApiToolApprovals: raw.hostApiToolApprovals === true,
    hostApiWebOrigins: Array.isArray(raw.hostApiWebOrigins) ? raw.hostApiWebOrigins.filter((x): x is string => typeof x === "string" && x.length <= 300).slice(0, 10) : [],
    hostApiCapsMigrated: raw.hostApiCapsMigrated === true, loopDefaults, graphAutoUpdateMinutes, updateChecks, notifications: decodeNotifyPrefs(raw.notifications) };
}

export function decodePrefsView(raw: unknown): HostPrefsView | null {
  if (!isObj(raw)) return null;
  const stored = decodePrefs(raw.stored);
  const launch = decodePrefs(raw.launch);
  if (!stored || !launch) return null;
  return { stored, launch, restartNeeded: raw.restartNeeded === true, persisted: raw.persisted !== false };
}

/** The folder choice `pick_folder` returns: an opaque token and a display name, never a path. */
export function decodePickedChoice(raw: unknown): { token: string; name: string } | null {
  if (raw === null || !isObj(raw)) return null;
  return typeof raw.token === "string" && raw.token.length > 0 && typeof raw.name === "string" ? { token: raw.token, name: raw.name } : null;
}

/** The canonical path `pick_folder_redeem` returns: must look absolute, else it is refused. */
export function decodePickedFolder(raw: unknown): string | null {
  if (!isObj(raw) || typeof raw.path !== "string") return null;
  return raw.path.startsWith("/") || /^([A-Za-z]:[\\/]|\\\\)/.test(raw.path) ? raw.path : null;
}
