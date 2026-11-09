// Review, Ship and Discard for a finished Factory run (spec A4). The diff is the run's worktree against HEAD with
// .factory/ excluded (host loop_worktree_diff). Ship is the one human approval: the core route POST /kb/loop/ship
// commits, scans for secrets, pushes and opens a DRAFT pull/merge request. Discard removes the worktree and branch.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { StatusBanner } from "@llmide/ui-kit";
import type { FsApi } from "../../explorer/fs";
import { displayText } from "../../explorer/scm/model";
import { invokeHost } from "../../shell/host";
import { core } from "../../shell/runtime";
import { readRepoConfig } from "../../settings/repo-config.ts";
import type { WorkItem } from "./factory.ts";
import { decodeWorktreeDiff, diffLineKind, shipBlockedReason, shipCopy, shipRequest, shipState, shipTarget, splitDiffByFile, type ShipResult, type WorktreeDiff } from "./ship-model.ts";
import type { RunInfo } from "./worktree-run.ts";

const PREVIEW_LINES = 400;

export interface ShipPanelProps {
  info: RunInfo;
  item: WorkItem;
  /** The diff the run end already read; when set the panel does not re-read on mount (the past-run path omits it). */
  initialDiff?: WorktreeDiff;
  /** Ship is offered only after a passed run; Discard always. */
  passed: boolean;
  fs: Pick<FsApi, "read" | "gitStatus">;
  /** Project-relative folder of the run's worktree: `system/loop-worktrees/<run id>`. */
  runPrefix: string;
  onShipped(result: { provider: "github" | "gitlab"; url: string; commit: string; reused: boolean }): void;
  onDiscarded(): void;
  onClose(): void;
}

export function ShipPanel({ info, item, initialDiff, passed, fs, runPrefix, onShipped, onDiscarded, onClose }: ShipPanelProps): ReactNode {
  const [diff, setDiff] = useState<WorktreeDiff | null>(initialDiff ?? null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [review, setReview] = useState("");
  const [base, setBase] = useState("main");
  const [busy, setBusy] = useState(false);
  // In-app confirm bar. `window.confirm` is not used anywhere in this app and is unreliable in the Tauri webview.
  const [confirming, setConfirming] = useState<"ship" | "discard" | null>(null);
  const [shippedUrl, setShippedUrl] = useState<string | null>(null);
  const [message, setMessage] = useState<{ severity: "info" | "warning" | "error"; text: string } | null>(null);
  const config = useMemo(() => readRepoConfig(), []);
  const target = shipTarget(info, config);
  const blocked = target ? shipBlockedReason(config, target.provider) : "This repository is not in Settings → Repositories (with its clone folder), so it cannot be shipped from here.";
  const kind = target?.provider === "gitlab" ? "draft merge request" : "draft pull request";

  useEffect(() => {
    let live = true;
    if (!initialDiff) {
      void invokeHost<unknown>("loop_worktree_diff", { runId: info.runId })
        .then((raw) => { if (live) setDiff(decodeWorktreeDiff(raw)); })
        .catch((e: unknown) => { if (live) setDiffError(e instanceof Error ? e.message : String(e)); });
    }
    void fs.read(`${runPrefix}/.factory/REVIEW.md`, 200_000)
      .then((r) => { if (live && r.status === "ok" && r.text) setReview(r.text); })
      .catch(() => undefined);
    // The project's own branch is the natural target only when the project root is the run's repo.
    if (info.repo === info.project) void fs.gitStatus().then((s) => { if (live && s.branch) setBase(s.branch); }).catch(() => undefined);
    return () => { live = false; };
  }, [fs, info.runId, info.repo, info.project, runPrefix, initialDiff]);

  const ship = async () => {
    if (!target || blocked || busy || !passed) return;
    const repo = { provider: target.provider, slug: target.slug, base: base.trim() };
    if (!repo.base) { setMessage({ severity: "warning", text: "Enter the target branch first." }); return; }
    setConfirming(null);
    setBusy(true);
    setMessage(null);
    let result: ShipResult;
    try {
      const r = await core.request<{ url?: unknown; commit?: unknown; reused?: unknown }>("/kb/loop/ship", { method: "POST", body: shipRequest(info, item, repo, review), timeoutMs: 5 * 60_000 });
      result = { ok: true, url: typeof r.url === "string" ? r.url : "", commit: typeof r.commit === "string" ? r.commit : "", reused: r.reused === true };
    } catch (e) {
      const code = typeof (e as { code?: unknown })?.code === "string" ? (e as { code: string }).code : "error";
      result = { ok: false, code, message: e instanceof Error ? e.message : "" };
    } finally {
      setBusy(false);
    }
    const state = shipState(result);
    setMessage({ severity: state === "shipped" ? "info" : state === "secret" ? "error" : "warning", text: shipCopy(result) });
    if (result.ok) {
      if (/^https:\/\//.test(result.url)) setShippedUrl(result.url);
      onShipped({ provider: target.provider, url: result.url, commit: result.commit, reused: result.reused });
    }
  };

  const discard = async () => {
    if (busy) return;
    setConfirming(null);
    setBusy(true);
    try {
      await invokeHost("loop_worktree_remove", { runId: info.runId });
      onDiscarded();
    } catch (e) {
      setMessage({ severity: "error", text: `The worktree could not be removed: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setBusy(false);
    }
  };

  const files = diff ? splitDiffByFile(diff.text) : [];
  return (
    <section className="loop-card loop-ship" aria-label="Review and ship">
      <div className="loop-inline"><h2>REVIEW AND SHIP</h2><span className="loop-spacer" /><button type="button" className="loop-btn" disabled={busy} onClick={onClose}>Close</button></div>
      <p className="loop-native-hint">{displayText(item.title)} · branch <code>{info.branch}</code> · started from <code>{info.baseCommit.slice(0, 7)}</code></p>
      {message ? <StatusBanner severity={message.severity} message={message.text} onDismiss={() => setMessage(null)} /> : null}
      {diffError ? <StatusBanner severity="error" message={`The diff could not be read: ${diffError}`} /> : null}
      {!diff && !diffError ? <p className="loop-native-hint" role="status">Reading the diff…</p> : null}
      {diff && files.length === 0 ? <p className="loop-native-hint">No changes outside .factory/.</p> : null}
      <ul className="loop-ship-files">
        {files.map((f) => (
          <li key={f.path}>
            <details>
              <summary><code>{displayText(f.path)}</code> <span className="loop-native-hint">+{f.lines.filter((l) => diffLineKind(l) === "add").length} −{f.lines.filter((l) => diffLineKind(l) === "del").length}</span></summary>
              <pre className="loop-diff" tabIndex={0} aria-label={`Diff of ${displayText(f.path)}`}>
                {f.lines.slice(0, PREVIEW_LINES).map((l, i) => <span key={i} className="loop-diff-line" data-kind={diffLineKind(l)}>{displayText(l) + "\n"}</span>)}
                {f.lines.length > PREVIEW_LINES ? <span className="loop-diff-line" data-kind="hunk">{`… ${f.lines.length - PREVIEW_LINES} more lines\n`}</span> : null}
              </pre>
            </details>
          </li>
        ))}
      </ul>
      {diff?.truncated ? <p className="loop-warn">The diff is too large to show in full. Ship commits every change, including the part not shown.</p> : null}
      {!passed ? <p className="loop-native-hint">Ship is offered only after a passed run. You can still discard this worktree.</p> : null}
      {passed && blocked ? <p className="loop-warn">{blocked}</p> : null}
      <label className="loop-field"><span>Target branch</span><input value={base} disabled={busy} onChange={(e) => setBase(e.target.value)} /></label>
      {confirming === "ship" && target ? (
        <div className="loop-confirm" role="alertdialog" aria-label="Confirm ship">
          <p className="loop-warn">{`Ship ${info.branch} as a ${kind} to ${target.slug} (${target.provider}), into ${base.trim() || "(no target branch)"}? This commits the worktree changes (never .factory/), pushes ${info.branch} with your git credentials and opens a ${kind}. Nothing is merged.`}</p>
          <div className="loop-inline">
            <button type="button" className="loop-btn loop-btn-primary" disabled={busy} onClick={() => void ship()}>Confirm ship</button>
            <button type="button" className="loop-btn" disabled={busy} onClick={() => setConfirming(null)}>Cancel</button>
          </div>
        </div>
      ) : null}
      {confirming === "discard" ? (
        <div className="loop-confirm" role="alertdialog" aria-label="Confirm discard">
          <p className="loop-warn">{`Discard this run? The worktree system/loop-worktrees/${info.runId} and the branch ${info.branch} are deleted, with every change in them.`}</p>
          <div className="loop-inline">
            <button type="button" className="loop-btn loop-btn-primary" disabled={busy} onClick={() => void discard()}>Confirm discard</button>
            <button type="button" className="loop-btn" disabled={busy} onClick={() => setConfirming(null)}>Cancel</button>
          </div>
        </div>
      ) : null}
      <div className="loop-inline">
        <button type="button" className="loop-btn loop-btn-primary" disabled={busy || !passed || blocked !== null || !diff || files.length === 0} onClick={() => setConfirming("ship")}>{busy ? "Working…" : "Ship as draft…"}</button>
        {shippedUrl ? <button type="button" className="loop-btn" onClick={() => { void invokeHost("open_external_url", { url: shippedUrl }).catch(() => undefined); }}>Open {kind}</button> : null}
        <button type="button" className="loop-btn" disabled={busy} onClick={() => setConfirming("discard")}>Discard…</button>
      </div>
    </section>
  );
}
