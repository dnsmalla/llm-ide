// The result: progress while reading and waiting, an error with a next step, or the document (safe markdown, read-only)
// with notices, refine, save and open actions. Model output is untrusted: it only ever reaches the screen through the
// Library's markdown renderer (no HTML, no images, links only through the host opener).
import { useCallback, useState, type ReactNode } from "react";
import { StatusBanner } from "@llmide/ui-kit";
import { MarkdownView } from "../library/MarkdownView";
import { MermaidView } from "./mermaid/MermaidView";
import type { MermaidRuntimeApi } from "./mermaid/renderer.ts";
import { isMermaidLang } from "./mermaid/source.ts";
import { MAX_PROMPT } from "./model.ts";
import type { RunState } from "./run.ts";
import { Elapsed } from "./SetupPanel";

export interface ResultPanelProps {
  surface: "doc" | "visual";
  run: RunState;
  onCancel: () => void;
  onRetry: () => void;
  onRefine: (instruction: string) => void;
  onSave: () => void;
  onSaveAsNew: () => void;
  onOpenSaved: (path: string) => void;
  onDiscard: () => void;
  onOpenExternal: (url: string) => void;
  onOpenSettings: () => void;
  onSignIn: () => void;
  /** The optional diagram renderer (host-installed on demand). Absent: a mermaid fence stays source text. */
  mermaid?: MermaidRuntimeApi;
  /** Tests render the whole document at once. */
  initialSections?: number;
}

export function ResultPanel(p: ResultPanelProps): ReactNode {
  const r = p.run;
  return (
    <section className="dg-result" aria-label={p.surface === "visual" ? "Visual result" : "Document result"} aria-busy={r.phase === "reading" || r.phase === "generating"}>
      {r.phase === "idle" && (
        <div className="dg-empty">
          <h2 className="dg-h2">{p.surface === "visual" ? "Visuals" : "Documents"} appear here</h2>
          <p className="dg-muted">Choose a template or write a command, select sources, then generate. Nothing is sent until you press Generate.</p>
        </div>
      )}
      {r.phase === "reading" && (
        <div className="dg-progress" role="status" aria-live="polite">
          <h2 className="dg-h2">Reading sources</h2>
          <p>
            {(r.progress?.done ?? 0).toLocaleString("en")} of {(r.progress?.total ?? 0).toLocaleString("en")} read
          </p>
          <progress max={r.progress?.total || 1} value={r.progress?.done ?? 0} aria-label="Reading sources" />
          <button type="button" className="dg-btn" onClick={p.onCancel}>
            Cancel
          </button>
        </div>
      )}
      {r.phase === "generating" && !r.revising && (
        <div className="dg-progress" role="status" aria-live="polite">
          <h2 className="dg-h2">Writing with the model</h2>
          <p className="dg-muted">
            Waiting for the core… <Elapsed since={r.startedAt} />. The core returns the finished document in one piece, so there is no partial text to show.
          </p>
          <button type="button" className="dg-btn" onClick={p.onCancel}>
            Cancel
          </button>
        </div>
      )}
      {r.phase === "error" && r.error && (
        <div className="dg-error" role="alert">
          <h2 className="dg-h2">Could not generate</h2>
          <p>{r.error.message}</p>
          {r.skipped.length > 0 && <p className="dg-muted">Could not read: {r.skipped.slice(0, 5).join(", ")}{r.skipped.length > 5 ? ` and ${r.skipped.length - 5} more` : ""}.</p>}
          <div className="dg-actions">
            {r.error.retryable && (
              <button type="button" className="dg-btn dg-primary" onClick={p.onRetry}>
                Try again
              </button>
            )}
            {r.error.action === "sign_in" && (
              <button type="button" className="dg-btn" onClick={p.onSignIn}>
                Sign in
              </button>
            )}
            {r.error.action === "settings" && (
              <button type="button" className="dg-btn" onClick={p.onOpenSettings}>
                Open Settings
              </button>
            )}
            <button type="button" className="dg-btn" onClick={p.onDiscard}>
              Back to setup
            </button>
          </div>
        </div>
      )}
      {r.phase === "done" || (r.phase === "generating" && r.revising) ? <Done {...p} /> : null}
    </section>
  );
}

function Done(p: ResultPanelProps): ReactNode {
  const r = p.run;
  const [instruction, setInstruction] = useState("");
  const revising = r.revising;
  const runtime = p.mermaid;
  const renderFence = useCallback((lang: string, text: string) => (runtime && isMermaidLang(lang) ? <MermaidView source={text} runtime={runtime} /> : null), [runtime]);
  return (
    <div className="dg-done">
      {r.notice && <StatusBanner severity="warning" message={<>{r.notice}</>} />}
      {r.skipped.length > 0 && <StatusBanner severity="warning" message={<>Could not read as text: {r.skipped.slice(0, 5).join(", ")}{r.skipped.length > 5 ? ` and ${r.skipped.length - 5} more` : ""}.</>} />}
      {r.editError && <StatusBanner severity="error" message={<>{r.editError}</>} />}
      {r.saveError && <StatusBanner severity="error" message={<>{r.saveError.message}</>} />}
      {p.surface === "visual" && !runtime && /```\s*mermaid/i.test(r.doc) && <p className="dg-muted">This output contains a Mermaid diagram. Diagrams are shown as source here until a bundled, sandboxed renderer is added.</p>}
      <div className="dg-bar" role="group" aria-label="Document actions">
        <button type="button" className="dg-btn dg-primary" disabled={r.saving || revising || (r.saved !== null && !r.dirty)} onClick={p.onSave}>
          {r.saving ? "Saving…" : r.saved && !r.dirty ? "Saved" : r.saved ? "Save changes" : "Save to llm-doc/generated"}
        </button>
        {r.saveConflict && (
          <button type="button" className="dg-btn" onClick={p.onSaveAsNew}>
            Save as new file
          </button>
        )}
        {r.saved && (
          <button type="button" className="dg-btn" onClick={() => p.onOpenSaved(r.saved!.path)}>
            Open in Explorer
          </button>
        )}
        <button type="button" className="dg-btn" disabled={revising} onClick={p.onDiscard}>
          {r.saved && !r.dirty ? "Start another" : "Discard"}
        </button>
      </div>
      {r.saved && (
        <p className="dg-muted" role="status">
          {r.dirty ? "Unsaved changes. Last saved to" : "Saved to"} <code>{r.saved.path}</code>
        </p>
      )}
      {revising && (
        <div className="dg-progress" role="status" aria-live="polite">
          <p>
            Revising… <Elapsed since={r.startedAt} />
          </p>
          <button type="button" className="dg-btn" onClick={p.onCancel}>
            Cancel
          </button>
        </div>
      )}
      <div className="dg-doc">
        <MarkdownView text={r.doc} baseRel={null} onOpenExternal={p.onOpenExternal} renderFence={renderFence} initialSections={p.initialSections} />
      </div>
      <form
        className="dg-refine"
        onSubmit={(e) => {
          e.preventDefault();
          if (instruction.trim() && !revising) {
            p.onRefine(instruction);
            setInstruction("");
          }
        }}
      >
        <label className="dg-field">
          <span>Ask for a change</span>
          <textarea rows={2} value={instruction} maxLength={MAX_PROMPT - 400} disabled={revising} onChange={(e) => setInstruction(e.target.value)} placeholder="Shorten the summary; add a risks section" />
        </label>
        <button type="submit" className="dg-btn" disabled={revising || instruction.trim() === ""}>
          Revise
        </button>
      </form>
    </div>
  );
}
