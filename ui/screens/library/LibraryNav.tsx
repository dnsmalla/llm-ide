// Sidebar: sections (Sources, LLM Doc), the Extensions entries (placeholders until S-J lands them), the
// notes folder and the index rebuild. Counts update as the background reader classifies notes.
import { useState, type ReactNode } from "react";
import { ChevronIcon, DocIcon, FolderIcon, PuzzleIcon, RefreshIcon, WaveIcon } from "@llmide/ui-kit";
import type { LibraryState } from "./library-store.ts";
import type { NotesRoot } from "./host.ts";
import type { SectionDef } from "./notes-model.ts";
import { rebuildMessage, type RebuildProgress } from "./index-rebuild.ts";

/** An Extensions-group entry. S-J supplies `render` to turn a placeholder into a real pane. */
export interface LibraryExtension {
  id: string;
  label: string;
  /** Shown while there is no `render`. */
  note?: string;
  render?: () => ReactNode;
}

export const EXTENSION_PLACEHOLDERS: readonly LibraryExtension[] = [
  { id: "plugins", label: "Plugins", note: "Plugins arrive with the Extensions screen." },
  { id: "llm-sources", label: "LLM Sources", note: "LLM sources arrive with the Extensions screen." },
  { id: "mcp-plugins", label: "MCP Plugins", note: "MCP plugins arrive with the Extensions screen." },
  { id: "extensions", label: "Extensions", note: "The extensions catalog arrives with the Extensions screen." },
];

export interface LibraryNavProps {
  state: LibraryState;
  /** Selected Extensions entry id, or null when a notes section is shown. */
  extensionId: string | null;
  extensions: readonly LibraryExtension[];
  /** Source connections (Email, Slack, Box, ...): a group of panes that open in the detail area. */
  connections?: readonly LibraryExtension[];
  /** The project-file trees (Code/Data) rendered between Sources and LLM Doc, when the host can list them. */
  projectNav?: ReactNode;
  onSection: (id: string | null) => void;
  onExtension: (id: string) => void;
  onRefresh: () => void;
  /** Null when the project's Paths layout owns the folders (no separate notes-folder chooser). */
  onChangeFolder: (() => void) | null;
  rebuild: RebuildProgress | null;
  onRebuild: (() => void) | null;
  onCancelRebuild: () => void;
}

function SectionButton({ def, count, selected, onClick }: { def: SectionDef; count: number; selected: boolean; onClick: () => void }): ReactNode {
  return (
    <li>
      <button type="button" className="lib-nav-item" aria-current={selected ? "page" : undefined} data-selected={selected} onClick={onClick}>
        <span className="lib-nav-label">{def.label}</span>
        <span className="lib-count" aria-label={`${count} notes`}>
          {count.toLocaleString()}
        </span>
      </button>
    </li>
  );
}

const COLLAPSE_KEY = "llmide.library.collapsed";
function readCollapsed(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(COLLAPSE_KEY) ?? "[]") as unknown;
    return new Set(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : []);
  } catch { return new Set(); }
}

export function LibraryNav(p: LibraryNavProps): ReactNode {
  const { state } = p;
  const [collapsed, setCollapsed] = useState<Set<string>>(readCollapsed);
  const toggle = (id: string) => setCollapsed((cur) => {
    const next = new Set(cur);
    if (next.has(id)) next.delete(id); else next.add(id);
    try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...next])); } catch { /* session only */ }
    return next;
  });
  const open = (id: string) => !collapsed.has(id);
  const GroupHead = ({ id, icon, label, count }: { id: string; icon: ReactNode; label: string; count: number }) => (
    <h3 className="lib-nav-group">
      <button type="button" className="lib-nav-group-btn" aria-expanded={open(id)} onClick={() => toggle(id)}>
        {icon} {label} <span className="lib-count">{count.toLocaleString()}</span> <span aria-hidden="true">{open(id) ? "▾" : "▸"}</span>
      </button>
    </h3>
  );
  const root: NotesRoot | null = state.root;
  const sources = state.sections.filter((s) => s.group === "sources");
  const docs = state.sections.filter((s) => s.group === "docs");
  const busy = p.rebuild !== null && ["reading", "scanning", "uploading"].includes(p.rebuild.phase);
  return (
    <nav className="lib-nav" aria-label="Library sections">
      <div className="lib-nav-head">
        <h2 className="lib-nav-title">Library</h2>
        <button type="button" className="ui-icon-button" aria-label="Refresh notes" title="Refresh notes" onClick={p.onRefresh} disabled={state.listing.phase === "listing"}>
          <RefreshIcon />
        </button>
      </div>
      <GroupHead id="sources" icon={<WaveIcon />} label="Sources" count={sources.reduce((n, s) => n + (state.counts.get(s.id) ?? 0), 0)} />
      {open("sources") ? (
        <ul className="lib-nav-list">
          {sources.map((s) => (
            <SectionButton key={s.id} def={s} count={state.counts.get(s.id) ?? 0} selected={p.extensionId === null && state.sectionId === s.id} onClick={() => p.onSection(s.id)} />
          ))}
        </ul>
      ) : null}
      {p.projectNav}
      {docs.length > 0 && (
        <>
          <GroupHead id="docs" icon={<DocIcon />} label="LLM Doc" count={docs.reduce((n, s) => n + (state.counts.get(s.id) ?? 0), 0)} />
          {open("docs") ? (
            <ul className="lib-nav-list">
              {docs.map((s) => (
                <SectionButton key={s.id} def={s} count={state.counts.get(s.id) ?? 0} selected={p.extensionId === null && state.sectionId === s.id} onClick={() => p.onSection(s.id)} />
              ))}
            </ul>
          ) : null}
        </>
      )}
      <GroupHead id="extensions" icon={<PuzzleIcon />} label="Extensions" count={p.extensions.length} />
      {open("extensions") ? <ul className="lib-nav-list">
        {p.extensions.map((x) => {
          const sel = p.extensionId === x.id;
          return (
            <li key={x.id}>
              <button type="button" className="lib-nav-item" aria-current={sel ? "page" : undefined} data-selected={sel} onClick={() => p.onExtension(x.id)}>
                <span className="lib-nav-label">{x.label}</span>
                {!x.render && <ChevronIcon />}
              </button>
            </li>
          );
        })}
      </ul> : null}
      {p.connections && p.connections.length > 0 && (
        <>
          <GroupHead id="connectors" icon={<WaveIcon />} label="Connectors" count={p.connections.length} />
          {open("connectors") ? <ul className="lib-nav-list">
            {p.connections.map((x) => {
              const sel = p.extensionId === x.id;
              return (
                <li key={x.id}>
                  <button type="button" className="lib-nav-item" aria-current={sel ? "page" : undefined} data-selected={sel} onClick={() => p.onExtension(x.id)}>
                    <span className="lib-nav-label">{x.label}</span>
                  </button>
                </li>
              );
            })}
          </ul> : null}
        </>
      )}
      <div className="lib-nav-foot">
        {root && (
          <p className="lib-folder" title={root.root}>
            <FolderIcon /> <span className="lib-folder-name">{root.name}</span>
          </p>
        )}
        {p.onChangeFolder ? (
          <button type="button" className="lib-btn" onClick={p.onChangeFolder}>
            Change notes folder
          </button>
        ) : null}
        {p.onRebuild && (
          <>
            <button type="button" className="lib-btn" onClick={p.onRebuild} disabled={busy || state.listing.phase !== "done" || state.records.length === 0} title="Rebuilds the search index from the notes. Nothing is removed from it.">
              Rebuild search index
            </button>
            {p.rebuild && p.rebuild.phase !== "idle" && (
              <div className="lib-progress" role="status" aria-live="polite">
                <p className="lib-muted">{rebuildMessage(p.rebuild)}</p>
                {busy && (
                  <button type="button" className="lib-link-btn" onClick={p.onCancelRebuild}>
                    Cancel
                  </button>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </nav>
  );
}
