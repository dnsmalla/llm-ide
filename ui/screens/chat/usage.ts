// Token usage labels as the Mac shows them (ClaudeLink `TokenCostPolicy` + `AgentV2Usage`, ChatMessageList): a reply's
// "billable" count weights cache writes at 1.25x and cache reads at 0.1x (output and fresh input stay 1x), so a warm
// turn does not look as expensive as a cold one. Pure; the screen renders the strings.

export interface UsageCounts {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

/** Validate a stored/live usage object; unknown or malformed counts are dropped rather than displayed as zero. */
export function decodeUsage(v: unknown): UsageCounts | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const n = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) && x >= 0 ? Math.floor(x) : null);
  const inputTokens = n(o.inputTokens), outputTokens = n(o.outputTokens), cacheReadTokens = n(o.cacheReadTokens);
  // The Mac's cacheCreationTokens is Int?: older files/events omit it and the Mac shows 0 cache writes.
  const creation = o.cacheCreationTokens === undefined || o.cacheCreationTokens === null ? 0 : n(o.cacheCreationTokens);
  return inputTokens === null || outputTokens === null || cacheReadTokens === null || creation === null
    ? null
    : { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens: creation };
}

export const CACHE_WRITE_MULTIPLIER = 1.25;
export const CACHE_READ_MULTIPLIER = 0.1;

/** Fresh-input-equivalent tokens for one turn (`TokenCostPolicy.billableTokens`). */
export function billableTokens(u: UsageCounts): number {
  return u.inputTokens + u.outputTokens + Math.round(u.cacheCreationTokens * CACHE_WRITE_MULTIPLIER + u.cacheReadTokens * CACHE_READ_MULTIPLIER);
}

/** Every token the turn processed, unweighted (`AgentV2Usage.processedTokens`). */
export function processedTokens(u: UsageCounts): number {
  return u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheCreationTokens;
}

/** The Mac's compact count: `1.2K`, `3.4M`, or the plain number below a thousand. */
export function compactTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/** The breakdown behind a reply's headline, naming each part's rate (`ChatMessageList.tokenUsageTooltip`). */
export function usageTooltip(u: UsageCounts): string {
  const parts = [`${u.inputTokens} in`, `${u.outputTokens} out`];
  if (u.cacheReadTokens > 0) parts.push(`${u.cacheReadTokens} cache read (×0.1)`);
  if (u.cacheCreationTokens > 0) parts.push(`${u.cacheCreationTokens} cache write (×1.25)`);
  parts.push(`${processedTokens(u)} processed in total`);
  return parts.join(" · ");
}

/** Two counts as one, field by field. */
export function addUsage(a: UsageCounts, b: UsageCounts): UsageCounts {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
  };
}

/** Several turns as one: every count summed (the weighting is linear). Null for no usages. */
export function sessionUsage(usages: readonly UsageCounts[]): UsageCounts | null {
  if (usages.length === 0) return null;
  return usages.reduce<UsageCounts>(addUsage, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 });
}

export interface ChatTotalLabel { text: string; title: string; ariaLabel: string }

/** The header's chat total. Counts come from live `usage` events and from persisted `metadata.tokenUsage` on
 *  history rows; when some loaded/unloaded replies have no count the label says the total covers part of the chat. */
export function chatTotalLabel(messages: readonly { role: string; status?: string; usage?: UsageCounts; costUsd?: number | null }[], hasMoreOlder: boolean): ChatTotalLabel | null {
  const replies = messages.filter((m) => m.role === "assistant" && m.status !== "streaming");
  const total = sessionUsage(replies.flatMap((m) => (m.usage ? [m.usage] : [])));
  if (!total) return null;
  const uncounted = replies.filter((m) => !m.usage).length;
  const partial = hasMoreOlder || uncounted > 0;
  const n = billableTokens(total);
  const cost = replies.reduce((sum, m) => sum + (typeof m.costUsd === "number" && m.costUsd > 0 ? m.costUsd : 0), 0);
  const costText = cost > 0 ? ` · $${cost.toFixed(2)}` : "";
  return partial
    ? { text: `${compactTokenCount(n)} tokens${costText}`, title: `Replies since this chat was opened (earlier replies have no count): ${usageTooltip(total)}`, ariaLabel: `Replies since this chat was opened used ${n} tokens` }
    : { text: `${compactTokenCount(n)} tokens${costText}`, title: `This chat: ${usageTooltip(total)}`, ariaLabel: `This chat used ${n} tokens` };
}
