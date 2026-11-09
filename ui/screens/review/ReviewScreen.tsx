// Review Conflicts: the Mac's tree + viewer + Code Assistant layout over the project's code and llm-doc folders.
// It is deliberately read-only — reviewing is a conversation with the assistant; editing belongs in Explorer.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { FileTreeRow, FolderIcon, Icon, StatusBanner } from "@llmide/ui-kit";
import { fileKind, fileKindIcon } from "../explorer/file-kind.ts";
import type { SectionProps } from "../shell/sections";
import { ChatDockSlot } from "../shell/chat-dock";
import { ChatDockToggle } from "../shell/ChatDockToggle";
import { shellBus } from "../shell/bus";
import { Markdown } from "../chat/MarkdownView";
import { readRepoConfig } from "../settings/repo-config.ts";
import { REVIEW_EMPTY, REVIEW_ROOTS, closeReviewTab, decodeEntries, decodeFile, listTruncation, openFolderChildren, pickLinkedRepo, readChildren, refreshGate, type ReviewEntry } from "./review-model.ts";
import "./review.css";

export interface ReviewDeps {
  list: (path: string) => Promise<unknown>;
  read: (path: string) => Promise<unknown>;
}

export function ReviewScreen({ active, projectRoot, deps }: SectionProps & { deps: ReviewDeps }): ReactNode {
  const [roots, setRoots] = useState<{ root: (typeof REVIEW_ROOTS)[number]; entries: ReviewEntry[]; error: boolean; more: { shown: number; total: number | null } | null }[]>([]);
  const [children, setChildren] = useState<Map<string, ReviewEntry[]>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<{ path: string; text: string; bytes: number } | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showChat, setShowChat] = useState(() => {
    try { return localStorage.getItem("llmide.review.chat") !== "0"; } catch { return true; }
  });
  const [chatWidth, setChatWidth] = useState(() => {
    try { const n = Number(localStorage.getItem("llmide.review.chatWidth")); return Number.isFinite(n) && n >= 240 && n <= 640 ? n : 320; } catch { return 320; }
  });
  const [tabs, setTabs] = useState<string[]>([]);
  // Re-read when the section is shown again, so a repository added or removed in Settings shows up here.
  const linked = useMemo(() => pickLinkedRepo(readRepoConfig().saved), [active, projectRoot]);
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;

  const gate = useRef(refreshGate()).current;
  // Latest-wins for file reads: a file that resolves after a later pick (or after a project switch) is dropped.
  const fileGate = useRef(refreshGate()).current;
  const loadRoots = useCallback(async () => {
    const token = gate.begin();
    setBusy(true);
    const next: typeof roots = [];
    for (const root of REVIEW_ROOTS) {
      try {
        const body = await deps.list(root.path);
        next.push({ root, entries: decodeEntries(body), error: false, more: listTruncation(body) });
      } catch {
        next.push({ root, entries: [], error: true, more: null });
      }
    }
    // A newer refresh (Cmd+R twice, project change) owns the screen now: drop this one's results.
    if (!gate.isCurrent(token)) return;
    setRoots(next);
    // Folders that stay open are re-listed, so a refresh does not leave them open and empty.
    const fresh = new Map(await Promise.all([...expandedRef.current].map(async (p) => [p, await readChildren(deps.list, p)] as const)));
    if (!gate.isCurrent(token)) return;
    // Decided at commit time: a folder opened during the refresh keeps its rows, a closed one is dropped.
    setChildren((prev) => openFolderChildren(expandedRef.current, fresh, prev));
    setBusy(false);
  }, [deps, gate]);

  // A different project has its own tree and files: start from none. The shell also remounts this screen on a switch.
  useEffect(() => {
    fileGate.begin();
    setTabs([]);
    setSelected(null);
    setFileError(null);
    setExpanded(new Set());
    setChildren(new Map());
  }, [fileGate, projectRoot]);
  useEffect(() => {
    if (active) void loadRoots();
  }, [active, loadRoots, projectRoot]);
  useEffect(() => shellBus.subscribe("project-changed", () => { if (active) void loadRoots(); }), [active, loadRoots]);
  useEffect(() => {
    try { localStorage.setItem("llmide.review.chat", showChat ? "1" : "0"); } catch { /* session only */ }
  }, [showChat]);
  useEffect(() => {
    try { localStorage.setItem("llmide.review.chatWidth", String(chatWidth)); } catch { /* session only */ }
  }, [chatWidth]);
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "r") { e.preventDefault(); void loadRoots(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, loadRoots]);

  const openDir = async (path: string) => {
    if (expanded.has(path)) {
      setExpanded((s) => { const n = new Set(s); n.delete(path); return n; });
      return;
    }
    setExpanded((s) => new Set(s).add(path));
    if (children.has(path)) return;
    const entries = await readChildren(deps.list, path);
    setChildren((m) => new Map(m).set(path, entries));
  };

  const closeTab = (t: string) => {
    const next = closeReviewTab(tabs, selected?.path ?? null, t);
    setTabs(next.tabs);
    if (next.active === null) {
      setSelected(null);
      setFileError(null);
    } else if (next.active !== selected?.path) {
      void openFile(next.active);
    }
  };

  const openFile = async (path: string) => {
    const token = fileGate.begin();
    setTabs((t) => (t.includes(path) ? t : [...t, path]));
    setSelected({ path, text: "", bytes: 0 });
    setFileError(null);
    try {
      const body = await deps.read(path);
      if (!fileGate.isCurrent(token)) return;
      const file = decodeFile(body);
      if (!file) {
        setFileError("This file is binary or too large to preview here. Open it in Explorer.");
        return;
      }
      setSelected({ path, text: file.text, bytes: file.bytes });
    } catch {
      if (fileGate.isCurrent(token)) setFileError("The file could not be read.");
    }
  };

  const rows = (path: string): ReviewEntry[] => children.get(path) ?? [];
  const selectedName = selected?.path.split("/").pop() ?? "";

  return (
    <div className="rv-root" data-active={active}>
      <header className="rv-head">
        <h2 className="rv-title">Docs vs code</h2>
        <span className="rv-path" title={selected?.path}>{selected?.path ?? "No file selected"}</span>
        <span className="rv-spacer" />
        <button type="button" className="rv-btn" onClick={() => void loadRoots()} disabled={busy}>Refresh</button>
        <button type="button" className="rv-btn" disabled={!selected} onClick={() => selected && shellBus.publish({ type: "open-file", path: selected.path })}>Open in Explorer</button>
        <ChatDockToggle open={showChat} controls="rv-chat-dock" onToggle={() => setShowChat((v) => !v)} />
      </header>

      {linked ? (
        <p className="rv-linked">Linked: <strong>{linked.label}</strong>{linked.path ? <span className="rv-hint"> · {linked.path}</span> : null}</p>
      ) : (
        <p className="rv-linked rv-hint">No repository is linked. Add one in Settings → Repositories to include its clone in review.</p>
      )}
      {tabs.length > 0 ? (
        <div className="rv-tabs" role="tablist" aria-label="Open review files">
          {tabs.map((t) => (
            <span key={t} className="rv-tab" data-on={selected?.path === t || undefined}>
              <button type="button" role="tab" aria-selected={selected?.path === t} onClick={() => void openFile(t)}>{t.split("/").pop()}</button>
              <button type="button" className="rv-tab-x" aria-label={`Close ${t.split("/").pop()}`} onClick={() => closeTab(t)}>×</button>
            </span>
          ))}
        </div>
      ) : null}
      <div className="rv-body">
        <aside className="rv-tree" aria-label="Review files">
          {roots.map(({ root, entries, error, more }) => (
            <section key={root.path} className="rv-group">
              <h3 className="rv-group-title">{root.label}</h3>
              {error ? (
                <p className="rv-hint">{root.path}/ is missing.</p>
              ) : entries.length === 0 ? (
                <p className="rv-hint">No files in {root.path}/.</p>
              ) : (
                <>
                {more ? (
                  <p className="rv-hint" role="note">
                    Showing the first {more.shown.toLocaleString("en")}{more.total === null ? "" : ` of ${more.total.toLocaleString("en")}`}; the rest of {root.path}/ is not listed.
                  </p>
                ) : null}
                <ul className="rv-list">
                  {entries.map((e) => (
                    <TreeRow key={e.path} entry={e} depth={0} expanded={expanded} childrenOf={rows} onToggle={openDir} onOpen={openFile} selected={selected?.path ?? null} />
                  ))}
                </ul>
                </>
              )}
            </section>
          ))}
        </aside>

        <main className="rv-main">
          {fileError ? <StatusBanner severity="warning" message={fileError} /> : null}
          {!selected ? (
            <div className="rv-empty">
              <h3>{REVIEW_EMPTY.title}</h3>
              <p className="rv-hint">{REVIEW_EMPTY.hint}</p>
            </div>
          ) : (
            <>
              <div className="rv-filehead">
                <strong>{selectedName}</strong>
                <span className="rv-hint">{selected.bytes.toLocaleString("en")} bytes · read-only</span>
              </div>
              {selected.path.startsWith("llm-doc/") && selected.path.endsWith(".md") ? (
                <div className="rv-content rv-markdown"><Markdown text={selected.text} /></div>
              ) : (
                <pre className="rv-content" aria-label={`${selectedName} contents`}>{selected.text}</pre>
              )}
            </>
          )}
        </main>

        {showChat ? (
          <>
            <div
              className="rv-resizer"
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize Code Assistant"
              onPointerDown={(e) => {
                const startX = e.clientX;
                const startW = chatWidth;
                const move = (ev: PointerEvent) => setChatWidth(Math.round(Math.min(640, Math.max(240, startW + (startX - ev.clientX)))));
                const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
                window.addEventListener("pointermove", move);
                window.addEventListener("pointerup", up);
              }}
            />
            <aside className="rv-chat" style={{ width: chatWidth }} aria-label="Code Assistant">
              <div id="rv-chat-dock"><ChatDockSlot surface="review" active={active} projectRoot={projectRoot} initialPath={selected?.path ?? null} onCollapse={() => setShowChat(false)} /></div>
            </aside>
          </>
        ) : null}
      </div>
      <p className="rv-hint rv-foot">Reviewing is conversational: ask the assistant to compare the selected code with the LLM Doc and flag conflicts or undecided items. This page never edits files.</p>
    </div>
  );
}

function TreeRow({ entry, depth, expanded, childrenOf, onToggle, onOpen, selected }: {
  entry: ReviewEntry;
  depth: number;
  expanded: ReadonlySet<string>;
  childrenOf: (path: string) => ReviewEntry[];
  onToggle: (path: string) => void;
  onOpen: (path: string) => void;
  selected: string | null;
}): ReactNode {
  const isDir = entry.kind === "dir";
  const open = expanded.has(entry.path);
  const kind = fileKind(entry.name, isDir);
  return (
    <li className="rv-row" role="none">
      <FileTreeRow
        name={entry.name}
        isFolder={isDir}
        isExpanded={open}
        depth={depth}
        icon={isDir ? <FolderIcon /> : <Icon name={fileKindIcon(kind)} size={11} />}
        kind={kind}
        selected={!isDir && selected === entry.path}
        onClick={() => (isDir ? onToggle(entry.path) : onOpen(entry.path))}
        onToggle={isDir ? () => onToggle(entry.path) : undefined}
      />
      {isDir && open ? (
        <ul className="rv-list" role="group">
          {childrenOf(entry.path).map((c) => (
            <TreeRow key={c.path} entry={c} depth={depth + 1} expanded={expanded} childrenOf={childrenOf} onToggle={onToggle} onOpen={onOpen} selected={selected} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}
