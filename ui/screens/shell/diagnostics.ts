// Diagnostics: a small in-memory ring buffer of core request OUTCOMES plus a plain-text report for support.
//
// What is recorded (and nothing else): method, path with the query stripped and id-looking segments replaced by
// ":id", the HTTP status or the CoreError code, the duration, a timestamp, and the trust state at the time.
// NEVER recorded: bodies, headers, tokens, full URLs, user ids, server error text. The buffer lives in memory only.
import type { CoreStatus } from "./host";

export const DIAGNOSTICS_CAPACITY = 50;

export interface RequestOutcome {
  method: string;
  /** Query stripped, ids replaced by `:id`. */
  path: string;
  /** HTTP status, or 0 when the request never got an answer. */
  status: number;
  /** HTTP status as text (`200`) or a CoreError code (`NETWORK`, `UNTRUSTED_CORE`...). */
  result: string;
  ms: number;
  at: number;
  /** Trust state when the request ended (`spawned`, `pending`, `adopted_unverified`, `none`). */
  trust: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LONG_HEX = /^[0-9a-f]{12,}$/i;
const LONG_NUM = /^\d{6,}$/;
const OPAQUE = /^[A-Za-z0-9_-]{24,}$/;

/** Path without query/fragment; segments that look like ids (UUID, long hex, long digits, long opaque tokens) become `:id`. */
export function scrubPath(path: string): string {
  const bare = path.split(/[?#]/, 1)[0] ?? "";
  const clipped = bare.length > 200 ? bare.slice(0, 200) : bare;
  return clipped
    .split("/")
    .map((seg) => {
      let s = seg;
      try {
        s = decodeURIComponent(seg);
      } catch {
        // keep as is
      }
      return UUID.test(s) || LONG_HEX.test(s) || LONG_NUM.test(s) || OPAQUE.test(s) || s.includes("@") ? ":id" : seg.replace(/[^\w.:~%-]/g, "_");
    })
    .join("/");
}

export interface DiagnosticsLog {
  record(o: Omit<RequestOutcome, "path"> & { path: string }): void;
  entries(): readonly RequestOutcome[];
  clear(): void;
  subscribe(l: () => void): () => void;
  /** Changes on every record/clear (for `useSyncExternalStore`). */
  version(): number;
}

export function createDiagnosticsLog(capacity = DIAGNOSTICS_CAPACITY): DiagnosticsLog {
  let items: RequestOutcome[] = [];
  let v = 0;
  const ls = new Set<() => void>();
  const fire = () => {
    v++;
    for (const l of [...ls]) l();
  };
  return {
    record(o) {
      items = [...items, { ...o, path: scrubPath(o.path), method: o.method.toUpperCase().slice(0, 8) }].slice(-capacity);
      fire();
    },
    entries: () => items,
    clear() {
      items = [];
      fire();
    },
    subscribe(l) {
      ls.add(l);
      return () => ls.delete(l);
    },
    version: () => v,
  };
}

/** The process-wide log the core client records into. */
export const diagnosticsLog: DiagnosticsLog = createDiagnosticsLog();

export interface ReportInput {
  status: CoreStatus | null;
  signedIn: boolean;
  appVersion: string;
  /** Verification of the launch nonce is not exposed by the host; `spawned` means the host verified it. */
  entries: readonly RequestOutcome[];
  now?: number;
}

const portOf = (url: string): string => {
  try {
    return new URL(url).port || "?";
  } catch {
    return "?";
  }
};

/** Plain text, already scrubbed: safe to paste into a bug report. */
export function buildDiagnosticsReport(i: ReportInput): string {
  const s = i.status;
  const lines: string[] = ["LLM-IDE desktop diagnostics", `App version: ${i.appVersion}`, `Signed in: ${i.signedIn ? "yes" : "no"}`];
  if (!s) lines.push("Core: no status from the host yet");
  else {
    lines.push(
      `Core state: ${s.state}${s.fatal ? " (fatal)" : ""}`,
      `Core port: ${s.url ? portOf(s.url) : "none"}`,
      `Core trust: ${s.trust}`,
      `Launch nonce verified: ${s.trust === "spawned" ? "yes" : "no"}`,
      `Adopted external core: ${s.adopted ? "yes" : "no"}`,
      `Foreign server on :3456: ${s.foreign_core?.detected ? "yes" : "no"}`,
      `Restarts: ${s.restarts}`,
      `Claude Code: ${s.claude}`,
      `Core log: ${s.core_log_path ?? "not available"}`,
    );
    if (s.error_code) lines.push(`Error code: ${s.error_code}`);
  }
  lines.push("", `Last ${i.entries.length} core requests (oldest first):`);
  const t0 = i.now ?? Date.now();
  for (const e of i.entries) {
    const ago = Math.max(0, Math.round((t0 - e.at) / 1000));
    lines.push(`${ago}s ago  ${e.method} ${e.path}  ${e.result}  ${e.ms}ms  trust=${e.trust}`);
  }
  if (i.entries.length === 0) lines.push("(none)");
  return lines.join("\n");
}
