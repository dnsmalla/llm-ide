// Display-only: which model an agent step will run on, resolved from Settings → Model routing (role "loop").
export interface RoutingTiers {
  tiers?: Record<string, { provider?: string; model?: string } | undefined>;
  featureStatus?: Record<string, { usable?: boolean; tier?: string } | undefined>;
}

/** The routed model id for the Loop role, or null when routing is unusable or unset (the engine default is unknown up front, so never guess). */
export function routedLoopModel(r: RoutingTiers | null | undefined): string | null {
  const status = r?.featureStatus?.loop;
  if (!status?.usable || !status.tier) return null;
  const model = r?.tiers?.[status.tier]?.model;
  return typeof model === "string" && model.trim() ? model.trim() : null;
}

/** Which agent-backed phase is starting: an explicit repairModel wins only for repairs. */
export function stepModel(routed: string | null, phase: "step" | "repair", repairModel?: string | null): string | null {
  return phase === "repair" && repairModel ? repairModel : routed;
}

/** Fetches routing once per run; any failure means no model is shown and never affects the run. */
export async function fetchRoutedLoopModel(core: { request<T>(path: string, opts?: { timeoutMs?: number }): Promise<T> }): Promise<string | null> {
  try { return routedLoopModel(await core.request<RoutingTiers>("/kb/routing-tiers", { timeoutMs: 5000 })); } catch { return null; }
}
