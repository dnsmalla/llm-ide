// Template manager: project templates are files in the project (written through the core); kit built-ins are copied
// into the project on first use, so every template listed here can be edited or deleted.
import { useId, useState, type ReactNode } from "react";
import { StatusBanner } from "@llmide/ui-kit";
import type { Failure } from "./errors.ts";
import { MAX_SECTIONS, type DocTemplate } from "./model.ts";

export interface TemplateManagerProps {
  templates: readonly DocTemplate[];
  busy: boolean;
  error: Failure | null;
  onSave: (input: { folder: string | null; name: string; sections: string[] }) => Promise<DocTemplate | null>;
  onDelete: (t: DocTemplate) => Promise<boolean>;
  onClose: () => void;
  /** Test hook. */
  initialEditing?: string | "new" | null;
}

export function parseSections(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(/^#+\s*/, "").trim())
    .filter(Boolean)
    .slice(0, MAX_SECTIONS * 3);
}

export function TemplateManager({ templates, busy, error, onSave, onDelete, onClose, initialEditing = null }: TemplateManagerProps): ReactNode {
  const titleId = useId();
  const [editing, setEditing] = useState<string | "new" | null>(initialEditing);
  const [confirm, setConfirm] = useState<string | null>(null);
  const current = editing && editing !== "new" ? templates.find((t) => t.id === editing) ?? null : null;
  const [name, setName] = useState(current?.name ?? "");
  const [sections, setSections] = useState(current ? current.sections.join("\n") : "");
  const start = (id: string | "new") => {
    const t = id === "new" ? null : templates.find((x) => x.id === id) ?? null;
    setEditing(id);
    setName(t?.name ?? "");
    setSections(t ? t.sections.join("\n") : "");
  };
  const parsed = parseSections(sections);
  const valid = name.trim() !== "" && parsed.length > 0 && parsed.length <= MAX_SECTIONS;
  return (
    <div className="dg-dialog-wrap">
      <div className="dg-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="dg-bar">
          <h2 id={titleId} className="dg-h2">
            Templates
          </h2>
          <button type="button" className="dg-btn" onClick={onClose}>
            Close
          </button>
        </div>
        {error && <StatusBanner severity="error" message={<>{error.message}</>} />}
        {editing === null ? (
          <>
            <ul className="dg-tlist" aria-label="Templates">
              {templates.map((t) => (
                <li key={t.id} className="dg-trow">
                  <span className="dg-name">{t.name}</span>
                  <span className="dg-muted">{t.sections.length} sections</span>
                  {t.isProjectTemplate ? (
                    <>
                      <button type="button" className="dg-link" onClick={() => start(t.id)} aria-label={`Edit ${t.name}`}>
                        Edit
                      </button>
                      {confirm === t.id ? (
                        <>
                          <button type="button" className="dg-link dg-danger" disabled={busy} onClick={() => onDelete(t).then(() => setConfirm(null))}>
                            Delete {t.name}?
                          </button>
                          <button type="button" className="dg-link" onClick={() => setConfirm(null)}>
                            Keep
                          </button>
                        </>
                      ) : (
                        <button type="button" className="dg-link" onClick={() => setConfirm(t.id)} aria-label={`Delete ${t.name}`}>
                          Delete
                        </button>
                      )}
                    </>
                  ) : (
                    <span className="dg-muted">built in</span>
                  )}
                </li>
              ))}
              {templates.length === 0 && <li className="dg-muted">No templates yet.</li>}
            </ul>
            <button type="button" className="dg-btn dg-primary" onClick={() => start("new")}>
              New template
            </button>
          </>
        ) : (
          <form
            className="dg-tform"
            onSubmit={(e) => {
              e.preventDefault();
              if (!valid) return;
              onSave({ folder: current?.folderName ?? null, name, sections: parsed }).then((t) => t && setEditing(null));
            }}
          >
            <label className="dg-field">
              <span>Name</span>
              <input type="text" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="dg-field">
              <span>Sections, one per line</span>
              <textarea rows={8} value={sections} onChange={(e) => setSections(e.target.value)} />
            </label>
            <p className="dg-muted">
              {parsed.length} of {MAX_SECTIONS} sections. A template needs at least one.
            </p>
            <div className="dg-actions">
              <button type="submit" className="dg-btn dg-primary" disabled={!valid || busy}>
                {current ? "Save changes" : "Create template"}
              </button>
              <button type="button" className="dg-btn" onClick={() => setEditing(null)}>
                Back
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
