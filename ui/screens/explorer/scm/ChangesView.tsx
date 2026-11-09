// Changes tab: virtualised grouped list (10,000+ files render a fixed window) and the commit box.
import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { StatusBanner } from "@llmide/ui-kit";
import { ContextMenu, type MenuItem } from "../ContextMenu";
import { invokeHost } from "../../shell/host";
import type { ScmController, ScmSnapshot } from "./controller";
import {
  GROUP_LABEL, HOOKS_NOTE, MAX_MESSAGE_BYTES, ROW_HEIGHT, TOO_MANY_NOTICE, displayLine, letterWord, rowKey, scrollToReveal, splitPath, validateAmend,
  validateCommit, windowRows, type FileItem, type Row,
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
  /** Right-click on a file row: the Mac's per-file menu (stage, discard, copy path, reveal). */
  const [menu, setMenu] = useState<{ x: number; y: number; item: FileItem } | null>(null);
  /** Discard all: untracked files go to the Trash only when this is ticked (the host dialog states the choice). */
  const [withUntracked, setWithUntracked] = useState(true);
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
  const busy = snap.busy !== null;
  const merging = snap.status?.merging === true;

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
        {merging && (
          <>
            <span className="scm-help" role="status">A merge is in progress. Resolve the conflicts, stage the files and commit, or abort.</span>
            <button type="button" className="ex-tool" aria-label="Abort merge" disabled={busy} onClick={() => void controller.abortMerge()}>Abort merge</button>
          </>
        )}
        <span className="ex-spacer" />
        <span className="scm-count" aria-live="polite">{total === 0 ? "No changes" : `${total.toLocaleString()} change${total === 1 ? "" : "s"}`}</span>
        <label className="scm-help">
          <input type="checkbox" aria-label="Include untracked files in Discard all" checked={withUntracked} disabled={busy} onChange={(e) => setWithUntracked(e.target.checked)} /> Untracked too
        </label>
        <button
          type="button"
          className="ex-tool"
          aria-label="Discard all changes"
          title="Restores every change to HEAD, staged and unstaged. Untracked files go to the Trash only when ticked."
          disabled={busy || total === 0 || c.conflicts > 0 || merging}
          onClick={() => void controller.discardAll(withUntracked)}
        >
          Discard all
        </button>
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
          <ScmRow key={rowKey(r)} row={r} index={win.start + k} size={rows.length} snap={snap} controller={controller} busy={busy} onOpen={open} onOpenFile={onOpenFile} onMenu={(item, x, y) => setMenu({ x, y, item })} />
        ))}
        <div style={{ height: win.padBottom }} data-pad="bottom" aria-hidden="true" />
      </div>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          label="Change actions"
          items={changeMenu(menu.item)}
          onPick={(id) => {
            const item = menu.item;
            setMenu(null);
            if (id === "stage") void controller.stageItem(item);
            else if (id === "unstage") void controller.unstageItem(item);
            else if (id === "discard") void controller.discard([item]);
            else if (id === "copy") void navigator.clipboard?.writeText(item.entry.path).catch(() => undefined);
            else if (id === "reveal") void invokeHost("reveal_in_os", { relPath: item.entry.path }).catch(() => undefined);
          }}
          onClose={() => setMenu(null)}
        />
      )}
      <CommitBox controller={controller} snap={snap} busy={busy} />
    </div>
  );
}

/** The per-file menu. Discard is offered only where the Mac offers it (working-tree and untracked files). */
export function changeMenu(item: FileItem): MenuItem[] {
  const { group, entry } = item;
  const staging: MenuItem = group === "staged"
    ? { id: "unstage", label: "Unstage" }
    : { id: "stage", label: group === "conflicts" ? "Mark resolved (stage)" : "Stage" };
  const discard = (group === "changes" || group === "untracked") && !entry.submodule ? [{ id: "discard", label: "Discard Changes", danger: true }] : [];
  return [staging, ...discard, { id: "copy", label: "Copy Path", separator: true }, { id: "reveal", label: "Reveal in Finder" }];
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
  onMenu: (item: FileItem, x: number, y: number) => void;
}

function ScmRow({ row, index, size, snap, controller, busy, onOpen, onOpenFile, onMenu }: RowProps) {
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
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(item, e.clientX, e.clientY);
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

function CommitBox({ controller, snap, busy }: { controller: ScmController; snap: ScmSnapshot; busy: boolean }) {
  const id = snap.identity;
  const [amend, setAmend] = useState(false);
  const c = snap.counts;
  const check = amend ? validateAmend(snap.message, c.staged, c.conflicts) : validateCommit(snap.message, c.staged, c.conflicts);
  // An amend that landed leaves the box in its normal mode, so the next commit is not amended by accident.
  const submit = async () => {
    if (amend) {
      if (await controller.amend(snap.message)) setAmend(false);
    } else {
      await controller.commit();
    }
  };
  return (
    <form
      className="scm-commit"
      aria-label="Commit"
      onSubmit={(e) => { e.preventDefault(); if (check.ok && !busy) void submit(); }}
    >
      {id.state === "missing" && (
        <div className="scm-identity" role="alert">
          <strong>Set your git identity to commit.</strong>
          <pre className="scm-steps">{'git config --global user.name "Your Name"\ngit config --global user.email "you@example.com"'}</pre>
          <span>LLM-IDE never writes your git config. Run these in a terminal, then commit again.</span>
        </div>
      )}
      {id.state === "ok" && id.value && <div className="scm-as">{`Committing as ${displayLine(id.value.name)} <${displayLine(id.value.email)}>`}</div>}
      <label className="scm-help">
        <input
          type="checkbox"
          aria-label="Amend last commit"
          checked={amend}
          disabled={busy || !snap.status?.head}
          onChange={(e) => { setAmend(e.target.checked); controller.cancelAmendAnyway(); }}
        />{" "}
        Amend last commit
      </label>
      <textarea
        className="scm-message"
        aria-label="Commit message"
        aria-describedby="scm-commit-help"
        placeholder={amend ? "New message (leave empty to keep the last one)" : "Commit message"}
        rows={3}
        value={snap.message}
        disabled={busy}
        spellCheck
        onChange={(e) => controller.setMessage(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && check.ok && !busy) { e.preventDefault(); void submit(); } }}
      />
      {snap.pendingAmend && (
        <div className="scm-confirm" role="alert">
          <p>This commit is already on a remote branch. Amending it rewrites it, so the next push will need a force push.</p>
          <div className="scm-commit-row">
            <button type="button" className="ex-btn" aria-label="Amend anyway" disabled={busy} onClick={() => void controller.amendAnyway()}>Amend anyway</button>
            <button type="button" className="ex-tool" aria-label="Keep the commit" onClick={() => controller.cancelAmendAnyway()}>Keep the commit</button>
          </div>
        </div>
      )}
      <div className="scm-commit-row">
        <button type="submit" className="ex-btn scm-commit-btn" disabled={!check.ok || busy} aria-describedby="scm-commit-help">
          {amend ? "Amend" : `Commit${snap.counts.staged ? ` (${snap.counts.staged.toLocaleString()})` : ""}`}
        </button>
        <span id="scm-commit-help" className="scm-help">
          {check.ok
            ? `${amend ? "Replaces the last commit with your staged changes; the author stays the same. " : ""}${HOOKS_NOTE} Cmd or Ctrl+Enter ${amend ? "amends" : "commits"}.`
            : `${check.reason} ${HOOKS_NOTE}`}
          {check.bytes > MAX_MESSAGE_BYTES * 0.9 && ` ${check.bytes.toLocaleString()} / ${MAX_MESSAGE_BYTES.toLocaleString()} bytes.`}
        </span>
      </div>
    </form>
  );
}
