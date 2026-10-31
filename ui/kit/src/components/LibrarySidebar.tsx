import { useState, type ReactNode } from "react";
import {
  ChartIcon,
  CodeIcon,
  DocIcon,
  DocLargeIcon,
  MicWaveIcon,
  PlusIcon,
  PuzzleIcon,
  RefreshIcon,
  SearchIcon,
  TableIcon,
  WaveIcon,
  ChevronIcon,
} from "../icons";

// Placeholder data: the Library's real sources are not wired in the PoC.
interface Section {
  id: string;
  title: string;
  /** CSS colour (token) used for the chip, title and count. */
  tint: string;
  icon: ReactNode;
  count: number;
}

const SECTIONS: Section[] = [
  { id: "sources", title: "Sources", tint: "var(--tok-color-info)", icon: <WaveIcon />, count: 0 },
  { id: "code", title: "Code", tint: "var(--tok-color-success)", icon: <CodeIcon />, count: 877 },
  { id: "data", title: "Data", tint: "var(--tok-color-category-purple)", icon: <TableIcon />, count: 0 },
  { id: "llm-doc", title: "LLM Doc", tint: "var(--tok-color-info)", icon: <DocIcon />, count: 3 },
  { id: "plugins", title: "Plugins", tint: "var(--tok-color-category-teal)", icon: <PuzzleIcon />, count: 2 },
  { id: "llm-sources", title: "LLM Sources", tint: "var(--tok-color-category-amber)", icon: <ChartIcon />, count: 2 },
];

function SectionHeader({ section, open, onToggle }: { section: Section; open: boolean; onToggle: () => void }) {
  return (
    <div className="ui-lib-header">
      <button
        type="button"
        className="ui-lib-header-toggle"
        aria-expanded={open}
        title={open ? `Collapse ${section.title}` : `Expand ${section.title}`}
        onClick={onToggle}
      >
        <span className="ui-lib-chevron" data-open={open}>
          <ChevronIcon />
        </span>
        <span className="ui-lib-chip" style={{ color: section.tint, background: `color-mix(in srgb, ${section.tint} 12%, transparent)` }}>
          {section.icon}
        </span>
        <span className="ui-lib-title" style={{ color: section.tint }}>
          {section.title}
        </span>
        {section.count > 0 && (
          <span className="ui-lib-count" style={{ color: `color-mix(in srgb, ${section.tint} 60%, transparent)` }}>
            {section.count}
          </span>
        )}
      </button>
      <button type="button" className="ui-lib-plus" aria-label={`Add to ${section.title}`} title={`Add to ${section.title}`} style={{ color: `color-mix(in srgb, ${section.tint} 60%, transparent)` }}>
        <PlusIcon />
      </button>
    </div>
  );
}

/** Library sidebar (Mac LibraryView): search, empty meetings block, collapsible category sections. */
export function LibrarySidebar() {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  return (
    <aside className="ui-library" aria-label="Library">
      <div className="ui-lib-search">
        <SearchIcon />
        <input className="ui-lib-search-input" placeholder="Search meetings…" aria-label="Search meetings" />
        <button type="button" className="ui-icon-button" aria-label="Refresh library" title="Reload files, plugins, LLM sources, MCP plugins, and connectors">
          <RefreshIcon />
        </button>
      </div>
      <div className="ui-lib-empty">
        <MicWaveIcon />
        <div className="ui-lib-empty-title">No Meetings Yet</div>
        <div className="ui-lib-empty-hint">
          Press ⌘N or click <strong>Record</strong> to capture your first meeting.
        </div>
      </div>
      <div className="ui-lib-sections">
        {SECTIONS.map((s) => (
          <div key={s.id} className="ui-lib-section">
            <SectionHeader
              section={s}
              open={!!open[s.id]}
              onToggle={() => setOpen((prev) => ({ ...prev, [s.id]: !prev[s.id] }))}
            />
            {open[s.id] && <div className="ui-lib-section-body">No items yet.</div>}
          </div>
        ))}
      </div>
    </aside>
  );
}

/** Centred empty state for the content area when nothing is selected (Mac LibraryDetailView). */
export function SelectItemEmpty() {
  return (
    <div className="ui-select-empty">
      <span className="ui-select-empty-icon">
        <DocLargeIcon />
      </span>
      <div className="ui-select-empty-title">Select an Item</div>
      <div className="ui-select-empty-hint">Choose a meeting, file, plugin, or LLM source from the list.</div>
    </div>
  );
}
