// Memory viewer (read only): what the assistant has learned about the project, and what this chat carries. Mirrors
// the Mac's ProjectMemoryView wording. Fact text is rendered as text (React escapes it). No Forget or Clear here.
import { useEffect, useState } from "react";
import { StatusBanner } from "@llmide/ui-kit";
import type { CoreClient } from "../../settings/core-api.ts";
import { factLearned, factText, loadMemory, type MemoryLoad, type MemoryTarget } from "./memory-model";

export interface ProjectMemoryViewProps extends MemoryTarget {
  client: CoreClient;
  onClose?: () => void;
}

/** What the body shows: a loaded result, a load in flight, or nothing yet. */
export type MemoryState = { status: "loading" } | { status: "ready"; data: MemoryLoad };

const EMPTY_NO_PROJECT = "Open a project folder (or index a repo) to capture memory.";
const EMPTY_NOTHING = "Nothing remembered yet. The assistant will capture durable facts as you chat about this project.";

export function MemoryBody({ state }: { state: MemoryState }) {
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
            <h3 className="mem-heading">This chat</h3>
            <p className="mem-sub">Decisions and state from this conversation, forgotten with the chat</p>
            <ul className="mem-list" aria-label="Session memory">
              {session.map((f, i) => <li key={`s${i}`} className="mem-fact">{factText(f)}</li>)}
            </ul>
          </section>
        )}
        {facts.length > 0 && (
          <section aria-label="Project memory">
            <h3 className="mem-heading">This project</h3>
            <p className="mem-sub">Durable facts, recalled in every chat about this project</p>
            <ul className="mem-list" aria-label="Project facts">
              {facts.map((f, i) => {
                const learned = factLearned(f);
                return (
                  <li key={`p${i}`} className="mem-fact">
                    <span>{factText(f)}</span>
                    {learned && <span className="mem-learned">{`Learned ${learned}`}</span>}
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

export function ProjectMemoryView({ client, repos, workspaceRoot, sessionId, onClose }: ProjectMemoryViewProps) {
  const [state, setState] = useState<MemoryState>({ status: "loading" });
  // The effect re-runs when the candidates change, not when the array identity does.
  const reposKey = repos.join("\n");
  useEffect(() => {
    const ac = new AbortController();
    setState({ status: "loading" });
    loadMemory(client, { repos: reposKey ? reposKey.split("\n") : [], workspaceRoot, sessionId }, ac.signal).then(
      (data) => setState({ status: "ready", data }),
      () => { if (!ac.signal.aborted) setState({ status: "ready", data: { project: null, projectFailed: true, session: [] } }); },
    );
    return () => ac.abort();
  }, [client, reposKey, workspaceRoot, sessionId]);
  return (
    <section className="mem-root" aria-label="Memory">
      <header className="mem-head">
        <div>
          <h2 className="mem-title">Memory</h2>
          <p className="mem-sub">What the assistant has learned about this project, and in this chat</p>
        </div>
        {onClose && <button type="button" className="ex-tool" aria-label="Close memory" onClick={onClose}>Close</button>}
      </header>
      <MemoryBody state={state} />
    </section>
  );
}
