// Sidebar: sections (Sources, LLM Doc), the Extensions entries (placeholders until S-J lands them), the
// notes folder and the index rebuild. Counts update as the background reader classifies notes.
import type { ReactNode } from "react";
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
  onSection: (id: string | null) => void;
  onExtension: (id: string) => void;
  onRefresh: () => void;
  onChangeFolder: () => void;
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

export function LibraryNav(p: LibraryNavProps): ReactNode {
  const { state } = p;
  const root: NotesRoot | null = state.root;
  const sources = state.sections.filter((s) => s.group === "sources");
  const docs = state.sections.filter((s) => s.group === "docs");
  const busy = p.rebuild !== null && ["reading", "scanning", "uploading"].includes(p.rebuild.phase);
  const allSelected = state.sectionId === null && p.extensionId === null;
  return (
    <nav className="lib-nav" aria-label="Library sections">
      <div className="lib-nav-head">
        <h2 className="lib-nav-title">Library</h2>
        <button type="button" className="ui-icon-button" aria-label="Refresh notes" title="Refresh notes" onClick={p.onRefresh} disabled={state.listing.phase === "listing"}>
          <RefreshIcon />
        </button>
      </div>
      <ul className="lib-nav-list">
        <li>
          <button type="button" className="lib-nav-item" aria-current={allSelected ? "page" : undefined} data-selected={allSelected} onClick={() => p.onSection(null)}>
            <span className="lib-nav-label">All notes</span>
            <span className="lib-count">{state.records.length.toLocaleString()}</span>
          </button>
        </li>
      </ul>
      <h3 className="lib-nav-group">
        <WaveIcon /> Sources
      </h3>
      <ul className="lib-nav-list">
        {sources.map((s) => (
          <SectionButton key={s.id} def={s} count={state.counts.get(s.id) ?? 0} selected={p.extensionId === null && state.sectionId === s.id} onClick={() => p.onSection(s.id)} />
        ))}
      </ul>
      {docs.length > 0 && (
        <>
          <h3 className="lib-nav-group">
            <DocIcon /> LLM Doc
          </h3>
          <ul className="lib-nav-list">
            {docs.map((s) => (
              <SectionButton key={s.id} def={s} count={state.counts.get(s.id) ?? 0} selected={p.extensionId === null && state.sectionId === s.id} onClick={() => p.onSection(s.id)} />
            ))}
          </ul>
        </>
      )}
      {p.connections && p.connections.length > 0 && (
        <>
          <h3 className="lib-nav-group">
            <WaveIcon /> Connections
          </h3>
          <ul className="lib-nav-list">
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
          </ul>
        </>
      )}
      <h3 className="lib-nav-group">
        <PuzzleIcon /> Extensions
      </h3>
      <ul className="lib-nav-list">
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
      </ul>
      <div className="lib-nav-foot">
        {root && (
          <p className="lib-folder" title={root.root}>
            <FolderIcon /> <span className="lib-folder-name">{root.name}</span>
          </p>
        )}
        <button type="button" className="lib-btn" onClick={p.onChangeFolder}>
          Change notes folder
        </button>
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
