import { useCallback, useState } from 'react';
import { savePlan as apiSavePlan } from '../../lib/kb';
import type { Plan } from '../../lib/plan';

/** Sensible default title for the "auto-stub on record" flow.  Includes
 *  the date so multiple stubs are distinguishable in the History view.
 *  User can rename inline via the agent toggle bar. */
function defaultStubTitle(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `Untitled meeting — ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function usePlan() {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [error, setError] = useState<string | null>(null);

  const clearPlan = useCallback(() => {
    setPlan(null);
    setError(null);
  }, []);

  const createStub = useCallback(async (opts: { goal?: string; language?: string } = {}) => {
    try {
      const stub = await apiSavePlan({
        title: defaultStubTitle(),
        goal: opts.goal ?? 'Capture key topics, decisions, and action items from this conversation.',
        language: opts.language,
        tasks: [],
      });
      setPlan(stub);
      return stub;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create plan');
      return null;
    }
  }, []);

  const rename = useCallback(
    async (newTitle: string) => {
      if (!plan) return null;
      const trimmed = newTitle.trim().slice(0, 500);
      if (!trimmed || trimmed === plan.title) return plan;
      const optimistic = { ...plan, title: trimmed };
      setPlan(optimistic);
      try {
        const saved = await apiSavePlan({
          id: plan.id,
          title: trimmed,
          goal: plan.goal ?? undefined,
          language: plan.language ?? undefined,
          tasks: plan.tasks,
        });
        setPlan(saved);
        return saved;
      } catch (err) {
        setPlan(plan);
        setError(err instanceof Error ? err.message : 'Rename failed');
        return null;
      }
    },
    [plan],
  );

  return {
    plan,
    error,
    clearPlan,
    createStub,
    rename,
  };
}
