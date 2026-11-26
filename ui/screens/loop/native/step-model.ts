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
