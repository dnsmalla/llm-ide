// Pure mapping from host `core_status` (+ poll errors) to what the shell shows.
import type { CoreStatus } from "./host";
import type { StatusState } from "./status-store";

export type StatusLevel = "ok" | "busy" | "warn" | "error";

export interface StatusView {
  level: StatusLevel;
  /** Short text for the status bar. */
  label: string;
  /** Longer text (tooltip, core-down screen). Plain text only. */
  detail: string | null;
  /** True when the core cannot serve requests right now. */
  down: boolean;
  /** `fatal`: the host gave up restarting; only restarting the app helps. */
  fatal: boolean;
  /** Notice about a core we could not verify (adopted external server). */
  trustNotice: string | null;
  /** Shown when the user's `claude` CLI is missing; null otherwise. */
  claudeNotice: string | null;
}

const seconds = (ms: number | null): string => (ms === null ? "" : ` in ${Math.max(1, Math.ceil(ms / 1000))} s`);

export function deriveStatusView(state: StatusState): StatusView {
  const s: CoreStatus | null = state.status;
  const claudeNotice = s?.claude === "missing" ? (s.claude_notice ?? "Claude Code was not found. Install it to use chat.") : null;
  const trustNotice = s && s.trust === "adopted_unverified" ? (s.notice ?? "Connected to an external core that could not be verified.") : null;

  if (!s) {
    return {
      level: state.pollError ? "error" : "busy",
      label: state.pollError ? "Host not responding" : "Starting core…",
      detail: state.pollError,
      down: true,
      fatal: false,
      trustNotice,
      claudeNotice,
    };
  }
  if (state.pollError !== null) {
    return { level: "error", label: "Host not responding", detail: state.pollError, down: true, fatal: false, trustNotice, claudeNotice };
  }
  switch (s.state) {
    case "ready":
      return {
        level: trustNotice ? "warn" : "ok",
        label: s.adopted ? "Core ready (external)" : "Core ready",
        detail: trustNotice,
        down: false,
        fatal: false,
        trustNotice,
        claudeNotice,
      };
    case "starting":
      return { level: "busy", label: "Starting core…", detail: null, down: true, fatal: false, trustNotice, claudeNotice };
    case "restarting":
      return {
        level: "busy",
        label: `Restarting core${seconds(s.restart_in_ms)}`,
        detail: s.error ?? "The core stopped unexpectedly and is being restarted.",
        down: true,
        fatal: false,
        trustNotice,
        claudeNotice,
      };
    case "failed":
    default:
      return {
        level: "error",
        label: s.fatal ? "Core crashed repeatedly" : "Core failed",
        detail: s.error ?? (s.fatal ? "The core crashed too often and will not be restarted." : "The core could not be started."),
        down: true,
        fatal: s.fatal,
        trustNotice,
        claudeNotice,
      };
  }
}

/** Equality for selectors that return a `StatusView`. */
export function statusViewEqual(a: StatusView, b: StatusView): boolean {
  return (
    a.level === b.level && a.label === b.label && a.detail === b.detail && a.down === b.down && a.fatal === b.fatal && a.trustNotice === b.trustNotice && a.claudeNotice === b.claudeNotice
  );
}
