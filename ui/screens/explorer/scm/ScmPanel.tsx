// Source Control panel (local git only). S-H mounts the default export in the Explorer panel switcher.
// Wiring only: behaviour is in `controller.ts` / `model.ts`; every git call goes through the Rust host.
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { Chip, StatusBanner } from "@llmide/ui-kit";
import { createHostScm, type ScmApi } from "./api";
import { BranchesView } from "./BranchesView";
import { ChangesView } from "./ChangesView";
import { ScmController, type ScmTab } from "./controller";
import { HistoryView } from "./HistoryView";
import { HunkPane } from "./HunkPane";
import { displayLine } from "./model";

export interface ScmPanelProps {
  /** The open project (any non-null value means "a project is open"; paths to the host are always root-relative). */
  projectRoot: string | null;
  onOpenFile: (path: string) => void;
  onOpenDiff: (path: string, staged: boolean) => void;
  /** Called after discard / checkout changed files on disk, so open editors and the tree can reload. */
  onFilesChanged?: () => void;
  /** Tests inject a fake host or a prepared controller. */
  api?: ScmApi;
  controller?: ScmController;
}

const TABS: { id: ScmTab; label: string }[] = [
  { id: "changes", label: "Changes" },
  { id: "history", label: "History" },
  { id: "branches", label: "Branches" },
];

export function ScmPanel({ projectRoot, onOpenFile, onOpenDiff, onFilesChanged, api, controller: injected }: ScmPanelProps) {
  const controller = useMemo(() => injected ?? new ScmController({ api: api ?? createHostScm(), onFilesChanged }), [injected, api, onFilesChanged]);
  const snap = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);

  useEffect(() => {
    if (injected && injected.getSnapshot().root === projectRoot) return;
    void controller.init(projectRoot);
  }, [controller, projectRoot, injected]);

  // Files change outside the app (terminal, other tools): re-read when the window regains focus.
  useEffect(() => {
    const again = () => { if (document.visibilityState !== "hidden") void controller.refresh(); };
    window.addEventListener("focus", again);
    document.addEventListener("visibilitychange", again);
    return () => {
      window.removeEventListener("focus", again);
      document.removeEventListener("visibilitychange", again);
    };
  }, [controller]);
  useEffect(() => () => { if (!injected) controller.dispose(); }, [controller, injected]);

  const st = snap.status;
  const branchLabel = st ? (st.branch ?? (st.head ? `detached at ${st.head.slice(0, 7)}` : "no commits yet")) : "";

  return (
    <section className="scm-root" aria-label="Source Control">
      <header className="scm-head">
        <h2 className="scm-title">Source Control</h2>
        {st && <Chip label={displayLine(branchLabel) + (st.ahead ? ` ↑${st.ahead}` : "") + (st.behind ? ` ↓${st.behind}` : "")} compact />}
        <span className="ex-spacer" />
        <button type="button" className="ui-icon-button" aria-label="Refresh changes" title="Refresh" disabled={!projectRoot || snap.busy !== null} onClick={() => void controller.refresh()}>⟳</button>
      </header>
      {!projectRoot && <div className="scm-empty">Open a project to see its changes.</div>}
      {projectRoot && snap.fatal && (
        <div className="scm-fatal" role="alert">
          <strong>{snap.fatal.title}</strong>
          <p>{snap.fatal.detail}</p>
          {snap.fatal.steps.length > 0 && <pre className="scm-steps">{snap.fatal.steps.join("\n")}</pre>}
          <button type="button" className="ex-tool" onClick={() => void controller.refresh()}>Check again</button>
        </div>
      )}
      {projectRoot && !snap.fatal && (
        <>
          <div className="scm-tabs" role="tablist" aria-label="Source Control views">
            {TABS.map((t) => (
              <button key={t.id} type="button" role="tab" id={`scm-tab-${t.id}`} aria-selected={snap.tab === t.id} aria-controls="scm-tabpanel" tabIndex={snap.tab === t.id ? 0 : -1} className="scm-tab" onClick={() => controller.setTab(t.id)}>
                {t.label}
                {t.id === "changes" && snap.counts.staged + snap.counts.changes + snap.counts.untracked + snap.counts.conflicts > 0 && (
                  <span className="ex-badge" aria-hidden="true">{(snap.counts.staged + snap.counts.changes + snap.counts.untracked + snap.counts.conflicts).toLocaleString()}</span>
                )}
              </button>
            ))}
          </div>
          <div className="scm-live" role="status" aria-live="polite">
            {snap.notice && snap.notice.kind === "info" && <StatusBanner severity="info" message={snap.notice.text} onDismiss={() => controller.dismissNotice()} />}
          </div>
          {snap.notice && snap.notice.kind === "error" && (
            <StatusBanner severity="error" message={snap.notice.info ? `${snap.notice.info.title}. ${snap.notice.info.detail}` : snap.notice.text} onDismiss={() => controller.dismissNotice()} />
          )}
          <div id="scm-tabpanel" role="tabpanel" aria-labelledby={`scm-tab-${snap.tab}`} className="scm-tabpanel">
            {snap.tab === "changes" && (
              <>
                <ChangesView controller={controller} snap={snap} onOpenFile={onOpenFile} onOpenDiff={onOpenDiff} />
                <HunkPane controller={controller} snap={snap} />
              </>
            )}
            {snap.tab === "history" && <HistoryView controller={controller} snap={snap} />}
            {snap.tab === "branches" && <BranchesView controller={controller} snap={snap} />}
          </div>
        </>
      )}
    </section>
  );
}
