// Saved Doc Gen / Visual commands: the project's command files, editable and deletable through the core.
import { useId, useState, type ReactNode } from "react";
import { StatusBanner } from "@llmide/ui-kit";
import type { Failure } from "./errors.ts";
import type { DocCommand } from "./model.ts";

export interface CommandManagerProps {
  commands: readonly DocCommand[];
  busy: boolean;
  error: Failure | null;
  onSave: (input: { folder: string | null; name: string; instruction: string }) => Promise<DocCommand | null>;
  onDelete: (c: DocCommand) => Promise<boolean>;
  onClose: () => void;
  initialEditing?: string | "new" | null;
}

export function CommandManager({ commands, busy, error, onSave, onDelete, onClose, initialEditing = null }: CommandManagerProps): ReactNode {
  const titleId = useId();
  const [editing, setEditing] = useState<string | "new" | null>(initialEditing);
  const [confirm, setConfirm] = useState<string | null>(null);
  const current = editing && editing !== "new" ? commands.find((c) => c.id === editing) ?? null : null;
  const [name, setName] = useState(current?.name ?? "");
  const [instruction, setInstruction] = useState(current?.instruction ?? "");
  const start = (id: string | "new") => {
    const c = id === "new" ? null : commands.find((x) => x.id === id) ?? null;
    setEditing(id);
    setName(c?.name ?? "");
    setInstruction(c?.instruction ?? "");
  };
  const valid = name.trim() !== "" && instruction.trim() !== "";
  return (
    <div className="dg-dialog-wrap">
      <div className="dg-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="dg-bar"><h2 id={titleId} className="dg-h2">Commands</h2><button type="button" className="dg-btn" onClick={onClose}>Close</button></div>
        {error && <StatusBanner severity="error" message={<>{error.message}</>} />}
        {editing === null ? (
          <>
            <ul className="dg-tlist" aria-label="Commands">
              {commands.map((c) => (
                <li key={c.id} className="dg-trow">
                  <span className="dg-name">{c.name}</span>
                  <span className="dg-muted">{c.instruction.slice(0, 60)}</span>
                  {c.isProjectCommand ? (
                    <>
                      <button type="button" className="dg-link" onClick={() => start(c.id)} aria-label={`Edit ${c.name}`}>Edit</button>
                      {confirm === c.id ? (
                        <>
                          <button type="button" className="dg-link dg-danger" disabled={busy} onClick={() => onDelete(c).then(() => setConfirm(null))}>Delete {c.name}?</button>
                          <button type="button" className="dg-link" onClick={() => setConfirm(null)}>Keep</button>
                        </>
                      ) : (
                        <button type="button" className="dg-link" onClick={() => setConfirm(c.id)} aria-label={`Delete ${c.name}`}>Delete</button>
                      )}
                    </>
                  ) : <span className="dg-muted">built in</span>}
                </li>
              ))}
              {commands.length === 0 && <li className="dg-muted">No commands yet.</li>}
            </ul>
            <button type="button" className="dg-btn dg-primary" onClick={() => start("new")}>New command</button>
          </>
        ) : (
          <form className="dg-tform" onSubmit={(e) => { e.preventDefault(); if (!valid) return; void onSave({ folder: current?.folderName ?? null, name, instruction }).then((c) => c && setEditing(null)); }}>
            <label className="dg-field"><span>Name</span><input type="text" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} /></label>
            <label className="dg-field"><span>Instruction</span><textarea rows={8} value={instruction} onChange={(e) => setInstruction(e.target.value)} /></label>
            <div className="dg-actions">
              <button type="submit" className="dg-btn dg-primary" disabled={!valid || busy}>{current ? "Save changes" : "Create command"}</button>
              <button type="button" className="dg-btn" onClick={() => setEditing(null)}>Back</button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
