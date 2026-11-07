// Settings → Self-Heal (debug desktop builds only). Plan A: the incidents the app recorded, most recent first, with
// Ignore, Refresh and Clear all. Plan B: Try to fix (one manual agent run in a git worktree of the source checkout,
// then make test and make regression there) and the proposals it leaves: Review the diff, Apply it to the checkout (never a commit)
// or Discard it. Text is shown as text, never run or sent.
import { useCallback, useEffect, useState } from "react";
import { useEnv } from "../context.tsx";
import { ApiError, call } from "../core-api.ts";
import type { SelfHealDiff } from "../host.ts";
import { Button, ErrorText } from "../ui.tsx";
import { SOURCE_TEXT, STATUS_TEXT, decodeIncidents, incidentSummary, isTestFile, proposalsOf, type IncidentView } from "../self-heal-model.ts";
import { COST_TEXT, STEP_TEXT, resetSelfHealRun, runSelfHealFix, type RunStep } from "../self-heal-run.ts";

const BASE = "/kb/self-heal/incidents";
const why = (e: unknown): string => (e instanceof ApiError ? e.code : e instanceof Error ? e.message : String(e)).slice(0, 300);

export default function SelfHealSection() {
  const { client, host } = useEnv();
  const sh = host.selfHeal;
  const [items, setItems] = useState<IncidentView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState<string | null>(null);
  const [step, setStep] = useState<RunStep | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [stuckRun, setStuckRun] = useState<string | null>(null);
  const [review, setReview] = useState<(SelfHealDiff & { runId: string }) | null>(null);
  const load = useCallback(async () => {
    try {
      setItems(decodeIncidents(await call(client, "GET", BASE)));
      setError(null);
    } catch {
      setError("Could not read the incidents. Check that the backend is running and you are signed in.");
    }
  }, [client]);
  useEffect(() => {
    void load();
  }, [load]);
  const act = async (method: "POST" | "DELETE", path: string) => {
    setBusy(true);
    try {
      await call(client, method, path);
      await load();
    } catch {
      setError("That did not work. Try again.");
    } finally {
      setBusy(false);
      setArmed(null);
    }
  };
  const tryFix = async () => {
    if (!sh) return;
    setBusy(true);
    setResult(null);
    setError(null);
    setStuckRun(null);
    try {
      setResult((await runSelfHealFix(client, sh, setStep)).message);
    } catch (e) {
      if (e instanceof ApiError && e.code === "RUN_ACTIVE" && typeof e.details?.runId === "string") setStuckRun(e.details.runId);
      setError(`Try to fix did not start: ${why(e)}`);
    } finally {
      setStep(null);
      setBusy(false);
      await load();
    }
  };
  const reset = async () => {
    if (!sh || !stuckRun) return;
    setBusy(true);
    try {
      await resetSelfHealRun(client, sh, stuckRun);
      setStuckRun(null);
      setError(null);
    } catch (e) {
      setError(`Reset did not work: ${why(e)}`);
    } finally {
      setBusy(false);
      await load();
    }
  };
  const openReview = async (runId: string) => {
    if (!sh) return;
    setBusy(true);
    try {
      setReview({ runId, ...(await sh.diff(runId)) });
    } catch (e) {
      setError(`Could not read the proposal: ${why(e)}`);
    } finally {
      setBusy(false);
    }
  };
  const resolve = async (kind: "apply" | "discard", runId: string) => {
    if (!sh) return;
    setBusy(true);
    try {
      if (kind === "apply") {
        if (!review || review.runId !== runId) throw new Error("Open the fix with Review first.");
        await sh.apply(runId, review.patchId);
      } else {
        await sh.remove(runId);
      }
      await call(client, "POST", `/kb/self-heal/runs/${runId}/resolve`, { result: kind === "apply" ? "applied" : "discarded" });
      setResult(kind === "apply" ? "Applied to your checkout, not committed. Review and commit it in Source Control." : "Proposal discarded.");
      setReview(null);
    } catch (e) {
      setError(`${kind === "apply" ? "Apply" : "Discard"} did not work: ${why(e)}`);
    } finally {
      setArmed(null);
      setBusy(false);
      await load();
    }
  };
  const confirm = (key: string, label: string, run: () => void, tone: "primary" | "danger", disabled = false) =>
    armed === key ? (
      <Button tone={tone} disabled={busy} onClick={run}>{`Confirm: ${label}`}</Button>
    ) : (
      <Button tone={tone} disabled={busy || disabled} onClick={() => setArmed(key)}>{`${label}...`}</Button>
    );
  const busyRow = (i: IncidentView) => i.status === "fixing" || i.status === "proposed";
  const proposals = items ? proposalsOf(items) : [];
  const canFix = !busy && items !== null && items.some((i) => i.status === "new" && i.environmental === null);

  return (
    <div className="st-stack">
      <p className="st-hint">{COST_TEXT}</p>
      <div className="st-row">
        {sh ? <Button tone="primary" disabled={!canFix} onClick={() => void tryFix()}>Try to fix</Button> : null}
        <Button disabled={busy} onClick={() => void load()}>Refresh</Button>
        {confirm("clear", "Clear all", () => void act("DELETE", BASE), "danger", !items || items.length === 0)}
      </div>
      {sh ? null : <p className="st-hint">Try to fix needs the desktop app.</p>}
      {step ? <p className="st-hint" role="status">{STEP_TEXT[step]}</p> : null}
      {result ? <p className="st-hint" role="status">{result}</p> : null}
      {stuckRun ? <Button disabled={busy} onClick={() => void reset()}>Reset the interrupted run</Button> : null}
      <ErrorText text={error} />
      {proposals.length > 0 ? (
        <section className="st-stack" aria-label="Proposed fixes">
          {proposals.map((p) => (
            <div key={p.runId} className="st-note">
              <p className="st-label">Fix proposed for {p.incidentIds.length} incident{p.incidentIds.length === 1 ? "" : "s"}</p>
              {p.notes.map((n, k) => <p key={k}>{n}</p>)}
              <div className="st-row">
                <Button disabled={busy} onClick={() => void openReview(p.runId)}>Review fix</Button>
                {confirm(`discard:${p.runId}`, "Discard", () => void resolve("discard", p.runId), "danger")}
              </div>
              {review?.runId === p.runId ? (
                <>
                  {review.files.length > 0 && <ul className="sh-files" aria-label="Files in this proposal">{review.files.map((f) => <li key={f}><code>{f}</code>{isTestFile(f) ? <span className="sh-test-flag" role="note">test changed — check it was not weakened</span> : null}</li>)}</ul>}
                  <pre aria-label="Proposed diff">{review.text || "(no changes)"}</pre>
                  {review.truncated ? <p className="st-hint">The diff is too long to show here. Review it in {p.worktreePath} and apply it by hand.</p> : null}
                  {confirm(`apply:${p.runId}`, "Apply to my checkout", () => void resolve("apply", p.runId), "primary", review.text === "" || review.truncated)}
                </>
              ) : null}
            </div>
          ))}
        </section>
      ) : null}
      <p className="st-hint" role="status">{items === null ? "Loading incidents..." : incidentSummary(items)}</p>
      {items && items.length > 0 ? (
        <ul className="st-stack" aria-label="Incidents">
          {items.map((i) => (
            <li key={i.id}>
              <p className="st-label">
                {SOURCE_TEXT[i.source]} · {i.category} · {STATUS_TEXT[i.status]}
                {i.environmental ? ` · environmental (${i.environmental})` : ""}
                {i.attempts > 0 ? ` · ${i.attempts} attempt${i.attempts === 1 ? "" : "s"}` : ""}
              </p>
              <p>{i.message}</p>
              {i.note ? <p className="st-hint">{i.note}</p> : null}
              <p className="st-hint">Seen {i.count} time{i.count === 1 ? "" : "s"}, last {new Date(i.lastSeen).toLocaleString()}</p>
              {i.stack.length > 0 ? (
                <details>
                  <summary>Stack</summary>
                  <pre>{i.stack.join("\n")}</pre>
                </details>
              ) : null}
              {i.status !== "ignored" && !busyRow(i) ? (
                <Button disabled={busy} onClick={() => void act("POST", `${BASE}/${i.id}/ignore`)}>Ignore</Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
