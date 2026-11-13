// Sidebar: sections (Sources, LLM Doc), the Extensions entries (placeholders until S-J lands them), the
// notes folder and the index rebuild. Counts update as the background reader classifies notes.
import { Fragment, useState, type ReactNode } from "react";
import { DocIcon, FolderIcon, PuzzleIcon, RefreshIcon, WaveIcon } from "@llmide/ui-kit";
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
  /** How many of this group's items are switched on; null/absent = unknown (no badge). */
  count?: number | null;
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
  /** Reveals the meetings folder in the OS file manager (Mac "Reveal Folder in Finder"); absent when the host cannot. */
  onRevealMeetings?: () => void;
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

const COLLAPSE_KEY = "llmide.library.collapsed.v2";
// The Mac opened every group collapsed, which left the 280px sidebar almost empty. The desktop opens the
// two note sources by default; Extensions and Connections stay folded until used.
const DEFAULT_COLLAPSED = ["extensions", "connectors"];
const LEGACY_DEFAULT = JSON.stringify(["sources", "docs", "extensions", "connectors"]);
function readCollapsed(): Set<string> {
  try {
    // In the app every section starts collapsed (Mac); server-render tests keep the full tree visible.
    if (typeof window === "undefined") return new Set();
    const raw = localStorage.getItem(COLLAPSE_KEY);
    if (raw === null) return new Set(DEFAULT_COLLAPSED);
    const parsed = JSON.parse(raw) as unknown;
    if (JSON.stringify(parsed) === LEGACY_DEFAULT) return new Set(DEFAULT_COLLAPSED);
    return new Set(Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : DEFAULT_COLLAPSED);
  } catch { return new Set(DEFAULT_COLLAPSED); }
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
  const GroupHead = ({ id, icon, label, count, onAdd, addLabel }: { id: string; icon: ReactNode; label: string; count?: number | null; onAdd?: () => void; addLabel?: string }) => (
    <h3 className="lib-nav-group" data-accent={id}>
      <button type="button" className="lib-nav-group-btn" aria-expanded={open(id)} onClick={() => toggle(id)}>
        <span className="lib-nav-chevron" aria-hidden="true">{open(id) ? "▾" : "▸"}</span>{icon} <span className="lib-nav-label">{label}</span>{count !== null && count !== undefined ? <span className="lib-count">{count.toLocaleString()}</span> : null}
      </button>
      {onAdd ? <button type="button" className="lib-plus" aria-label={addLabel ?? `Add ${label}`} title={addLabel ?? `Add ${label}`} onClick={onAdd}>＋</button> : null}
      {open(id) ? <button type="button" className="lib-nav-close" aria-label={`Close ${label}`} title={`Close ${label}`} onClick={() => toggle(id)}>×</button> : null}
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
      <GroupHead id="sources" icon={<WaveIcon />} label="Sources" count={sources.reduce((n, s) => n + (state.counts.get(s.id) ?? 0), 0)} onAdd={() => p.onExtension("connectors")} addLabel="Open connectors to add a source" />
      {open("sources") ? (
        <ul className="lib-nav-list">
          {sources.map((s) => (
            <SectionButton key={s.id} def={s} count={state.counts.get(s.id) ?? 0} selected={p.extensionId === null && state.sectionId === s.id} onClick={() => p.onSection(s.id)} />
          ))}
        </ul>
      ) : null}
      {p.projectNav}
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
      {p.extensions.map((x) => (
        <Fragment key={x.id}>
          <h3 className="lib-nav-group" data-accent={x.id}>
            <button
              type="button"
              className="lib-nav-group-btn"
              aria-expanded={open(x.id)}
              onClick={() => {
                if (open(x.id)) toggle(x.id);
                else { toggle(x.id); p.onExtension(x.id); }
              }}
            >
              <span className="lib-nav-chevron" aria-hidden="true">{open(x.id) ? "▾" : "▸"}</span><PuzzleIcon /> <span className="lib-nav-label">{x.label}</span>
              {x.count !== null && x.count !== undefined ? <span className="lib-count" aria-label={`${x.count} switched on`} title={`${x.count} switched on`}>{x.count.toLocaleString()}</span> : null}
            </button>
            <button type="button" className="lib-plus" aria-label={`Open ${x.label}`} title={`Open ${x.label}`} onClick={() => p.onExtension(x.id)}>＋</button>
            {open(x.id) ? <button type="button" className="lib-nav-close" aria-label={`Close ${x.label}`} title={`Close ${x.label}`} onClick={() => toggle(x.id)}>×</button> : null}
          </h3>
        </Fragment>
      ))}
      {p.connections && p.connections.length > 0 && (
        <>
          <GroupHead id="connectors" icon={<WaveIcon />} label="Connectors" count={p.connections.length} onAdd={() => p.onExtension(p.connections![0]?.id ?? "connectors")} addLabel="Open connectors" />
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
        {p.onRevealMeetings ? (
          <button type="button" className="lib-btn" onClick={p.onRevealMeetings}>
            Reveal meetings folder
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
