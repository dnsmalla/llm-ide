// Pure parts of Appearance, Workspace, Features, Account and About.
import type { Health, Me } from "./decoders.ts";
import type { CoreTrust, DiagnosticsInfo, ThemeChoice } from "./host.ts";
import { scrubSecrets } from "./secret-field.ts";

export const THEME_CHOICES: readonly { id: ThemeChoice; label: string }[] = [
  { id: "dark", label: "Dark" },
  { id: "light", label: "Light" },
  { id: "midnight", label: "Midnight" },
];

export function isThemeChoice(v: unknown): v is ThemeChoice {
  return v === "dark" || v === "light" || v === "midnight";
}

// ---- live-then-archive mode (host pref, applies at next start) ---------------------------------

export type LtaMode = "off" | "shadow" | "on";
export const LTA_MODES: readonly LtaMode[] = ["off", "shadow", "on"];

export const LTA_TEXT = {
  title: (m: LtaMode): string => (m === "off" ? "Off" : m === "shadow" ? "Shadow" : "On"),
  explanation: (m: LtaMode): string =>
    m === "off"
      ? "Chats work as they always did. Nothing is archived, and signing out clears ordinary chats."
      : m === "shadow"
        ? "A trial run. Chats are copied into files on this computer and checked, but nothing is deleted from the server, and signing out keeps your chats."
        : "Chats live on this computer. At quit they are saved and checked, then the server's working copy is removed. Deleting a chat removes it everywhere.",
  restartNote: "A change applies the next time you open the app.",
  offConfirmTitle: "Turn archiving off?",
  offConfirmMessage:
    "Chats already archived on this computer are kept. New chats stop being archived, and signing out clears ordinary chats again.",
} as const;

/** Switching to Off from On (stored or running) needs a confirmation first. */
export function needsOffConfirm(selected: LtaMode, launch: LtaMode, next: LtaMode): boolean {
  return next === "off" && (selected === "on" || launch === "on");
}

export function ltaNeedsRestart(selected: LtaMode, launch: LtaMode): boolean {
  return selected !== launch;
}

export function isLtaMode(v: unknown): v is LtaMode {
  return v === "off" || v === "shadow" || v === "on";
}

// ---- Features ---------------------------------------------------------------------------------

export interface FeatureRows {
  allOn: boolean;
  enabled: string[];
  note: string;
}

/** `/health` features: null (unset) means every feature is on. Read-only: no toggling here. */
export function featureRows(h: Health | null): FeatureRows {
  if (!h) return { allOn: false, enabled: [], note: "The backend did not answer, so the feature set is unknown." };
  if (h.features === null) return { allOn: true, enabled: [], note: "Every feature is on." };
  const enabled = h.features.slice().sort((a, b) => a.localeCompare(b));
  return { allOn: false, enabled, note: "A change to the feature set applies the next time the backend starts." };
}

// ---- Account / About ---------------------------------------------------------------------------

export function coreTrustLabel(t: CoreTrust): string {
  return t === "spawned" ? "Spawned by this app (identity verified)" : "Adopted (unverified): the app found a core already running and could not verify it started it";
}

export function coreTrustTone(t: CoreTrust): "ok" | "warning" {
  return t === "spawned" ? "ok" : "warning";
}

export const SIGN_OUT_TEXT = {
  title: "Sign out?",
  message: "You will be signed out of this app. Your chats, notes and settings stay on this computer and are there when you sign in again.",
} as const;

export function accountLine(me: Me | null): string {
  return me ? `${me.displayName} (${me.email})` : "Not signed in";
}

/** Plain-text diagnostics for support. Contains versions, states and paths only; every line also
 *  goes through the credential scrubber, and the account line carries no token. */
export function buildDiagnostics(info: DiagnosticsInfo, health: Health | null, me: Me | null, now: Date = new Date()): string {
  const lines = [
    `LLM-IDE diagnostics, ${now.toISOString()}`,
    `App version: ${info.appVersion}`,
    `Platform: ${info.platform}`,
    `Core: ${coreTrustLabel(info.coreTrust)}`,
    `Core log: ${info.coreLogPath ?? "not available"}`,
    `Backend status: ${health ? health.status : "no answer"}`,
    `API version: ${health ? health.apiVersion : "unknown"}`,
    `Schema version: ${health?.schemaVersion ?? "unknown"}`,
    `Features: ${health ? (health.features === null ? "all" : health.features.join(", ") || "none") : "unknown"}`,
    `Checks: ${health ? Object.entries(health.checks).map(([k, v]) => `${k}=${v ? "ok" : "fail"}`).join(", ") || "none" : "unknown"}`,
    `Signed in: ${me ? "yes" : "no"}`,
  ];
  return scrubSecrets(lines.join("\n"));
}
