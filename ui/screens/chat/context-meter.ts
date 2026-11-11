// The composer's context-window meter, ported from the Mac (`ContextUsagePresentation`, `ChatComposer.contextUsageChip`).
// Pure: names and kinds are the SDK's own, so a category a newer SDK adds is listed as it arrives.
import type { ContextCategory } from "./events";

export interface ContextUsage { totalTokens: number; maxTokens: number; percentage: number; categories: readonly ContextCategory[] }

/** From this percentage the meter turns to the warning colour. */
export const CONTEXT_WARN_PERCENT = 80;

export const contextWarns = (u: ContextUsage): boolean => u.percentage >= CONTEXT_WARN_PERCENT;
/** From here the popover suggests a fresh chat: cost grows with every re-sent token. */
export const CONTEXT_ADVICE_PERCENT = 65;
export const contextAdvises = (u: ContextUsage): boolean => u.percentage >= CONTEXT_ADVICE_PERCENT;
export const contextPercentLabel = (u: ContextUsage): string => `${u.percentage}%`;
export const contextTokensLabel = (u: ContextUsage): string => `${u.totalTokens.toLocaleString("en-US")} / ${u.maxTokens.toLocaleString("en-US")} tokens`;

/** "used" rows first, then the rest (free space, buffers), each in the SDK's order. */
export function contextRows(u: ContextUsage): { used: ContextCategory[]; other: ContextCategory[] } {
  return { used: u.categories.filter((c) => c.kind === "used"), other: u.categories.filter((c) => c.kind !== "used") };
}

/** A category's share of the window with one decimal ("0.2%"); "–" without a window size. */
export function contextShare(c: ContextCategory, u: ContextUsage): string {
  return u.maxTokens > 0 ? `${((c.tokens / u.maxTokens) * 100).toFixed(1)}%` : "–";
}
