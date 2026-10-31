// Review Conflicts: the Mac's tree + viewer + Code Assistant layout over the project's code and llm-doc folders.
// It is deliberately read-only — reviewing is a conversation with the assistant; editing belongs in Explorer.
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { StatusBanner } from "@llmide/ui-kit";
import type { SectionProps } from "../shell/sections";
import { ChatDockSlot } from "../shell/chat-dock";
import { shellBus } from "../shell/bus";
import { REVIEW_EMPTY, REVIEW_ROOTS, decodeEntries, decodeFile, type ReviewEntry } from "./review-model.ts";
import "./review.css";

export interface ReviewDeps {
  list: (path: string) => Promise<unknown>;
  read: (path: string) => Promise<unknown>;
}

export function ReviewScreen({ active, projectRoot, deps }: SectionProps & { deps: ReviewDeps }): ReactNode {
  const [roots, setRoots] = useState<{ root: (typeof REVIEW_ROOTS)[number]; entries: ReviewEntry[]; error: boolean }[]>([]);
  const [children, setChildren] = useState<Map<string, ReviewEntry[]>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<{ path: string; text: string; bytes: number } | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showChat, setShowChat] = useState(true);

  const loadRoots = useCallback(async () => {
    setBusy(true);
    const next: typeof roots = [];
    for (const root of REVIEW_ROOTS) {
      try {
        next.push({ root, entries: decodeEntries(await deps.list(root.path)), error: false });
      } catch {
        next.push({ root, entries: [], error: true });
      }
    }
    setRoots(next);
    setChildren(new Map());
    setBusy(false);
  }, [deps]);

  useEffect(() => {
    if (active) void loadRoots();
  }, [active, loadRoots]);

  const openDir = async (path: string) => {
    if (expanded.has(path)) {
      setExpanded((s) => { const n = new Set(s); n.delete(path); return n; });
      return;
    }
    setExpanded((s) => new Set(s).add(path));
    if (children.has(path)) return;
    try {
      const entries = decodeEntries(await deps.list(path));
      setChildren((m) => new Map(m).set(path, entries));
    } catch {
      setChildren((m) => new Map(m).set(path, []));
    }
  };

  const openFile = async (path: string) => {
    setSelected({ path, text: "", bytes: 0 });
    setFileError(null);
    try {
      const body = await deps.read(path);
      const file = decodeFile(body);
      if (!file) {
        setFileError("This file is binary or too large to preview here. Open it in Explorer.");
        return;
      }
      setSelected({ path, text: file.text, bytes: file.bytes });
    } catch {
      setFileError("The file could not be read.");
    }
  };

  const rows = (path: string): ReviewEntry[] => children.get(path) ?? [];
  const selectedName = selected?.path.split("/").pop() ?? "";

  return (
    <div className="rv-root" data-active={active}>
      <header className="rv-head">
        <h2 className="rv-title">Review Conflicts</h2>
        <span className="rv-path" title={selected?.path}>{selected?.path ?? "No file selected"}</span>
        <span className="rv-spacer" />
        <button type="button" className="rv-btn" onClick={() => void loadRoots()} disabled={busy}>Refresh</button>
        <button type="button" className="rv-btn" disabled={!selected} onClick={() => selected && shellBus.publish({ type: "open-file", path: selected.path })}>Open in Explorer</button>
        <button type="button" className="rv-btn" aria-pressed={showChat} onClick={() => setShowChat((v) => !v)}>Code Assistant</button>
      </header>

      <div className="rv-body">
        <aside className="rv-tree" aria-label="Review files">
          {roots.map(({ root, entries, error }) => (
            <section key={root.path} className="rv-group">
              <h3 className="rv-group-title">{root.label}</h3>
              {error ? (
                <p className="rv-hint">{root.path}/ is missing.</p>
              ) : entries.length === 0 ? (
                <p className="rv-hint">No files in {root.path}/.</p>
              ) : (
                <ul className="rv-list">
                  {entries.map((e) => (
                    <TreeRow key={e.path} entry={e} depth={0} expanded={expanded} childrenOf={rows} onToggle={openDir} onOpen={openFile} selected={selected?.path ?? null} />
                  ))}
                </ul>
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
              <pre className="rv-content" aria-label={`${selectedName} contents`}>{selected.text}</pre>
            </>
          )}
        </main>

        {showChat ? (
          <aside className="rv-chat" aria-label="Code Assistant">
            <ChatDockSlot active={active} projectRoot={projectRoot} onCollapse={() => setShowChat(false)} />
          </aside>
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
  return (
    <li className="rv-row" style={{ paddingLeft: depth * 12 }} role="treeitem" aria-expanded={isDir ? open : undefined} aria-selected={!isDir && selected === entry.path}>
      <button type="button" className={isDir ? "rv-dir" : "rv-file"} data-on={!isDir && selected === entry.path || undefined} onClick={() => (isDir ? onToggle(entry.path) : onOpen(entry.path))}>
        <span className="rv-caret" aria-hidden="true">{isDir ? (open ? "▾" : "▸") : "·"}</span>
        {entry.name}
      </button>
      {isDir && open ? (
        <ul className="rv-list">
          {childrenOf(entry.path).map((c) => (
            <TreeRow key={c.path} entry={c} depth={depth + 1} expanded={expanded} childrenOf={childrenOf} onToggle={onToggle} onOpen={onOpen} selected={selected} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}
