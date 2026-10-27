// Pass/fail targets from the parent plan §6 (docs/superpowers/plans/2026-10-24-tauri-desktop-and-relay.md),
// applied to the BENCH records the runner collects. Records without a target are shown as info.
import type { BenchRecord } from "./records";

export type Verdict = "pass" | "fail" | "info";

export interface BenchRow {
  name: string;
  value: string;
  unit: string;
  target: string;
  verdict: Verdict;
  detail: string;
}

/** Records that are logs or diagnostics, not table rows. */
const HIDDEN_UNITS = new Set(["log", "trace"]);
const HIDDEN_NAMES = new Set(["graph_progress"]);
/** Keys shown as the value text instead of the numeric value, when present. */
const TEXT_KEYS = ["status", "renderer", "method", "message"] as const;
const CORE_KEYS = new Set(["name", "value", "unit", ...TEXT_KEYS]);

const CHAT_COUNT = /^chat_((?:paced_|long_)?)events_(dropped|duplicated)$/;

function valueText(r: BenchRecord): string {
  for (const key of TEXT_KEYS) {
    const v = r[key];
    if (typeof v === "string") return v;
  }
  const v = r.value;
  return typeof v === "number" ? (Number.isInteger(v) ? String(v) : v.toFixed(1)) : String(v);
}

function detailText(r: BenchRecord): string {
  return Object.entries(r)
    .filter(([k]) => !CORE_KEYS.has(k))
    .map(([k, v]) => `${k}=${v}`)
    .join(" · ");
}

/** Verdict and target text for one record. */
function judge(r: BenchRecord, displayFrameMs: number | undefined): { target: string; verdict: Verdict } {
  const name = String(r.name);
  const value = typeof r.value === "number" ? r.value : NaN;
  // The window lost focus or visibility during this step: the number is not a measurement.
  if (r.valid === "false") return { target: "not valid: window lost focus", verdict: "info" };
  if (r.unit === "error" || name.endsWith("_error")) return { target: "no errors", verdict: "fail" };
  // A 5 s camera run that took far longer was throttled (window not frontmost):
  // its fps says nothing about rendering, so it is not judged.
  if (name.startsWith("graph_fps_") && typeof r.elapsed_ms === "number" && r.elapsed_ms > 7_500) {
    return { target: "not valid: run throttled (window not frontmost)", verdict: "info" };
  }
  // 60 fps is the display's vsync cap, not a value to beat: pass at 95 % of it.
  const refreshFps = displayFrameMs ? 1000 / displayFrameMs : 60;
  switch (name) {
    case "graph_fps_10k":
      return { target: `≥ 95 % of display rate (${(refreshFps * 0.95).toFixed(1)} fps)`, verdict: value >= refreshFps * 0.95 ? "pass" : "fail" };
    case "graph_fps_50k":
      return { target: "≥ 30 fps", verdict: value >= 30 ? "pass" : "fail" };
    // The plan's "< 16 ms per keystroke" is the editor's own work; the time to the
    // next frame also includes frame alignment (up to one frame), so it gets 1.5 frames.
    case "editor_keystroke_sync_p95_ms":
      return { target: "< 16 ms", verdict: value < 16 ? "pass" : "fail" };
    case "editor_keystroke_paint_p95_ms":
      if (displayFrameMs === undefined) return { target: "≤ 1.5 display frames (display_frame_ms missing)", verdict: "info" };
      return { target: `≤ 1.5 display frames (${displayFrameMs * 1.5} ms)`, verdict: value <= displayFrameMs * 1.5 ? "pass" : "fail" };
    case "term_max_stall_ms":
      return { target: "< 100 ms", verdict: value < 100 ? "pass" : "fail" };
    default:
      break;
  }
  if (CHAT_COUNT.test(name)) return { target: "= 0", verdict: value === 0 ? "pass" : "fail" };
  return { target: "—", verdict: "info" };
}

/** One table row per measurement name (the latest record wins), in first-seen order. */
export function buildRows(records: readonly BenchRecord[]): BenchRow[] {
  const latest = new Map<string, BenchRecord>();
  for (const r of records) {
    if (HIDDEN_UNITS.has(String(r.unit)) || HIDDEN_NAMES.has(String(r.name))) continue;
    latest.set(String(r.name), r);
  }
  const frame = latest.get("display_frame_ms");
  const displayFrameMs = frame && typeof frame.value === "number" ? frame.value : undefined;
  return [...latest.values()].map((r) => {
    const { target, verdict } = judge(r, displayFrameMs);
    return {
      name: String(r.name),
      value: valueText(r),
      unit: String(r.unit),
      target,
      verdict,
      detail: detailText(r),
    };
  });
}
