// Changes tab: virtualised grouped list (10,000+ files render a fixed window) and the commit box.
import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { StatusBanner } from "@llmide/ui-kit";
import type { ScmController, ScmSnapshot } from "./controller";
import {
  GROUP_LABEL, HOOKS_NOTE, MAX_MESSAGE_BYTES, ROW_HEIGHT, TOO_MANY_NOTICE, displayLine, letterWord, rowKey, scrollToReveal, splitPath, windowRows,
  type FileItem, type Row,
} from "./model";

export interface ChangesProps {
  controller: ScmController;
  snap: ScmSnapshot;
  onOpenFile: (path: string) => void;
  onOpenDiff: (path: string, staged: boolean) => void;
  /** Initial viewport height before the first measurement (tests, first paint). */
  initialViewport?: number;
}

const GROUP_HINT: Partial<Record<keyof typeof GROUP_LABEL, string>> = {
  conflicts: "Resolve by editing the file, then stage it to mark it resolved.",
};

export function ChangesView({ controller, snap, onOpenFile, onOpenDiff, initialViewport = 480 }: ChangesProps) {
  const scroller = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(initialViewport);
  useEffect(() => {
    const el = scroller.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setViewport(el.clientHeight || initialViewport));
    ro.observe(el);
    setViewport(el.clientHeight || initialViewport);
    return () => ro.disconnect();
  }, [initialViewport]);

  const rows = snap.rows;
  const win = windowRows(rows.length, scrollTop, viewport);
  const open = (item: FileItem) => {
    const { entry, group } = item;
    if (group === "conflicts" || group === "untracked") onOpenFile(entry.path.replace(/\/$/, ""));
    else onOpenDiff(entry.path, group === "staged");
  };

  const focusIndex = snap.focusKey ? rows.findIndex((r) => rowKey(r) === snap.focusKey) : -1;
  const reveal = (key: string | null) => {
    const el = scroller.current;
    if (!el || !key) return;
    const i = rows.findIndex((r) => rowKey(r) === key);
    const to = i < 0 ? null : scrollToReveal(i, el.scrollTop, el.clientHeight || viewport);
    if (to !== null) el.scrollTop = to;
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = (d: number) => {
      e.preventDefault();
      reveal(controller.moveFocus(d));
    };
    if (e.key === "ArrowDown") step(1);
    else if (e.key === "ArrowUp") step(-1);
    else if (e.key === "PageDown") step(Math.max(1, Math.floor(viewport / ROW_HEIGHT) - 1));
    else if (e.key === "PageUp") step(-Math.max(1, Math.floor(viewport / ROW_HEIGHT) - 1));
    else if (e.key === "Home") step(-rows.length);
    else if (e.key === "End") step(rows.length);
    else if ((e.key === "Enter" || e.key === " ") && focusIndex >= 0) {
      e.preventDefault();
      const r = rows[focusIndex];
      if (r.type === "header") controller.toggleGroup(r.group);
      else if (e.key === " ") controller.select(r.item.key, { shift: e.shiftKey, toggle: true });
      else open(r.item);
    } else if (e.key === "Escape") controller.clearSelection();
  };

  const c = snap.counts;
  const total = c.staged + c.changes + c.untracked + c.conflicts;
  const check = controller.commitCheck();
  const busy = snap.busy !== null;

  return (
    <div className="scm-changes">
      {snap.status?.truncated && <StatusBanner severity="warning" message={TOO_MANY_NOTICE} />}
      <div className="scm-bulk" role="toolbar" aria-label="Bulk actions">
        <button type="button" className="ex-tool" disabled={busy || c.changes + c.untracked === 0 || c.conflicts > 0} title={c.conflicts > 0 ? "Resolve conflicts first" : "Stage every change"} onClick={() => void controller.stageAll(true)}>
          Stage all
        </button>
        <button type="button" className="ex-tool" disabled={busy || c.staged === 0} onClick={() => void controller.stageAll(false)}>
          Unstage all
        </button>
        <span className="ex-spacer" />
        <span className="scm-count" aria-live="polite">{total === 0 ? "No changes" : `${total.toLocaleString()} change${total === 1 ? "" : "s"}`}</span>
      </div>
      <div
        ref={scroller}
        className="scm-list"
        role="tree"
        aria-label="Changes"
        aria-multiselectable="true"
        aria-busy={snap.phase === "loading" || undefined}
        aria-activedescendant={focusIndex >= win.start && focusIndex < win.end ? `scm-row-${focusIndex}` : undefined}
        tabIndex={0}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        onKeyDown={onKey}
        onFocus={() => snap.focusKey === null && rows.length > 0 && controller.setFocus(rowKey(rows[0]))}
      >
        {snap.phase === "loading" && rows.length === 0 && <div className="scm-empty" role="status">Reading changes</div>}
        {snap.phase === "ready" && rows.length === 0 && <div className="scm-empty">Working tree clean.</div>}
        <div style={{ height: win.padTop }} data-pad="top" aria-hidden="true" />
        {rows.slice(win.start, win.end).map((r, k) => (
          <ScmRow key={rowKey(r)} row={r} index={win.start + k} size={rows.length} snap={snap} controller={controller} busy={busy} onOpen={open} onOpenFile={onOpenFile} />
        ))}
        <div style={{ height: win.padBottom }} data-pad="bottom" aria-hidden="true" />
      </div>
      <CommitBox controller={controller} snap={snap} check={check} busy={busy} />
    </div>
  );
}

interface RowProps {
  row: Row;
  index: number;
  size: number;
  snap: ScmSnapshot;
  controller: ScmController;
  busy: boolean;
  onOpen: (item: FileItem) => void;
  onOpenFile: (path: string) => void;
}

function ScmRow({ row, index, size, snap, controller, busy, onOpen, onOpenFile }: RowProps) {
  const focused = snap.focusKey === rowKey(row);
  if (row.type === "header") {
    return (
      <div
        id={`scm-row-${index}`}
        className="scm-row scm-header"
        role="treeitem"
        aria-level={1}
        aria-expanded={!row.collapsed}
        aria-posinset={index + 1}
        aria-setsize={size}
        aria-label={`${GROUP_LABEL[row.group]}, ${row.count} file${row.count === 1 ? "" : "s"}`}
        data-group={row.group}
        data-focused={focused}
        style={{ height: ROW_HEIGHT }}
        onClick={() => { controller.setFocus(rowKey(row)); controller.toggleGroup(row.group); }}
      >
        <span className="ex-chevron" aria-hidden="true">{row.collapsed ? "▸" : "▾"}</span>
        <span className="scm-group-name">{GROUP_LABEL[row.group]}</span>
        <span className="ex-badge" aria-hidden="true">{row.count.toLocaleString()}</span>
        {GROUP_HINT[row.group] && !row.collapsed && <span className="scm-hint" title={GROUP_HINT[row.group]}>{GROUP_HINT[row.group]}</span>}
      </div>
    );
  }
  const item = row.item;
  const { entry, group } = item;
  const { dir, name } = splitPath(entry.path);
  const selected = snap.selection.keys.has(item.key);
  const stop = (fn: () => void) => (e: MouseEvent) => { e.stopPropagation(); fn(); };
  const dirText = displayLine(dir);
  const label = `${displayLine(name)}, ${letterWord(item.letter)}${entry.submodule ? ", submodule" : ""}${entry.orig_path ? `, renamed from ${displayLine(entry.orig_path)}` : ""}, ${GROUP_LABEL[group]}`;
  return (
    <div
      id={`scm-row-${index}`}
      className="scm-row scm-file"
      role="treeitem"
      aria-level={2}
      aria-selected={selected}
      aria-posinset={index + 1}
      aria-setsize={size}
      aria-label={label}
      data-group={group}
      data-letter={item.letter}
      data-focused={focused}
      style={{ height: ROW_HEIGHT }}
      onClick={(e) => {
        controller.select(item.key, { shift: e.shiftKey, toggle: e.metaKey || e.ctrlKey });
        if (!e.shiftKey && !e.metaKey && !e.ctrlKey) onOpen(item);
      }}
    >
      <span className="scm-name">{displayLine(name)}</span>
      {dirText && <span className="scm-dir">{dirText}</span>}
      {entry.orig_path && <span className="scm-dir" title={`renamed from ${displayLine(entry.orig_path)}`}>{`← ${displayLine(entry.orig_path)}`}</span>}
      {entry.submodule && <span className="ex-badge">submodule</span>}
      <span className="scm-actions">
        {group === "conflicts" && <button type="button" className="ui-icon-button" aria-label={`Open ${displayLine(name)}`} title="Open file" onClick={stop(() => onOpenFile(entry.path))}>↗</button>}
        {(group === "changes" || group === "staged") && !entry.submodule && (
          <button type="button" className="ui-icon-button" aria-label={`Select hunks of ${displayLine(name)}`} title="Stage by hunk" disabled={busy} onClick={stop(() => void controller.openHunks(entry.path, group === "staged"))}>≡</button>
        )}
        {(group === "changes" || group === "untracked") && !entry.submodule && (
          <button type="button" className="ui-icon-button" aria-label={`Discard changes to ${displayLine(name)}`} title="Discard…" disabled={busy} onClick={stop(() => void controller.discard([item]))}>↶</button>
        )}
        {group !== "staged" && <button type="button" className="ui-icon-button" aria-label={`${group === "conflicts" ? "Mark resolved" : "Stage"} ${displayLine(name)}`} title={group === "conflicts" ? "Mark resolved (stage)" : "Stage"} disabled={busy} onClick={stop(() => void controller.stageItem(item))}>+</button>}
        {group === "staged" && <button type="button" className="ui-icon-button" aria-label={`Unstage ${displayLine(name)}`} title="Unstage" disabled={busy} onClick={stop(() => void controller.unstageItem(item))}>−</button>}
      </span>
      <span className="ex-git-letter" aria-hidden="true">{item.letter}</span>
    </div>
  );
}

function CommitBox({ controller, snap, check, busy }: { controller: ScmController; snap: ScmSnapshot; check: ReturnType<ScmController["commitCheck"]>; busy: boolean }) {
  const id = snap.identity;
  return (
    <form
      className="scm-commit"
      aria-label="Commit"
      onSubmit={(e) => { e.preventDefault(); if (check.ok && !busy) void controller.commit(); }}
    >
      {id.state === "missing" && (
        <div className="scm-identity" role="alert">
          <strong>Set your git identity to commit.</strong>
          <pre className="scm-steps">{'git config --global user.name "Your Name"\ngit config --global user.email "you@example.com"'}</pre>
          <span>LLM-IDE never writes your git config. Run these in a terminal, then commit again.</span>
        </div>
      )}
      {id.state === "ok" && id.value && <div className="scm-as">{`Committing as ${displayLine(id.value.name)} <${displayLine(id.value.email)}>`}</div>}
      <textarea
        className="scm-message"
        aria-label="Commit message"
        aria-describedby="scm-commit-help"
        placeholder="Commit message"
        rows={3}
        value={snap.message}
        disabled={busy}
        spellCheck
        onChange={(e) => controller.setMessage(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && check.ok && !busy) { e.preventDefault(); void controller.commit(); } }}
      />
      <div className="scm-commit-row">
        <button type="submit" className="ex-btn scm-commit-btn" disabled={!check.ok || busy} aria-describedby="scm-commit-help">
          {`Commit${snap.counts.staged ? ` (${snap.counts.staged.toLocaleString()})` : ""}`}
        </button>
        <span id="scm-commit-help" className="scm-help">
          {check.ok ? `${HOOKS_NOTE} Cmd or Ctrl+Enter commits.` : `${check.reason} ${HOOKS_NOTE}`}
          {check.bytes > MAX_MESSAGE_BYTES * 0.9 && ` ${check.bytes.toLocaleString()} / ${MAX_MESSAGE_BYTES.toLocaleString()} bytes.`}
        </span>
      </div>
    </form>
  );
}
