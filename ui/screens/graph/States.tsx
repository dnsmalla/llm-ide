// Empty, loading, error and size-limit states. Plain explanations with one next step each; nothing here
// runs a command: generating a graph is the Mac scanners' job today (see the blocked-by note in the doc).
import { useState } from "react";
import { StatusBanner } from "@llmide/ui-kit";
import { GRAPH_CANDIDATES } from "./source.ts";
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

export function EmptyState({ tried, onOpen, onRetry, onGenerate }: { tried: string[]; onOpen: (p: string) => boolean; onRetry: () => void; onGenerate?: (mode: "code" | "memory" | "all") => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"code" | "memory" | "all">("code");
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="gr-state">
      <h2 className="gr-state-title">No code graph for this project yet</h2>
      <p>This screen shows the graph that the Code Graph scanners write to <code>{GRAPH_CANDIDATES[0]}</code> inside the project.</p>
      <p className="gr-muted">Generate it here with the host's GraphKit runner, or in the macOS app (<strong>Code Graph → Generate</strong>) and come back. Looked for: {(tried.length ? tried : [...GRAPH_CANDIDATES]).join(", ")}.</p>
      {onGenerate ? (
        <div className="gr-row">
          <label className="gr-field">
            <span>Mode</span>
            <select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)} disabled={busy}>
              <option value="code">Code</option>
              <option value="memory">InfiniteBrain (llm-doc)</option>
              <option value="all">All (merge)</option>
            </select>
          </label>
          <button
            type="button"
            className="gr-btn gr-btn-primary"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setError(null);
              void onGenerate(mode).catch((e: unknown) => setError(e instanceof Error ? e.message : "The graph could not be generated.")).finally(() => setBusy(false));
            }}
          >
            {busy ? "Generating…" : mode === "code" ? "Generate code graph" : mode === "memory" ? "Generate memory graph" : "Generate all"}
          </button>
        </div>
      ) : null}
      <button type="button" className="gr-btn" onClick={onRetry}>Check again</button>
      {error ? <p className="gr-error" role="alert">{error}</p> : null}
      <OpenPath onOpen={onOpen} />
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
      <h2 className="gr-state-title">graph.json is larger than the 32 MB limit</h2>
      <p>The desktop host refuses to read graph files above 32 MB so a hostile file cannot exhaust memory. The limit is a constant in the host (<code>GRAPH_FILE_MAX_BYTES</code>); raising it, or paging the read, is a host change that has not been made yet.</p>
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
