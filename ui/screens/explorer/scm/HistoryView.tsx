// History tab: paged `git log` (no graph), commit detail with changed files, per-file diff loaded on click.
import { StatusBanner } from "@llmide/ui-kit";
import type { ScmController, ScmSnapshot } from "./controller";
import { displayLine, displayText, relativeTime } from "./model";

export function HistoryView({ controller, snap, now }: { controller: ScmController; snap: ScmSnapshot; now?: number }) {
  const h = snap.history;
  const nowMs = now ?? Date.now();
  if (h.open) return <CommitDetailView controller={controller} snap={snap} />;
  return (
    <div className="scm-history">
      {h.error && <StatusBanner severity="error" message={`${h.error.title}. ${h.error.detail}`} />}
      {!h.loading && !h.error && h.entries.length === 0 && <div className="scm-empty">No commits yet.</div>}
      <ul className="scm-log" aria-label="Commit history">
        {h.entries.map((e) => (
          <li key={e.hash}>
            <button type="button" className="scm-commit-item" aria-label={`${displayLine(e.subject)}, ${displayLine(e.author)}, ${relativeTime(e.time, nowMs)}`} onClick={() => void controller.openCommit(e.hash)}>
              <span className="scm-subject">{displayLine(e.subject) || "(no subject)"}</span>
              <span className="scm-meta">{`${e.short} · ${displayLine(e.author)} · ${relativeTime(e.time, nowMs)}${e.parents > 1 ? " · merge" : ""}`}</span>
            </button>
          </li>
        ))}
      </ul>
      {h.loading && <div className="scm-empty" role="status">Loading history</div>}
      {h.hasMore && !h.loading && (
        <button type="button" className="ex-tool scm-more" onClick={() => void controller.loadLog(false)}>Load more</button>
      )}
    </div>
  );
}

function CommitDetailView({ controller, snap }: { controller: ScmController; snap: ScmSnapshot }) {
  const o = snap.history.open!;
  return (
    <div className="scm-detail">
      <div className="scm-detail-head">
        <button type="button" className="ex-tool" onClick={() => controller.closeCommit()}>Back</button>
        <code className="scm-hash">{o.hash.slice(0, 12)}</code>
      </div>
      {o.status === "loading" && <div className="scm-empty" role="status">Loading commit</div>}
      {o.error && <StatusBanner severity="error" message={`${o.error.title}. ${o.error.detail}`} />}
      {o.detail && (
        <>
          <pre className="scm-message-text" aria-label="Commit message">{displayText(o.detail.message)}</pre>
          <ul className="scm-files" aria-label="Changed files">
            {o.detail.files.map((f) => (
              <li key={f.path}>
                <button type="button" className="scm-file-item" aria-pressed={o.file === f.path} onClick={() => void controller.openCommitFile(f.path)}>
                  <span className="ex-git-letter" aria-hidden="true">{f.status}</span>
                  <span className="scm-name">{displayLine(f.path)}</span>
                </button>
              </li>
            ))}
          </ul>
          {o.detail.truncated && <StatusBanner severity="warning" message="Only the first changed files are listed." />}
        </>
      )}
      {o.diffLoading && <div className="scm-empty" role="status">Loading diff</div>}
      {o.diff && (
        <pre className="scm-diff" tabIndex={0} aria-label={`Diff of ${displayLine(o.file ?? "")}`}>
          {o.diff.text.split("\n").slice(0, 4000).map((l, i) => (
            <span key={i} className="scm-line" data-kind={l[0] === "+" && !l.startsWith("+++") ? "add" : l[0] === "-" && !l.startsWith("---") ? "del" : l.startsWith("@@") ? "hunk" : "ctx"}>{l + "\n"}</span>
          ))}
          {o.diff.truncated && <span className="scm-line" data-kind="hunk">{"… diff truncated\n"}</span>}
        </pre>
      )}
    </div>
  );
}
