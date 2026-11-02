// Memory viewer: what the assistant has learned about the project and what this chat carries. Mirrors the Mac's
// ProjectMemoryView wording and its explicit prune actions: one project fact, all project facts, or this chat's
// session memory. Fact text is untrusted model output and is always rendered as text (React escapes it).
import { useEffect, useState } from "react";
import { StatusBanner } from "@llmide/ui-kit";
import type { CoreClient } from "../../settings/core-api.ts";
import {
  clearProjectFacts,
  deleteProjectFact,
  factLearned,
  factText,
  forgetSessionMemory,
  loadMemory,
  type MemoryLoad,
  type MemoryTarget,
} from "./memory-model";

export interface ProjectMemoryViewProps extends MemoryTarget {
  client: CoreClient;
  onClose?: () => void;
}

/** What the body shows: a loaded result, a load in flight, or nothing yet. */
export type MemoryState = { status: "loading" } | { status: "ready"; data: MemoryLoad };

export interface MemoryActions {
  onDeleteFact(fact: string): void;
  onForgetSession(): void;
}

const EMPTY_NO_PROJECT = "Open a project folder (or index a repo) to capture memory.";
const EMPTY_NOTHING = "Nothing remembered yet. The assistant will capture durable facts as you chat about this project.";

export function MemoryBody({ state, busy = false, actions }: { state: MemoryState; busy?: boolean; actions?: MemoryActions }) {
  if (state.status === "loading") return <div className="mem-empty" role="status">Loading memory</div>;
  const { project, projectFailed, session } = state.data;
  const facts = project?.facts ?? [];
  const banner = projectFailed ? <StatusBanner severity="error" message="Couldn't load project memory." /> : null;
  if (facts.length === 0 && session.length === 0) {
    // A failed project load says so and nothing else (the empty-state text would claim "nothing learned").
    if (projectFailed) return banner;
    const noProject = (project?.repo ?? null) === null;
    return <>{banner}<div className="mem-empty">{noProject ? EMPTY_NO_PROJECT : EMPTY_NOTHING}</div></>;
  }
  return (
    <>
      {banner}
      <div className="mem-sections">
        {session.length > 0 && (
          <section aria-label="This chat's memory">
            <div className="mem-section-head">
              <div>
                <h3 className="mem-heading">This chat</h3>
                <p className="mem-sub">Decisions and state from this conversation, forgotten with the chat</p>
              </div>
              {actions && <button type="button" className="mem-link danger" disabled={busy} onClick={actions.onForgetSession}>Forget</button>}
            </div>
            <ul className="mem-list" aria-label="Session memory">
              {session.map((f, i) => <li key={`s${i}`} className="mem-fact">{factText(f)}</li>)}
            </ul>
          </section>
        )}
        {facts.length > 0 && (
          <section aria-label="Project memory">
            <div className="mem-section-head">
              <div>
                <h3 className="mem-heading">This project</h3>
                <p className="mem-sub">Durable facts, recalled in every chat about this project</p>
              </div>
            </div>
            <ul className="mem-list" aria-label="Project facts">
              {facts.map((f, i) => {
                const learned = factLearned(f);
                return (
                  <li key={`p${i}`} className="mem-fact mem-fact-row">
                    <div>
                      <span>{factText(f)}</span>
                      {learned && <span className="mem-learned">{`Learned ${learned}`}</span>}
                    </div>
                    {actions && <button type="button" className="mem-trash" aria-label={`Forget ${factText(f)}`} title="Forget this fact" disabled={busy} onClick={() => actions.onDeleteFact(f)}>×</button>}
                  </li>
                );
              })}
            </ul>
          </section>
        )}
      </div>
    </>
  );
}

type Confirm = "project" | "session";

export function ProjectMemoryView({ client, repos, workspaceRoot, sessionId, onClose }: ProjectMemoryViewProps) {
  const [state, setState] = useState<MemoryState>({ status: "loading" });
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  // The effect re-runs when the candidates change, not when the array identity does.
  const reposKey = repos.join("\n");
  const sid = (sessionId ?? "").trim();

  useEffect(() => {
    const ac = new AbortController();
    setState({ status: "loading" });
    setActionError(null);
    loadMemory(client, { repos: reposKey ? reposKey.split("\n") : [], workspaceRoot, sessionId }, ac.signal).then(
      (data) => setState({ status: "ready", data }),
      () => { if (!ac.signal.aborted) setState({ status: "ready", data: { project: null, projectFailed: true, session: [] } }); },
    );
    return () => ac.abort();
  }, [client, reposKey, workspaceRoot, sessionId]);

  const ready = state.status === "ready" ? state.data : null;
  const facts = ready?.project?.facts ?? [];
  const setFacts = (next: string[]) => setState((prev) => {
    if (prev.status !== "ready" || !prev.data.project) return prev;
    return { ...prev, data: { ...prev.data, project: { ...prev.data.project, facts: next } } };
  });

  const deleteFact = (fact: string) => {
    const repo = ready?.project?.repo;
    if (!repo || busy) return;
    setBusy(true);
    setActionError(null);
    void deleteProjectFact(client, { workspaceRoot }, repo, fact).then(setFacts).catch(() => {
      setActionError("Couldn't update project memory.");
    }).finally(() => setBusy(false));
  };

  const clearAll = () => {
    const repo = ready?.project?.repo;
    setConfirm(null);
    if (!repo || busy) return;
    setBusy(true);
    setActionError(null);
    void clearProjectFacts(client, { workspaceRoot }, repo).then(setFacts).catch(() => {
      setActionError("Couldn't clear project memory.");
    }).finally(() => setBusy(false));
  };

  const forgetSession = () => {
    setConfirm(null);
    if (!sid || busy) return;
    setBusy(true);
    setActionError(null);
    void forgetSessionMemory(client, sid).then(() => {
      setState((prev) => (prev.status === "ready" ? { ...prev, data: { ...prev.data, session: [] } } : prev));
    }).catch(() => {
      setActionError("Couldn't forget this chat's memory.");
    }).finally(() => setBusy(false));
  };

  return (
    <section className="mem-root" aria-label="Memory">
      <header className="mem-head">
        <div>
          <h2 className="mem-title">Memory</h2>
          <p className="mem-sub">What the assistant has learned about this project, and in this chat</p>
        </div>
        <div className="mem-head-actions">
          {facts.length > 0 && <button type="button" className="mem-link danger" disabled={busy} onClick={() => setConfirm("project")}>Clear all</button>}
          {onClose && <button type="button" className="ex-tool" aria-label="Close memory" onClick={onClose}>Close</button>}
        </div>
      </header>
      {actionError && <StatusBanner severity="error" message={actionError} />}
      <MemoryBody state={state} busy={busy} actions={{ onDeleteFact: deleteFact, onForgetSession: () => setConfirm("session") }} />
      {confirm && (
        <div className="mem-confirm" role="alertdialog" aria-label={confirm === "project" ? "Clear all project memory?" : "Forget this chat's memory?"}>
          <strong>{confirm === "project" ? "Clear all project memory?" : "Forget this chat's memory?"}</strong>
          <p>{confirm === "project"
            ? "Every fact the assistant has learned about this project is deleted, and later chats will no longer recall them. This can't be undone."
            : "Everything this chat's memory holds is deleted. This can't be undone."}</p>
          <div className="mem-confirm-actions">
            <button type="button" className="mem-link danger" disabled={busy} onClick={confirm === "project" ? clearAll : forgetSession}>{confirm === "project" ? "Clear all" : "Forget"}</button>
            <button type="button" className="mem-link" onClick={() => setConfirm(null)}>Cancel</button>
          </div>
        </div>
      )}
    </section>
  );
}
