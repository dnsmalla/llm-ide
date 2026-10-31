// The note editor: a plain textarea over an `EditorSession` (editor-session.ts), with an optional
// preview rendered by the same safe markdown renderer as the viewer (no HTML is ever injected).
// `EditorView` is the pure markup for one snapshot (rendered server-side in the tests);
// `NoteEditor` owns the session, the focus re-check and the unsaved-changes reporting.
import { useEffect, useMemo, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from "react";
import { StatusBanner } from "@llmide/ui-kit";
import { MarkdownView, type LinkHandlers } from "../MarkdownView";
import { parseNote } from "../frontmatter.ts";
import { EditorSession, type EditorDeps, type EditorSnapshot } from "./editor-session.ts";
import { writeErrorText } from "./write-host.ts";

export interface NoteEditorProps extends LinkHandlers {
  rel: string;
  deps: EditorDeps;
  /** Reports whether there are unsaved changes (the screen guards navigation with it). */
  onDirtyChange: (dirty: boolean) => void;
  /** Called after a conflict copy is written, with its path. */
  onCopySaved: (rel: string) => void;
  onClose: () => void;
  initialPreview?: boolean;
}

export interface EditorViewProps extends LinkHandlers {
  rel: string;
  snap: EditorSnapshot;
  dirty: boolean;
  preview: boolean;
  onTogglePreview: () => void;
  onEdit: (text: string) => void;
  onSave: () => void;
  onKeepMine: () => void;
  onTakeTheirs: () => void;
  onSaveCopy: () => void;
  onClose: () => void;
}

export function EditorView({ rel, snap, dirty, preview, onTogglePreview, onEdit, onSave, onKeepMine, onTakeTheirs, onSaveCopy, onClose, onOpenExternal, onOpenNote }: EditorViewProps): ReactNode {
  const body = useMemo(() => (preview ? parseNote(snap.draft).body : ""), [preview, snap.draft]);
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      onSave();
    }
  };

  if (snap.phase === "loading" || snap.phase === "idle") {
    return (
      <p className="lib-muted" role="status">
        Opening for editing…
      </p>
    );
  }
  if (snap.phase === "error") {
    return (
      <div className="lib-editor">
        <StatusBanner severity="error" message={writeErrorText(snap.error ?? "io")} />
        <div className="lib-editor-bar">
          <button type="button" className="lib-btn" onClick={onClose}>
            Back to the note
          </button>
        </div>
      </div>
    );
  }
  const saving = snap.phase === "saving";
  const status = snap.phase === "gone" ? "Deleted on disk" : snap.phase === "conflict" ? "Changed on disk" : saving ? "Saving…" : snap.phase === "dirty" ? "Unsaved changes" : snap.justSaved ? "Saved" : "No changes";
  return (
    <div className="lib-editor">
      <div className="lib-editor-bar" role="toolbar" aria-label="Editor">
        <button type="button" className="lib-btn lib-btn-primary" onClick={onSave} disabled={saving || snap.phase === "clean" || snap.phase === "gone" || snap.phase === "conflict"}>
          Save
        </button>
        <button type="button" className="lib-btn" aria-pressed={preview} onClick={onTogglePreview}>
          Preview
        </button>
        <button type="button" className="lib-btn" onClick={onClose} disabled={saving}>
          {dirty ? "Close without saving" : "Done"}
        </button>
        <span className="lib-muted" role="status" aria-live="polite">
          {status}
        </span>
      </div>
      {snap.phase === "conflict" && (
        <div className="lib-banner-actions" role="alert">
          <StatusBanner severity="warning" message="This note changed on disk since you opened it. Nothing was overwritten. Choose what to do with your version." />
          <div className="lib-editor-bar">
            <button type="button" className="lib-btn" onClick={onSaveCopy}>
              Save mine as a copy
            </button>
            <button type="button" className="lib-btn" onClick={onTakeTheirs}>
              Use the disk version (discard mine)
            </button>
            <button type="button" className="lib-btn lib-btn-danger" onClick={onKeepMine}>
              Overwrite with mine
            </button>
          </div>
        </div>
      )}
      {snap.phase === "gone" && (
        <div className="lib-banner-actions" role="alert">
          <StatusBanner severity="warning" message="This note no longer exists on disk. Your text is still here; saving does not recreate it." />
          <div className="lib-editor-bar">
            <button type="button" className="lib-btn" onClick={onSaveCopy}>
              Save mine as a new note
            </button>
          </div>
        </div>
      )}
      {snap.error && snap.phase === "dirty" && <StatusBanner severity="error" message={writeErrorText(snap.error)} />}
      {snap.mixedEol && <StatusBanner severity="info" message="This note mixes Windows and Unix line endings. Saving makes them all the same." />}
      <div className={preview ? "lib-editor-split" : "lib-editor-single"}>
        <textarea className="lib-editor-text" aria-label={`Edit ${rel}`} value={snap.draft} spellCheck onChange={(e) => onEdit(e.target.value)} onKeyDown={onKey} readOnly={snap.phase === "gone"} />
        {preview && (
          <div className="lib-editor-preview" aria-label="Preview">
            <MarkdownView text={body} baseRel={rel} onOpenExternal={onOpenExternal} onOpenNote={onOpenNote} />
          </div>
        )}
      </div>
    </div>
  );
}

export function NoteEditor({ rel, deps, onDirtyChange, onCopySaved, onClose, onOpenExternal, onOpenNote, initialPreview = false }: NoteEditorProps): ReactNode {
  const session = useMemo(() => new EditorSession(rel, deps), [rel, deps]);
  const snap = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const [preview, setPreview] = useState(initialPreview);

  useEffect(() => {
    void session.load();
    const onFocus = (): void => void session.checkExternal();
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      session.dispose();
    };
  }, [session]);

  const dirty = snap.phase === "dirty" || snap.phase === "conflict" || ((snap.phase === "saving" || snap.phase === "gone") && session.dirty);
  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent): void => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  return (
    <EditorView
      rel={rel}
      snap={snap}
      dirty={dirty}
      preview={preview}
      onTogglePreview={() => setPreview((v) => !v)}
      onEdit={(t) => session.edit(t)}
      onSave={() => void session.save()}
      onKeepMine={() => void session.keepMine()}
      onTakeTheirs={() => void session.takeTheirs()}
      onSaveCopy={() => void session.saveAsCopy().then((r) => r && onCopySaved(r))}
      onClose={onClose}
      onOpenExternal={onOpenExternal}
      onOpenNote={onOpenNote}
    />
  );
}
