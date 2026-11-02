// Model & Limits helpers: the server's per-user model chain and caps (extension/kb/usage.mjs, routes at
// /kb/usage/*). The server is the source of truth; these functions only shape requests and decide what a run may do.
export type UsageUnit = "runs" | "tokens";
export type UsageWindow = "daily" | "monthly";

export interface ChainRow {
  provider: string; model: string; label: string; priority: number; enabled: boolean;
  limit_value: number; unit: UsageUnit; window_kind: UsageWindow; threshold_pct: number; custom: boolean;
}
export interface SummaryRow {
  model: string; label: string; enabled: boolean; custom: boolean; priority: number; unit: UsageUnit; window_kind: UsageWindow;
  limit: number; threshold_pct: number; used: number; pct: number | null; state: "ok" | "warning" | "exhausted"; quota: boolean; resetAt: string;
}
export interface Resolve { provider: string; model: string | null; status: "ok" | "degraded" | "paused" | "unconfigured"; engaged?: boolean; reason?: string; resetAt?: string | null }
export interface Summary { providers: Record<string, { active: Resolve; models: SummaryRow[] }> }
export interface RateBucket { limit: string | null; remaining: string | null; reset: string | null }
export interface RateSnapshot { capturedAt: string; provider: string; model: string | null; requests: RateBucket | null; tokens: RateBucket | null; inputTokens: RateBucket | null; outputTokens: RateBucket | null }

/** What the runner may do with the server's answer. A paused chain stops the run (the caps must not be exceeded);
 *  an inert chain (no caps set, no quota flag) changes nothing, so the run keeps its default model. */
export type RunDecision = { proceed: true; model?: string; warning?: string } | { proceed: false; notice: string };
export function runDecision(r: Resolve): RunDecision {
  if (r.status === "paused") {
    const when = r.resetAt ? ` Resets ${r.resetAt}.` : "";
    return { proceed: false, notice: `${r.reason ?? "Every model for this provider has reached its limit; the task did not run."}${when}` };
  }
  if (r.engaged && r.model) return { proceed: true, model: r.model };
  return { proceed: true };
}

/** Ask the server once per run. Mac parity (`resolveModelForRun`): a resolver error never blocks automation, the
 *  run proceeds with the default model, but the desktop says so in the log instead of hiding it. */
export async function decideRun(resolve: () => Promise<Resolve>): Promise<RunDecision> {
  let r: Resolve;
  try { r = await resolve(); } catch (e) {
    return { proceed: true, warning: `Model limits could not be checked (${e instanceof Error ? e.message : String(e)}); running with the default model.` };
  }
  return runDecision(r);
}

/** Move a chain row up or down and renumber priorities (lower runs first), keeping the order the server returns. */
export function moveRow(rows: ChainRow[], index: number, delta: -1 | 1): ChainRow[] {
  const to = index + delta;
  if (to < 0 || to >= rows.length) return rows;
  const next = [...rows];
  [next[index], next[to]] = [next[to], next[index]];
  return next.map((r, i) => ({ ...r, priority: i }));
}

/** The PUT /kb/usage/limits body for one provider. The server replaces that provider's rows in full. */
export function limitsBody(provider: string, rows: ChainRow[]): { chains: Record<string, unknown[]> } {
  return {
    chains: {
      [provider]: rows.map((r, i) => ({
        model: r.model, priority: i, enabled: r.enabled, limit_value: Math.max(0, Number.isFinite(r.limit_value) ? Math.floor(r.limit_value) : 0),
        unit: r.unit, window_kind: r.window_kind, threshold_pct: Math.min(100, Math.max(1, Number.isFinite(r.threshold_pct) ? Math.floor(r.threshold_pct) : 90)),
      })),
    },
  };
}

/** "3 / 10 runs" or "No cap" for display. */
export function meterText(used: number, limit: number, unit: UsageUnit): string {
  return limit > 0 ? `${used} / ${limit} ${unit}` : `${used} ${unit} (no cap)`;
}

/** The providers a Save writes: only those the user changed, with rows. Writing an untouched provider would turn its
 *  built-in chain into stored overrides (the server replaces a supplied provider's rows in full). */
export function providersToSave(rows: Record<string, ChainRow[]>, dirty: ReadonlySet<string>): Array<[string, ChainRow[]]> {
  return Object.entries(rows).filter(([p, list]) => dirty.has(p) && list.length > 0);
}

/** The resolve request for a provider. `prefer` is the user's model: the chain starts there and only steps down when it
 *  is constrained (the Mac's `resolveUsageModel(prefer:)`). */
export function resolvePath(provider: string, prefer?: string | null): string {
  const q = new URLSearchParams({ provider });
  if (prefer) q.set("prefer", prefer);
  return `/kb/usage/resolve?${q.toString()}`;
}
