import { useCallback, useState } from 'react';
import {
  analyzeRisks,
  codeSyncPlan,
  generatePlan as apiGeneratePlan,
  getPlan as apiGetPlan,
  savePlan as apiSavePlan,
  updateTask as apiUpdateTask,
} from '../../lib/kb';
import type { Plan, PlanTask, RiskLevel, TaskStatus } from '../../lib/plan';

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
  const [isGenerating, setIsGenerating] = useState(false);
  const [busyAction, setBusyAction] = useState<null | 'risk' | 'code'>(null);
  const [error, setError] = useState<string | null>(null);

  const generate = useCallback(
    async (
      meetingId: string,
      opts: { goal?: string; language?: string; skipRisk?: boolean; skipCodeSync?: boolean } = {},
    ) => {
      if (!meetingId) {
        setError('Meeting must be ingested into KB before planning. Run "Extract Actions" first.');
        return;
      }
      setIsGenerating(true);
      setError(null);
      try {
        const result = await apiGeneratePlan({ meetingId, ...opts });
        setPlan(result);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Plan generation failed');
      } finally {
        setIsGenerating(false);
      }
    },
    [],
  );

  const reanalyzeRisks = useCallback(
    async (language?: string) => {
      if (!plan) return;
      setBusyAction('risk');
      setError(null);
      try {
        const updated = await analyzeRisks({ planId: plan.id, language });
        setPlan(updated);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Risk analysis failed');
      } finally {
        setBusyAction(null);
      }
    },
    [plan],
  );

  const refreshCodeSync = useCallback(async () => {
    if (!plan) return;
    setBusyAction('code');
    setError(null);
    try {
      const updated = await codeSyncPlan({ planId: plan.id });
      setPlan(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Code-sync failed');
    } finally {
      setBusyAction(null);
    }
  }, [plan]);

  const setTaskStatus = useCallback(async (taskId: string, status: TaskStatus) => {
    let prevStatus: TaskStatus | undefined;
    setPlan((prev) => {
      if (!prev) return prev;
      const task = prev.tasks.find((t) => t.id === taskId);
      if (task) prevStatus = task.status;
      return { ...prev, tasks: prev.tasks.map((t) => (t.id === taskId ? { ...t, status } : t)) };
    });
    try {
      await apiUpdateTask(taskId, { status });
    } catch {
      if (prevStatus !== undefined) {
        setPlan((prev) =>
          prev
            ? {
                ...prev,
                tasks: prev.tasks.map((t) => (t.id === taskId ? { ...t, status: prevStatus! } : t)),
              }
            : prev,
        );
      }
    }
  }, []);

  const setTaskRisk = useCallback(async (taskId: string, risk: RiskLevel | null) => {
    let prevRisk: RiskLevel | null | undefined;
    setPlan((prev) => {
      if (!prev) return prev;
      const task = prev.tasks.find((t) => t.id === taskId);
      if (task) prevRisk = task.risk;
      return { ...prev, tasks: prev.tasks.map((t) => (t.id === taskId ? { ...t, risk } : t)) };
    });
    try {
      await apiUpdateTask(taskId, { risk });
    } catch {
      if (prevRisk !== undefined) {
        setPlan((prev) =>
          prev
            ? {
                ...prev,
                tasks: prev.tasks.map((t) => (t.id === taskId ? { ...t, risk: prevRisk! } : t)),
              }
            : prev,
        );
      }
    }
  }, []);

  const clearPlan = useCallback(() => {
    setPlan(null);
    setError(null);
  }, []);

  // Helper for the Plan tab to pre-render an empty plan from a passed-in
  // PlanSummary (e.g. when the user clicks an item in History).
  const loadPlan = useCallback((p: Plan) => {
    setPlan(p);
    setError(null);
  }, []);

  // Refresh the current plan from the server — used after operations
  // that mutate task meta out-of-band (dispatch, codegen) so per-task
  // chips reflect the latest state without forcing a re-plan.
  const refresh = useCallback(async () => {
    if (!plan) return;
    const fresh = await apiGetPlan(plan.id);
    if (fresh) setPlan(fresh);
  }, [plan]);

  // LLM-free stub creation.  Used when the user starts recording
  // without first generating a plan — gives the agent something to
  // ground in (so it can attach and start drafting questions) even
  // before a meeting transcript exists.  Title is generic; user can
  // rename via the agent toggle bar or the Plan tab.
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

  // Inline rename — used by the agent toggle bar's ✎ editor.  Posts
  // the full plan back via /kb/plan/save which is an upsert.  Updates
  // local state optimistically so the UI feels snappy.
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
        setPlan(plan); // rollback
        setError(err instanceof Error ? err.message : 'Rename failed');
        return null;
      }
    },
    [plan],
  );

  return {
    plan,
    isGenerating,
    busyAction,
    error,
    generate,
    reanalyzeRisks,
    refreshCodeSync,
    setTaskStatus,
    setTaskRisk,
    clearPlan,
    loadPlan,
    refresh,
    createStub,
    rename,
  };
}

export type { PlanTask };
