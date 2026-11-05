// The result: progress while reading and waiting, an error with a next step, or the document (safe markdown, read-only)
// with notices, refine, save and open actions. Model output is untrusted: it only ever reaches the screen through the
// Library's markdown renderer (no HTML, no images, links only through the host opener).
import { useCallback, useState, type FormEvent, type ReactNode } from "react";
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
  /** Resolves true when the revision applied (the typed instruction is then cleared), false when it did not. */
  onRefine: (instruction: string) => Promise<boolean> | boolean;
  onSave: () => void;
  onSaveAsNew: () => void;
  /** Native save panel: write a copy anywhere the user chooses (desktop only). */
  onExport?: (name: string, text: string) => void;
  /** Display name of the external destination, when Save targets one. */
  externalDestination?: string | null;
  onOpenSaved: (path: string) => void;
  /** Shows the saved file in the OS file manager. Absent outside the desktop app: no Reveal button. */
  onReveal?: (path: string) => void;
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
  const [mode, setMode] = useState<"preview" | "raw">("preview");
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const revising = r.revising;
  const runtime = p.mermaid;
  const renderFence = useCallback((lang: string, text: string) => (runtime && isMermaidLang(lang) ? <MermaidView source={text} runtime={runtime} /> : null), [runtime]);
  // "Saved" means written and unchanged since. Anything else (never saved, or edited since the last save) is work that
  // "Start another" would throw away, so it asks first, as the Mac does.
  const destinationMatches = r.saved !== null && (r.saved.external === true) === (p.externalDestination != null);
  const saveIsCurrent = r.saved !== null && !r.dirty && destinationMatches;
  const submitRefine = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const text = instruction.trim();
    if (text === "" || revising) return;
    // A failed or refused revision keeps the typed instruction so it can be sent again without retyping.
    if (await p.onRefine(text)) setInstruction("");
  };
  return (
    <div className="dg-done">
      {r.notice && <StatusBanner severity="warning" message={<>{r.notice}</>} />}
      {r.skipped.length > 0 && <StatusBanner severity="warning" message={<>Could not read as text: {r.skipped.slice(0, 5).join(", ")}{r.skipped.length > 5 ? ` and ${r.skipped.length - 5} more` : ""}.</>} />}
      {r.editError && <StatusBanner severity="error" message={<>{r.editError}</>} />}
      {r.saveError && <StatusBanner severity="error" message={<>{r.saveError.message}</>} />}
      {p.surface === "visual" && !runtime && /```\s*mermaid/i.test(r.doc) && <p className="dg-muted">This output contains a Mermaid diagram. Diagrams are shown as source here until a bundled, sandboxed renderer is added.</p>}
      <div className="dg-bar" role="group" aria-label="Document actions">
        <button type="button" className="dg-btn dg-primary" disabled={r.saving || revising || saveIsCurrent} onClick={p.onSave}>
          {r.saving ? "Saving…" : saveIsCurrent ? "Saved" : r.saved ? "Save changes" : p.externalDestination ? `Save to ${p.externalDestination}` : "Save to llm-doc/generated"}
        </button>
        {r.saveConflict && (
          <button type="button" className="dg-btn" onClick={p.onSaveAsNew}>
            Save as new file
          </button>
        )}
        {p.onExport && (
          <button type="button" className="dg-btn" disabled={r.saving || revising} title="Save a copy outside the project" onClick={() => p.onExport!(r.saved?.stem ?? "document", r.doc)}>
            Export…
          </button>
        )}
        {r.saved && !r.saved.external && (
          <button type="button" className="dg-btn" onClick={() => p.onOpenSaved(r.saved!.path)}>
            Open in Explorer
          </button>
        )}
        {r.saved && !r.saved.external && p.onReveal && (
          <button type="button" className="dg-btn" title="Show the saved file in the file manager" onClick={() => p.onReveal!(r.saved!.path)}>
            Reveal
          </button>
        )}
        <button type="button" className="dg-btn" aria-pressed={mode === "preview"} onClick={() => setMode("preview")}>Preview</button>
        <button type="button" className="dg-btn" aria-pressed={mode === "raw"} onClick={() => setMode("raw")}>Raw</button>
        <button
          type="button"
          className="dg-btn"
          disabled={revising}
          onClick={() => {
            if (saveIsCurrent) p.onDiscard();
            else setConfirmDiscard(true);
          }}
        >
          Start another
        </button>
      </div>
      {confirmDiscard && !saveIsCurrent && (
        <div className="dg-bar" role="alertdialog" aria-label="Discard this document?">
          <span>Discard this document? It has not been saved, and starting another discards it.</span>
          <button type="button" className="dg-btn dg-danger" disabled={revising} onClick={() => { setConfirmDiscard(false); p.onDiscard(); }}>
            Discard &amp; start another
          </button>
          <button type="button" className="dg-btn" onClick={() => setConfirmDiscard(false)}>
            Keep it
          </button>
        </div>
      )}
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
        {mode === "raw" ? (
          <pre className="dg-raw" aria-label="Document markdown source">{r.doc}</pre>
        ) : (
          <MarkdownView text={r.doc} baseRel={null} onOpenExternal={p.onOpenExternal} renderFence={renderFence} initialSections={p.initialSections} />
        )}
      </div>
      <form className="dg-refine" onSubmit={submitRefine}>
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
