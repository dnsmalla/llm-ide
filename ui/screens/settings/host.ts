// What Settings needs from the desktop shell. S-A publishes ui/screens/shell/host.ts and
// core.ts; until they land this is the narrow interface Settings codes against, and the
// shell adapts to it with one small adapter (no duplicate of their code lives here).
// Every method that is not available yet is optional: the card then shows a "needs the
// desktop host" placeholder instead of pretending.

import type { CoreClient } from "./core-api.ts";

export type ThemeChoice = "dark" | "light" | "midnight";

/** How the shell came to talk to its core. */
export type CoreTrust = "spawned" | "adopted-unverified";

export interface DiagnosticsInfo {
  appVersion: string;
  coreTrust: CoreTrust;
  coreLogPath: string | null;
  platform: string;
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

export interface SettingsHost {
  /** Versions and core trust state (nonce verified = "spawned"). */
  diagnostics(): Promise<DiagnosticsInfo>;
  /** Persisted theme (S-A prefs). */
  getTheme?(): ThemeChoice;
  setTheme?(theme: ThemeChoice): void;
  /** Native folder dialog (S-A/S-E host command). Resolves null when cancelled. */
  pickFolder?(title: string): Promise<string | null>;
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
  /** Further host prefs read when the app/backend next starts: prompt compression, learned limits, the Terminal feature. */
  getExtraPrefs?(): Promise<{ compress: boolean; learn: boolean; terminal: boolean }>;
  setExtraPrefs?(prefs: Partial<{ compress: boolean; learn: boolean; terminal: boolean }>): Promise<void>;
  /** Native, default-Cancel confirmation for trusting a folder (fixed text naming the path). Resolves false on cancel. */
  confirmTrust?(path: string): Promise<boolean>;
  /** The optional-component store (Mermaid): status, and install/remove behind the host's native dialogs. */
  mermaidStatus?(): Promise<ComponentStatus>;
  installMermaid?(): Promise<ComponentStatus>;
  removeMermaid?(): Promise<ComponentStatus>;
  /** The core's log tail for the Server & Backend group (fixed paths under the app data dir, bounded). */
  coreLog?(): Promise<CoreLogText>;
  clearCoreLog?(): Promise<void>;
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
