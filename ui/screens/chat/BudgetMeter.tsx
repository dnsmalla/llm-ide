// The per-chat token budget the core reports with a `session_budget` notice. Hidden until a turn reports one.
import type { SessionBudget } from "./state";

export function budgetPercent(b: SessionBudget): number {
  return b.limit > 0 ? Math.min(100, Math.max(0, Math.round((b.used / b.limit) * 100))) : 0;
}

export function budgetLabel(b: SessionBudget): string {
  return `${budgetPercent(b)}% budget`;
}

export function BudgetMeter({ budget }: { budget: SessionBudget | null }) {
  if (!budget) return null;
  const pct = budgetPercent(budget);
  const warn = pct >= 80 || budget.level === "warning" || budget.level === "exceeded";
  return (
    <span className="chat-budget" data-warn={warn || undefined} title={`Token budget: ${budget.used.toLocaleString("en-US")} used of ${budget.limit.toLocaleString("en-US")} · ${budget.remaining.toLocaleString("en-US")} left`}>
      {budgetLabel(budget)}
    </span>
  );
}
