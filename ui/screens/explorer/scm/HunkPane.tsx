// Hunk staging pane: lists the hunks of one file (text only, size-capped host-side) with checkboxes.
import { useState } from "react";
import { StatusBanner } from "@llmide/ui-kit";
import type { ScmController, ScmSnapshot } from "./controller";
import { displayLine } from "./model";

const PREVIEW_LINES = 40;

export function HunkPane({ controller, snap }: { controller: ScmController; snap: ScmSnapshot }) {
  const h = snap.hunks;
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());
  if (!h) return null;
  const count = h.diff?.hunks.length ?? 0;
  const picked = h.selected.size;
  const verb = h.staged ? "Unstage" : "Stage";
  const busy = snap.busy !== null;
  return (
    <section className="scm-hunks" aria-label={`Hunks of ${displayLine(h.path)}`}>
      <header className="scm-hunks-head">
        <strong className="scm-hunks-title">{displayLine(h.path)}</strong>
        <span className="ex-meta">{h.staged ? "staged" : "unstaged"}</span>
        <span className="ex-spacer" />
        <button type="button" className="ui-icon-button" aria-label="Close hunk list" title="Close" onClick={() => controller.closeHunks()}>×</button>
      </header>
      {h.status === "loading" && <div className="scm-empty" role="status">Reading hunks</div>}
      {h.status === "error" && h.error && <StatusBanner severity="error" message={`${h.error.title}. ${h.error.detail}`} />}
      {h.status === "ready" && h.diff?.truncated && <StatusBanner severity="warning" message="This diff is too large to stage by hunk. Stage the whole file." />}
      {h.status === "ready" && h.diff && !h.diff.truncated && count === 0 && <div className="scm-empty">No hunks to select (new, deleted or binary file, or only a mode change). Stage the whole file instead.</div>}
      {h.status === "ready" && h.diff && !h.diff.truncated && count > 0 && (
        <>
          <div className="scm-hunks-bar" role="toolbar" aria-label="Hunk actions">
            <button type="button" className="ex-btn" disabled={busy || picked === 0} onClick={() => void controller.applyHunks()}>{`${verb} ${picked} hunk${picked === 1 ? "" : "s"}`}</button>
            <button type="button" className="ex-tool" onClick={() => controller.selectAllHunksNow()}>Select all</button>
            <button type="button" className="ex-tool" disabled={picked === 0} onClick={() => controller.clearHunks()}>Clear</button>
          </div>
          <ol className="scm-hunk-list">
            {h.diff.hunks.map((hk) => {
              const long = hk.lines.length > PREVIEW_LINES && !expanded.has(hk.index);
              const shown = long ? hk.lines.slice(0, PREVIEW_LINES) : hk.lines;
              return (
                <li key={hk.index} className="scm-hunk">
                  <label className="scm-hunk-head">
                    <input type="checkbox" checked={h.selected.has(hk.index)} onChange={() => controller.toggleHunkAt(hk.index)} aria-label={`Hunk ${hk.index + 1}: ${hk.header}, ${hk.added} added, ${hk.removed} removed`} />
                    <code className="scm-hunk-header">{hk.header}</code>
                    <span className="scm-add">{`+${hk.added}`}</span>
                    <span className="scm-del">{`−${hk.removed}`}</span>
                  </label>
                  <pre className="scm-hunk-body" tabIndex={0} aria-label={`Hunk ${hk.index + 1} lines`}>
                    {shown.map((l, i) => (
                      <span key={i} className="scm-line" data-kind={l[0] === "+" ? "add" : l[0] === "-" ? "del" : "ctx"}>{l + "\n"}</span>
                    ))}
                  </pre>
                  {long && (
                    <button type="button" className="ex-link" onClick={() => setExpanded(new Set([...expanded, hk.index]))}>{`Show ${hk.lines.length - PREVIEW_LINES} more lines`}</button>
                  )}
                </li>
              );
            })}
          </ol>
        </>
      )}
    </section>
  );
}
