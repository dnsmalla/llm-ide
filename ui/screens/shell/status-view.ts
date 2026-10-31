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
  /** Extra plain-language explanations (foreign :3456 server, busy ports). */
  hints: StatusHint[];
}

/** A plain-language explanation with an optional command to COPY. The app never runs or offers to run it. */
export interface StatusHint {
  id: "foreign_core" | "ports_busy";
  level: "info" | "warn";
  text: string;
  /** Text to copy into a terminal; `null` when there is nothing to run. */
  command: string | null;
}

const SAFE_COMMAND = /^[\w .+@-]{1,48}$/;

/** Hints derived from `foreign_core` / `error_code` (no paths, no secrets; every number is validated by `normalizeCoreStatus`). */
export function deriveHints(s: CoreStatus | null): StatusHint[] {
  if (!s) return [];
  const out: StatusHint[] = [];
  const f = s.foreign_core;
  if (f && f.detected && !s.adopted) {
    const who = f.pid !== null ? ` (pid ${f.pid}${f.command && SAFE_COMMAND.test(f.command) ? `, ${f.command}` : ""})` : "";
    const stop = f.pid !== null ? ` You can leave it or stop it with: kill ${f.pid}` : ` To see what it is, run: lsof -nP -iTCP:${f.port} -sTCP:LISTEN`;
    out.push({
      id: "foreign_core",
      level: "info",
      text: `Another LLM-IDE server is running on port ${f.port}${who}. It is not used by this app.${stop}`,
      command: f.pid !== null ? `kill ${f.pid}` : `lsof -nP -iTCP:${f.port} -sTCP:LISTEN`,
    });
  }
  if (s.state === "failed" && s.error_code === "ports_busy") {
    const ports = s.ports_tried.length > 0 ? [...s.ports_tried].sort((a, b) => a - b) : [3457, 3458, 3459];
    const range = ports.length > 1 ? `${ports[0]}-${ports[ports.length - 1]}` : String(ports[0]);
    out.push({
      id: "ports_busy",
      level: "warn",
      text: `Ports ${range} are busy: free one of them or restart. To see what holds them, run: lsof -nP -iTCP:${range} -sTCP:LISTEN`,
      command: `lsof -nP -iTCP:${range} -sTCP:LISTEN`,
    });
  }
  return out;
}

const seconds = (ms: number | null): string => (ms === null ? "" : ` in ${Math.max(1, Math.ceil(ms / 1000))} s`);

export function deriveStatusView(state: StatusState): StatusView {
  const s: CoreStatus | null = state.status;
  const claudeNotice = s?.claude === "missing" ? (s.claude_notice ?? "Claude Code was not found. Install it to use chat.") : null;
  const hints = deriveHints(s);
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
      hints,
    };
  }
  if (state.pollError !== null) {
    return { level: "error", label: "Host not responding", detail: state.pollError, down: true, fatal: false, trustNotice, claudeNotice, hints };
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
        hints,
      };
    case "starting":
      return { level: "busy", label: "Starting core…", detail: null, down: true, fatal: false, trustNotice, claudeNotice, hints };
    case "restarting":
      return {
        level: "busy",
        label: `Restarting core${seconds(s.restart_in_ms)}`,
        detail: s.error ?? "The core stopped unexpectedly and is being restarted.",
        down: true,
        fatal: false,
        trustNotice,
        claudeNotice,
        hints,
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
        hints,
      };
  }
}

/** Equality for selectors that return a `StatusView`. */
export function statusViewEqual(a: StatusView, b: StatusView): boolean {
  return (
    a.level === b.level && a.label === b.label && a.detail === b.detail && a.down === b.down && a.fatal === b.fatal && a.trustNotice === b.trustNotice && a.claudeNotice === b.claudeNotice && hintsEqual(a.hints, b.hints)
  );
}

function hintsEqual(a: StatusHint[], b: StatusHint[]): boolean {
  return a.length === b.length && a.every((h, i) => h.id === b[i].id && h.text === b[i].text && h.command === b[i].command && h.level === b[i].level);
}
