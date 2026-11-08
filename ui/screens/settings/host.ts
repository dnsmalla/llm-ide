// What Settings needs from the desktop shell. S-A publishes ui/screens/shell/host.ts and
// core.ts; until they land this is the narrow interface Settings codes against, and the
// shell adapts to it with one small adapter (no duplicate of their code lives here).
// Every method that is not available yet is optional: the card then shows a "needs the
// desktop host" placeholder instead of pretending.

import type { CoreClient, CoreResponse } from "./core-api.ts";
import type { LoopDefaults } from "../shell/host-prefs.ts";
import type { UpdateStatusView } from "./updates-model.ts";

export type ThemeChoice = "dark" | "light" | "midnight";

/** How the shell came to talk to its core. */
export type CoreTrust = "spawned" | "adopted-unverified" | "remote-pinned";

/** Server & Backend's editable backend settings (source-checkout mode). */
export interface BackendConfig {
  source: boolean;
  node: string;
  dir: string;
  /** 0 = the app's default 3457-3459 range. */
  port: number;
  autoStart: boolean;
}

/** Settings → Server & Backend → Remote server. Phase 1 stores the choice; deploy lands in phase 2. */
export type ServerMode = "local" | "remote";

/** Non-secret remote connection settings. `keyPath` names the user's key file; its contents are never stored. */
export interface RemoteServerConfig {
  mode: ServerMode;
  host: string;
  port: number;
  user: string;
  keyPath: string;
  label: string;
  /** `https://<hub>` and its leaf SPKI pin; empty until probed and confirmed. */
  hubUrl: string;
  tlsPin: string;
}

/** What the host's `remote_ssh_test` reports after a successful connection. */
export interface RemoteSshResult {
  host: string;
  port: number;
  user: string;
  hostKeyType: string;
  fingerprint: string;
  uname: string;
  node: boolean;
  nodePath: string | null;
  nodeVersion: string | null;
}

export interface DiagnosticsInfo {
  appVersion: string;
  coreTrust: CoreTrust;
  coreLogPath: string | null;
  platform: string;
  /** The core URL this launch is using (desktop-managed; absent on older hosts). */
  coreUrl?: string | null;
  /** The host's core phase, for the Start/Stop/Restart controls. */
  coreState?: string | null;
}

/** One side (old Mac app folder or desktop data folder) of the old-data import report. */
export interface LegacyImportSide {
  /** Absolute path, or null when the folder could not be resolved. */
  path: string | null;
  exists: boolean;
  valid: boolean;
  empty: boolean;
  sizeBytes: number;
  tableCount: number;
  totalRows: number;
  migration: number | null;
  tables: Record<string, number>;
  /** Why a side is not valid (missing | empty | integrity | unreadable | no-schema-migrations). */
  reason: string;
  agentDb: { exists: boolean; valid: boolean; sizeBytes: number; tableCount: number; migration: number | null };
  secretsFile: boolean;
}

/** Read-only host answer for Settings → Server & Backend → "Old Mac app data". */
export interface LegacyImportStatus {
  formatVersion: number;
  status: string;
  reason: string | null;
  /** What the helper would do: import | force | refuse | noop | none. */
  action: string;
  needsForce: boolean;
  hasVaultSecrets: boolean;
  legacy: LegacyImportSide;
  target: LegacyImportSide;
  marker: {
    status: string;
    importedAt: string | null;
    backups: string[];
    replaced: boolean;
    totalRows: number | null;
    tables: Record<string, number> | null;
  } | null;
  notes: string[];
  durationMs: number;
}

/** The result of `run_legacy_import`: the report plus what was written. */
export interface LegacyImportReport extends LegacyImportStatus {
  ran?: boolean;
  importedAt?: string | null;
  replaced?: boolean;
  /** Target-relative path of the verified data.db backup. */
  backup?: string | null;
  backups?: string[];
  tables?: Record<string, number> | null;
  totalRows?: number | null;
  migration?: number | null;
  agentMigration?: number | null;
  secretsImported?: boolean;
  /** Host-written copy of the previous OS-keychain secrets (owner-only, beside the DB backup). */
  keychainBackup?: string | null;
  rolledBack?: boolean | null;
}

/** One optional component the host can install on demand (the Mermaid diagram renderer today). */
export interface ComponentStatus {
  installed: boolean;
  version: string;
  sizeBytes: number;
  /** The download host named by the embedded pin (shown before an install). */
  host: string;
}

/** The core's log tail as the Server & Backend group shows it. Paths come from the host, never the page. */
export interface CoreLogText {
  path: string;
  text: string;
  exists: boolean;
}

/** One canonical project folder and whether it exists (read-only, from the active project root). */
export interface ProjectFolder {
  name: string;
  exists: boolean;
}

export interface ProjectPaths {
  root: string;
  /** The KB project id from system/project.json (not the DocGen hash). */
  id: string;
  folders: ProjectFolder[];
}

export interface ProjectMemoryFile {
  name: string;
  /** Project-relative, for `reveal_in_os`. */
  path: string;
  sizeBytes: number;
}

export interface ProjectGraph {
  path: string;
  sizeBytes: number;
}

export interface ProjectMemory {
  root: string;
  graph: ProjectGraph | null;
  files: ProjectMemoryFile[];
}

/** rtk detection for the Token Saving group (it shrinks shell output for the user's own Claude Code). */
export interface RtkStatus {
  installed: boolean;
  version: string | null;
  /** Homebrew is present, so Install can run. */
  canInstall: boolean;
}

/** A Self-Heal run's worktree (plan B; `self_heal_prepare`). */
export interface SelfHealPrepared {
  mainRepo: string;
  worktreePath: string;
  branch: string;
  baseCommit: string;
}

/** `self_heal_verify`: the answered batch, whether make regression passed and whether a diff is left. */
export interface SelfHealVerified {
  batch: string;
  passed: boolean;
  timedOut: boolean;
  hasChanges: boolean;
  reverted: string[];
  output: string;
}

/** `self_heal_diff`: the text shown, and the id of the exact patch Apply will apply. */
export interface SelfHealDiff {
  text: string;
  truncated: boolean;
  patchId: string;
  files: string[];
}

/** Plan B's fix run (debug desktop builds). Host commands take a run id only; `agentRun` is the core's Loop agent
 *  with a long client timeout; `flushIncidents` posts the reports the run produced before its outcome. */
export interface SelfHealHost {
  source(): Promise<string>;
  prepare(runId: string, batch: string): Promise<SelfHealPrepared>;
  agentRun(body: Record<string, unknown>): Promise<CoreResponse>;
  verify(runId: string): Promise<SelfHealVerified>;
  diff(runId: string): Promise<SelfHealDiff>;
  apply(runId: string, patchId: string): Promise<void>;
  remove(runId: string): Promise<void>;
  flushIncidents(): Promise<void>;
}

export interface SettingsHost {
  /** Versions and core trust state (nonce verified = "spawned"). */
  diagnostics(): Promise<DiagnosticsInfo>;
  /** Persisted theme (S-A prefs). */
  getTheme?(): ThemeChoice;
  setTheme?(theme: ThemeChoice): void;
  /** Native folder dialog (S-A/S-E host command). Resolves null when cancelled. */
  pickFolder?(title: string): Promise<string | null>;
  /** The feature profile: what is stored for the next start and what this launch actually runs. */
  getFeatureProfile?(): Promise<{ stored: string[]; launch: string[] }>;
  /** Writes the profile (empty = every feature). The core picks it up at the next start. */
  setFeatureProfile?(features: string[]): Promise<{ stored: string[]; launch: string[] }>;
  /** Starts a reduced build from the source checkout with `features` compiled in; the app restarts when it is ready. */
  rebuildFeatures?(features: string[]): Promise<{ started: boolean; message: string }>;
  getBackendConfig?(): Promise<BackendConfig>;
  setBackendConfig?(patch: Partial<BackendConfig>): Promise<BackendConfig>;
  pickNode?(): Promise<string | null>;
  pickBackendDir?(): Promise<string | null>;
  detectBackend?(): Promise<{ node: string; dir: string }>;
  /** Remote server choice and non-secret SSH fields (host prefs; the key PATH only, never key contents). */
  getRemoteServer?(): Promise<RemoteServerConfig>;
  setRemoteServer?(config: RemoteServerConfig): Promise<RemoteServerConfig>;
  /** Host command `remote_ssh_test`: starts system ssh with a fixed argv and returns the fingerprint/uname/node. */
  testRemoteSsh?(config: RemoteServerConfig): Promise<RemoteSshResult>;
  /** Phase 2: read-only SSH preflight; the host returns a plan with blockers, warnings and a typed confirmation. */
  remoteDeployPlan?(target: { host: string; port: number; user: string; keyPath: string }, domain: string, reviewAck: boolean): Promise<unknown>;
  /** Phase 2: upload the fixed helper and install its exact sudoers line. */
  remoteDeployBootstrap?(target: { host: string; port: number; user: string; keyPath: string }): Promise<unknown>;
  /** Phase 2: the confirmed deploy (stops before registration is locked). */
  remoteDeployRun?(target: { host: string; port: number; user: string; keyPath: string }, planId: string, confirmation: string): Promise<unknown>;
  /** Phase 2: close registration after the owner exists. */
  remoteDeployLock?(target: { host: string; port: number; user: string; keyPath: string }): Promise<void>;
  /** Phase 2: restore the previous release. */
  remoteDeployRollback?(target: { host: string; port: number; user: string; keyPath: string }): Promise<void>;
  /** Probe the hub's leaf SPKI (normal chain validation) and return the fingerprint to show. */
  remoteTlsProbe?(hubUrl: string): Promise<{ fingerprint: string }>;
  /** Store hub URL + confirmed leaf SPKI pin (only after the user trusts it). */
  remoteTlsPin?(hubUrl: string, fingerprint: string): Promise<void>;
  /** Restart the app so a saved mode change takes effect. */
  restartApp?(): Promise<void>;
  /** Stop/start the app-managed core from Settings (and the core-down panel for Start). */
  coreStop?(): Promise<void>;
  coreStart?(): Promise<void>;
  coreRestart?(): Promise<void>;
  /** Clones a saved repository into the active project's code/ folder (token optional for public repos). */
  cloneRepository?(args: { provider: "github" | "gitlab"; url: string; token?: string }): Promise<{ path: string; name: string }>;
  /** Active project folder, if the shell has one. */
  activeProjectPath?(): string | null;
  notesFolderPath?(): Promise<string | null>;
  /** Native clipboard (a webview clipboard call can be blocked). */
  copyText(text: string): Promise<void>;
  /** The live-then-archive switch lives in host prefs, applied at next start. */
  getLtaMode?(): Promise<"off" | "shadow" | "on">;
  setLtaMode?(mode: "off" | "shadow" | "on"): Promise<void>;
  /** The mode this launch runs with, to show "applies at next start". */
  launchLtaMode?(): "off" | "shadow" | "on";
  /** Per-chat router and token-cap switches: host prefs read when the backend next starts. */
  getRoutePrefs?(): Promise<{ router: boolean; cap: boolean }>;
  setRoutePrefs?(prefs: { router: boolean; cap: boolean }): Promise<void>;
  /** Further host prefs read when the app/backend next starts: prompt compression, learned limits, the Terminal
   *  feature, ended-chat continuation, and the five Host API v1 capabilities. */
  getExtraPrefs?(): Promise<{ compress: boolean; learn: boolean; terminal: boolean; continueSummary: boolean; hostApiTls: boolean; hostApiRead: boolean; hostApiCompose: boolean; hostApiPush: boolean; hostApiToolApprovals: boolean }>;
  setExtraPrefs?(prefs: Partial<{ compress: boolean; learn: boolean; terminal: boolean; continueSummary: boolean; hostApiTls: boolean; hostApiRead: boolean; hostApiCompose: boolean; hostApiPush: boolean; hostApiToolApprovals: boolean }>): Promise<void>;
  /** App-wide defaults for loops added to a newly detected project. */
  getLoopDefaults?(): Promise<LoopDefaults>;
  setLoopDefaults?(defaults: LoopDefaults): Promise<LoopDefaults>;
  /** Minutes between automatic Code Graph refreshes (0 = off; 5-1440 otherwise). */
  getGraphAutoUpdate?(): Promise<number>;
  setGraphAutoUpdate?(minutes: number): Promise<number>;
  /** Daily signed-update check (host pref, applies at once). */
  getUpdateChecks?(): Promise<boolean>;
  setUpdateChecks?(on: boolean): Promise<boolean>;
  /** The host updater: cached status, a network check, and install (native confirm, then restart). */
  updateStatus?(): Promise<UpdateStatusView>;
  checkForUpdate?(): Promise<UpdateStatusView>;
  /** false = the user cancelled the native dialog. */
  installUpdate?(): Promise<boolean>;
  /** Native, default-Cancel confirmation for trusting a folder (fixed text naming the path). Resolves false on cancel. */
  confirmTrust?(path: string): Promise<boolean>;
  /** The optional-component store (Mermaid): status, and install/remove behind the host's native dialogs. */
  mermaidStatus?(): Promise<ComponentStatus>;
  installMermaid?(): Promise<ComponentStatus>;
  removeMermaid?(): Promise<ComponentStatus>;
  /** Self-Heal's fix run (plan B): present only with a desktop host; its commands refuse in a release build. */
  selfHeal?: SelfHealHost;
  /** Old Mac app data: read-only status, then the explicit one-time import (native confirmation). */
  legacyImportStatus?(): Promise<LegacyImportStatus>;
  runLegacyImport?(force: boolean): Promise<LegacyImportReport>;
  /** The core's log tail for the Server & Backend group (fixed paths under the app data dir, bounded). */
  coreLog?(): Promise<CoreLogText>;
  clearCoreLog?(): Promise<void>;
  /** The open project's layout and memory files (read-only, host-resolved; the page never supplies a path). */
  projectPaths?(): Promise<ProjectPaths>;
  /** Re-create the active project's missing canonical folders (never overwrites existing files). */
  rebuildProjectFolders?(): Promise<void>;
  projectMemory?(): Promise<ProjectMemory>;
  /** Reveals a project-relative path in the OS file manager (the host re-checks it against the root). */
  revealPath?(relPath: string): Promise<void>;
  /** rtk (Token Saving): detect, and install through Homebrew behind the host's native confirmation. */
  rtkStatus?(): Promise<RtkStatus>;
  installRtk?(): Promise<RtkStatus>;
  /** The menu-bar icon switch (host tray). Hidden also disables close-to-tray in the host. */
  getTrayIcon?(): Promise<boolean>;
  setTrayIcon?(on: boolean): Promise<boolean>;
  /** The developer-tools switch (shows the Spike item in the toolbar): per viewer, applies at once. */
  getDevTools?(): boolean;
  setDevTools?(on: boolean): void;
  /** Sign-in/out through the shell's core client, which owns the tokens. */
  signIn?(email: string, password: string): Promise<void>;
  signOut?(): Promise<void>;
}

export interface SettingsEnv {
  client: CoreClient;
  host: SettingsHost;
}
