// Empty, loading, error and size-limit states. Plain explanations with one next step each; nothing here
// runs a command: generating a graph is the Mac scanners' job today (see the blocked-by note in the doc).
import { useState } from "react";
import { StatusBanner } from "@llmide/ui-kit";
import { NoProjectCard } from "../shell/NoProjectCard";

export function LoadingState({ stage, onCancel }: { stage: string; onCancel: () => void }) {
  return (
    <div className="gr-state" role="status" aria-live="polite">
      <h2 className="gr-state-title">Loading the code graph</h2>
      <p className="gr-muted">{stage || "Working"}...</p>
      <button type="button" className="gr-btn" onClick={onCancel}>Cancel</button>
    </div>
  );
}

function OpenPath({ onOpen }: { onOpen: (path: string) => boolean }) {
  const [value, setValue] = useState("");
  const [bad, setBad] = useState(false);
  return (
    <form
      className="gr-open"
      onSubmit={(e) => {
        e.preventDefault();
        setBad(!onOpen(value));
      }}
    >
      <label className="gr-field">
        <span>Open another graph.json (path inside this project)</span>
        <input type="text" value={value} spellCheck={false} placeholder="system/graph/graph.json" aria-invalid={bad} onChange={(e) => { setValue(e.target.value); setBad(false); }} />
      </label>
      <button type="submit" className="gr-btn">Open graph.json</button>
      {bad && <p className="gr-error" role="alert">That is not a project-relative path to a file named graph.json.</p>}
    </form>
  );
}

export function CancelledState({ onReload }: { onReload: () => void }) {
  return (
    <div className="gr-state" role="status">
      <h2 className="gr-state-title">Loading was cancelled</h2>
      <p className="gr-muted">The graph was not loaded.</p>
      <button type="button" className="gr-btn gr-btn-primary" onClick={onReload}>Reload</button>
    </div>
  );
}

export function EmptyState({ mode }: { mode: "code" | "memory" | "all" }) {
  const title = mode === "code" ? "No code graph yet" : mode === "memory" ? "No InfiniteBrain graph yet" : "No graph yet";
  const message = mode === "code"
    ? "Click Generate Code Graph to scan the project."
    : mode === "memory"
      ? "Generate InfiniteBrain to build a doc graph from the selected repo's .md/.txt docs."
      : "Generate Graph to build one graph from all code and docs.";
  return (
    <div className="gr-state">
      <div className="gr-state-icon" aria-hidden="true">◇</div>
      <h2 className="gr-state-title">{title}</h2>
      <p className="gr-muted">{message}</p>
    </div>
  );
}

export function NoProjectState() {
  return (
    <NoProjectCard what="see the code graph" hint="The code graph belongs to a project." />
  );
}

export function TooLargeState({ onOpen }: { onOpen: (p: string) => boolean }) {
  return (
    <div className="gr-state">
      <h2 className="gr-state-title">graph.json is larger than the 128 MB limit</h2>
      <p>The desktop host refuses to read graph files above 128 MB so a hostile file cannot exhaust memory. The limit is <code>GRAPH_FILE_MAX_BYTES</code> in the host. The screen itself shows a progressive overview: main communities and edges first; click a node to reveal its neighbourhood.</p>
      <p className="gr-muted">Meanwhile, a smaller graph (fewer files, or one repository of the project) can be opened below.</p>
      <OpenPath onOpen={onOpen} />
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="gr-state">
      <h2 className="gr-state-title">The code graph could not be shown</h2>
      <StatusBanner severity="error" message={message} />
      <button type="button" className="gr-btn" onClick={onRetry}>Try again</button>
    </div>
  );
}
