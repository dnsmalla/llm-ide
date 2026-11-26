import { isPlanSkill } from "./factory.ts";
import type { ProgressEvent } from "./runner.ts";

// Display-only: which model an agent step will run on, resolved from Settings → Model routing (role "loop").
export interface RoutingTiers {
  tiers?: Record<string, { provider?: string; model?: string } | undefined>;
  featureStatus?: Record<string, { usable?: boolean; tier?: string } | undefined>;
}

export type RoutedRole = "loop" | "plan";

/** The routed model id for a role, or null when routing is unusable or unset (the engine default is unknown up front, so never guess). */
export function routedRoleModel(r: RoutingTiers | null | undefined, role: RoutedRole): string | null {
  const status = r?.featureStatus?.[role];
  if (!status?.usable || !status.tier) return null;
  const model = r?.tiers?.[status.tier]?.model;
  return typeof model === "string" && model.trim() ? model.trim() : null;
}

export function routedLoopModel(r: RoutingTiers | null | undefined): string | null {
  return routedRoleModel(r, "loop");
}

/** `claude-haiku-5-5` → `Haiku 5.5` (a trailing date stamp is dropped); any other id is shown as it is. */
export function modelLabel(id: string): string {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(id.trim());
  if (!m) return id;
  return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ""}`;
}

/** Which agent-backed phase is starting: an explicit repairModel wins only for repairs. */
export function stepModel(routed: string | null, phase: "step" | "repair", repairModel?: string | null): string | null {
  const id = phase === "repair" && repairModel ? repairModel : routed;
  return id ? modelLabel(id) : null;
}

/** Fetches routing once per run; any failure means no model is shown and never affects the run. */
export async function fetchRoutedModels(core: { request<T>(path: string, opts?: { timeoutMs?: number }): Promise<T> }): Promise<Record<RoutedRole, string | null>> {
  try {
    const r = await core.request<RoutingTiers>("/kb/routing-tiers", { timeoutMs: 5000 });
    return { loop: routedRoleModel(r, "loop"), plan: routedRoleModel(r, "plan") };
  } catch { return { loop: null, plan: null }; }
}

export interface ModelTracker {
  /** Feed every run progress event; returns the label of the running agent step (null for shell steps, finished steps or unknown routing). */
  onEvent(e: ProgressEvent): string | null;
  label(): string | null;
  /** Called when a late routing read relabels the step that is running. */
  onChange(listener: () => void): void;
}

/** Tracks which model the running agent step uses; routing is fetched once and never awaited by the run. */
export function createModelTracker(core: { request<T>(path: string, opts?: { timeoutMs?: number }): Promise<T> }, repairModel?: string | null): ModelTracker {
  let routed: Record<RoutedRole, string | null> = { loop: null, plan: null };
  // The agent phase running now, so a routing read that lands mid-step (always the first step) still labels it.
  let phase: "step" | "repair" | null = null;
  let role: RoutedRole = "loop";
  let current: string | null = null;
  let listener: (() => void) | null = null;
  const show = (p: "step" | "repair" | null, r: RoutedRole = "loop") => { phase = p; role = r; current = p ? stepModel(routed[r], p, repairModel) : null; };
  void fetchRoutedModels(core).then((m) => {
    routed = m;
    if (phase) { show(phase, role); listener?.(); }
  });
  return {
    label: () => current,
    onChange(fn) { listener = fn; },
    onEvent(e) {
      if (e.type === "stage-start") show(e.stage.kind === "skill" ? "step" : null, e.stage.kind === "skill" && isPlanSkill(e.stage.skillId) ? "plan" : "loop");
      else if (e.type === "stage-result" || e.type === "step-review-result") show(null);
      else if (e.type === "step-review") show("step");
      else if (e.type === "repair") show("repair");
      return current;
    },
  };
}
