// Edit preview for a file-editing tool call (Edit, MultiEdit, Write): a "+N -M lines" chip always, the diff on demand
// (built lazily on click, capped). File names are text; an absolute path is shown as its base name unless the host
// resolves it to a project-relative one.
import { useMemo, useState } from "react";
import { callStats, diffRows, editFromTool, hunkView, type EditCall } from "./diff";
import { safeLine } from "../slash/sanitize";

export function displayPath(raw: string, resolve?: (raw: string) => string | null): string {
  const rel = resolve?.(raw) ?? null;
  if (rel) return safeLine(rel, 160);
  const base = raw.split(/[\\/]/).filter(Boolean).pop() ?? "file";
  return safeLine(base, 120) || "file";
}

export function EditPreview({ call, resolvePath }: { call: EditCall; resolvePath?: (raw: string) => string | null }) {
  const [open, setOpen] = useState(false);
  const stats = useMemo(() => callStats(call), [call]);
  const name = displayPath(call.path, resolvePath);
  const bodyId = `edit-${name.replace(/[^\w-]/g, "_")}`;
  return (
    <div className="chat-edit" role="group" aria-label={`Changes to ${name}`}>
      <span className="chat-edit-name">{name}</span>
      <span className="chat-edit-stats" aria-label={`${stats.added} lines added, ${stats.removed} removed${stats.approximate ? ", approximate" : ""}`}>
        <span className="chat-edit-add">+{stats.added}</span> <span className="chat-edit-del">{"−"}{stats.removed}</span>{stats.approximate ? " (approx.)" : ""}
      </span>
      <button type="button" className="chat-link-btn" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen(!open)}>{open ? "Hide diff" : "Show diff"}</button>
      {open && <DiffBody id={bodyId} call={call} />}
    </div>
  );
}

function DiffBody({ id, call }: { id: string; call: EditCall }) {
  const views = useMemo(() => call.edits.slice(0, 20).map((e) => hunkView(diffRows(e.old, e.new).rows)), [call]);
  return (
    <div id={id}>
      {views.map((v, i) => (
        <pre key={i} className="chat-diff" aria-label={call.edits.length > 1 ? `Change ${i + 1}` : "Diff"}>
          {v.rows.map((r, j) => r.op === "skip"
            ? <span key={j} className="chat-diff-skip">{`… ${r.count} unchanged line${r.count === 1 ? "" : "s"}\n`}</span>
            : <span key={j} data-op={r.op}>{`${r.op} ${r.text.length > 300 ? `${r.text.slice(0, 300)}…` : r.text}\n`}</span>)}
          {v.hiddenChanges > 0 && <span className="chat-diff-skip">{`… ${v.hiddenChanges} more changed lines not shown`}</span>}
        </pre>
      ))}
      {call.edits.length > 20 && <p className="chat-muted">{call.edits.length - 20} more changes not shown.</p>}
      {call.kind === "write" && <p className="chat-muted">The file's previous content is not known here, so a Write shows its new content.</p>}
    </div>
  );
}

/** The preview for a tool part, or null when it is not a file edit. */
export function editPreviewFor(tool: { name: string | null; args: string; argsTruncated: boolean }, resolvePath?: (raw: string) => string | null) {
  const call = editFromTool(tool.name, tool.args, tool.argsTruncated);
  return call ? <EditPreview call={call} resolvePath={resolvePath} /> : null;
}
