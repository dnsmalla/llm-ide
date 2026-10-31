// Dialogs of the write side. Every destructive one names exactly what it acts on; none offers a
// permanent delete. All are controlled: the caller owns the async work and the error text.
import { useState, type FormEvent, type ReactNode } from "react";
import { StatusBanner } from "@llmide/ui-kit";
import { Dialog } from "./Dialog";
import { bulkMessage, confirmMatches, deletePhrase, needsTypedConfirm, previewNames, type BulkProgress } from "./bulk.ts";
import { writeErrorText } from "./write-host.ts";
import { baseOf, nameProblem, nameProblemText, withExtension } from "./note-ops.ts";
import { normalizeTag } from "./frontmatter-edit.ts";

/** A folder path for a new note: relative, visible segments only. Null when fine. */
export function folderProblem(folder: string): string | null {
  const f = folder.trim().replace(/\/+$/, "");
  if (f === "") return null;
  if (f.length > 200 || f.startsWith("/")) return "Use a folder path inside the notes folder, such as notes or source/meetings.";
  for (const seg of f.split("/")) {
    // eslint-disable-next-line no-control-regex
    if (seg === "" || seg === "." || seg === ".." || seg.startsWith(".") || seg === "node_modules" || /[\\:\u0000-\u001f\u007f<>"|?*]/.test(seg)) return "Folder names cannot be empty or hidden, or contain backslashes, colons, quotes or wildcard characters.";
  }
  return null;
}

function Actions({ children }: { children: ReactNode }): ReactNode {
  return <div className="lib-modal-actions">{children}</div>;
}

export function NewNoteDialog({ defaultFolder, onCreate, onClose, error, busy }: { defaultFolder: string; onCreate: (title: string, folder: string) => void; onClose: () => void; error: string | null; busy: boolean }): ReactNode {
  const [title, setTitle] = useState("");
  const [folder, setFolder] = useState(defaultFolder);
  const fp = folderProblem(folder);
  const ok = title.trim() !== "" && fp === null && !busy;
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    if (ok) onCreate(title.trim(), folder.trim().replace(/\/+$/, ""));
  };
  return (
    <Dialog title="New note" onClose={onClose} busy={busy}>
      <form onSubmit={submit} className="lib-form">
        <label className="lib-field">
          <span>Title</span>
          <input data-autofocus type="text" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} aria-describedby="lib-new-hint" />
        </label>
        <label className="lib-field">
          <span>Folder</span>
          <input type="text" value={folder} maxLength={200} onChange={(e) => setFolder(e.target.value)} aria-invalid={fp !== null} />
        </label>
        <p id="lib-new-hint" className="lib-muted">
          The note is saved as a Markdown file in this folder inside your notes folder. An existing note is never overwritten.
        </p>
        {fp && <StatusBanner severity="warning" message={fp} />}
        {error && <StatusBanner severity="error" message={error} />}
        <Actions>
          <button type="button" className="lib-btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="lib-btn lib-btn-primary" disabled={!ok}>
            Create note
          </button>
        </Actions>
      </form>
    </Dialog>
  );
}

export function RenameDialog({ rel, onRename, onClose, error, busy }: { rel: string; onRename: (newName: string) => void; onClose: () => void; error: string | null; busy: boolean }): ReactNode {
  const [name, setName] = useState(baseOf(rel));
  const candidate = withExtension(name);
  const problem = nameProblem(candidate);
  const unchanged = candidate === baseOf(rel);
  const ok = problem === null && !unchanged && !busy;
  return (
    <Dialog title="Rename note" onClose={onClose} busy={busy}>
      <form
        className="lib-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (ok) onRename(candidate);
        }}
      >
        <p className="lib-muted lib-path">{rel}</p>
        <label className="lib-field">
          <span>New file name</span>
          <input data-autofocus type="text" value={name} onChange={(e) => setName(e.target.value)} aria-invalid={problem !== null && name !== baseOf(rel)} />
        </label>
        {problem && !unchanged && <StatusBanner severity="warning" message={nameProblemText(problem)} />}
        {error && <StatusBanner severity="error" message={error} />}
        <Actions>
          <button type="button" className="lib-btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="lib-btn lib-btn-primary" disabled={!ok}>
            Rename
          </button>
        </Actions>
      </form>
    </Dialog>
  );
}

export function DeleteDialog({ rels, titles, progress, onConfirm, onCancelRun, onClose }: { rels: readonly string[]; titles: ReadonlyMap<string, string>; progress: BulkProgress | null; onConfirm: () => void; onCancelRun: () => void; onClose: () => void }): ReactNode {
  const [typed, setTyped] = useState("");
  const n = rels.length;
  const typedNeeded = needsTypedConfirm(n);
  const running = progress?.phase === "running";
  const finished = progress !== null && (progress.phase === "done" || progress.phase === "cancelled");
  const ok = !typedNeeded || confirmMatches(typed, n);
  const { shown, more } = previewNames(rels);
  const heading = n === 1 ? "Move this note to the Trash?" : `Move ${n.toLocaleString()} notes to the Trash?`;
  return (
    <Dialog title={heading} onClose={onClose} role="alertdialog" busy={running}>
      <div className="lib-form">
        {!progress && (
          <>
            <p>
              {n === 1 ? "This note will be moved to the Trash. You can restore it from there." : "These notes will be moved to the Trash. You can restore them from there."} Nothing is deleted permanently.
            </p>
            <ul className="lib-delete-list" aria-label="Notes to delete">
              {shown.map((r) => (
                <li key={r}>
                  <strong>{titles.get(r) ?? baseOf(r)}</strong> <span className="lib-muted lib-path">{r}</span>
                </li>
              ))}
              {more > 0 && <li className="lib-muted">and {more.toLocaleString()} more</li>}
            </ul>
            {typedNeeded && (
              <label className="lib-field">
                <span>
                  Type <code>{deletePhrase(n)}</code> to confirm
                </span>
                <input data-autofocus type="text" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} />
              </label>
            )}
          </>
        )}
        {progress && (
          <div role="status" aria-live="polite">
            <p>{bulkMessage(progress, "Moving to Trash:")}</p>
            {progress.errors.length > 0 && (
              <ul className="lib-delete-list" aria-label="Notes that could not be deleted">
                {progress.errors.slice(0, 8).map((e) => (
                  <li key={e.rel}>
                    <span className="lib-path">{e.rel}</span> <span className="lib-muted">{writeErrorText(e.code)}</span>
                  </li>
                ))}
                {progress.errors.length > 8 && <li className="lib-muted">and more</li>}
              </ul>
            )}
          </div>
        )}
        <Actions>
          {running ? (
            <button type="button" className="lib-btn" onClick={onCancelRun}>
              Stop
            </button>
          ) : finished ? (
            <button type="button" className="lib-btn lib-btn-primary" onClick={onClose} data-autofocus>
              Close
            </button>
          ) : (
            <>
              <button type="button" className="lib-btn" onClick={onClose} data-autofocus={!typedNeeded || undefined}>
                Cancel
              </button>
              <button type="button" className="lib-btn lib-btn-danger" onClick={onConfirm} disabled={!ok}>
                {n === 1 ? "Move to Trash" : `Move ${n.toLocaleString()} notes to Trash`}
              </button>
            </>
          )}
        </Actions>
      </div>
    </Dialog>
  );
}

export function TagDialog({ count, progress, onApply, onCancelRun, onClose }: { count: number; progress: BulkProgress | null; onApply: (tags: string[], mode: "add" | "remove") => void; onCancelRun: () => void; onClose: () => void }): ReactNode {
  const [text, setText] = useState("");
  const [mode, setMode] = useState<"add" | "remove">("add");
  const tags = text
    .split(/[\n,]/)
    .map((t) => normalizeTag(t))
    .filter((t): t is string => t !== null);
  const running = progress?.phase === "running";
  const finished = progress !== null && (progress.phase === "done" || progress.phase === "cancelled");
  return (
    <Dialog title={`Tag ${count.toLocaleString()} ${count === 1 ? "note" : "notes"}`} onClose={onClose} busy={running}>
      <div className="lib-form">
        {!progress && (
          <>
            <fieldset className="lib-field lib-radio">
              <legend>Action</legend>
              <label>
                <input type="radio" name="tagmode" checked={mode === "add"} onChange={() => setMode("add")} /> Add tags
              </label>
              <label>
                <input type="radio" name="tagmode" checked={mode === "remove"} onChange={() => setMode("remove")} /> Remove tags
              </label>
            </fieldset>
            <label className="lib-field">
              <span>Tags (separated by commas)</span>
              <input data-autofocus type="text" value={text} onChange={(e) => setText(e.target.value)} />
            </label>
            <p className="lib-muted">
              Only the <code>tags</code> line of each note&apos;s header changes. Other header lines and the note text stay byte for byte as they are.
            </p>
          </>
        )}
        {progress && (
          <div role="status" aria-live="polite">
            <p>{bulkMessage(progress, "Updating")}</p>
            {progress.errors.length > 0 && (
              <ul className="lib-delete-list" aria-label="Notes that could not be updated">
                {progress.errors.slice(0, 8).map((e) => (
                  <li key={e.rel}>
                    <span className="lib-path">{e.rel}</span> <span className="lib-muted">{writeErrorText(e.code)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        <Actions>
          {running ? (
            <button type="button" className="lib-btn" onClick={onCancelRun}>
              Stop
            </button>
          ) : finished ? (
            <button type="button" className="lib-btn lib-btn-primary" onClick={onClose} data-autofocus>
              Close
            </button>
          ) : (
            <>
              <button type="button" className="lib-btn" onClick={onClose}>
                Cancel
              </button>
              <button type="button" className="lib-btn lib-btn-primary" disabled={tags.length === 0} onClick={() => onApply(tags, mode)}>
                {mode === "add" ? "Add" : "Remove"} {tags.length || ""} {tags.length === 1 ? "tag" : "tags"}
              </button>
            </>
          )}
        </Actions>
      </div>
    </Dialog>
  );
}

export function DiscardDialog({ onDiscard, onKeep }: { onDiscard: () => void; onKeep: () => void }): ReactNode {
  return (
    <Dialog title="Discard unsaved changes?" onClose={onKeep} role="alertdialog">
      <div className="lib-form">
        <p>This note has changes that are not saved. If you leave now they are lost.</p>
        <Actions>
          <button type="button" className="lib-btn lib-btn-primary" onClick={onKeep} data-autofocus>
            Keep editing
          </button>
          <button type="button" className="lib-btn lib-btn-danger" onClick={onDiscard}>
            Discard changes
          </button>
        </Actions>
      </div>
    </Dialog>
  );
}
