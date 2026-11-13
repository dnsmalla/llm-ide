// Browse tab: the cached catalog, searchable, virtualised and paged. Searching and paging read the core's
// cache only; Refresh is the one button that contacts GitHub and the MCP registry, and says so.
import { useEffect, useRef, type ReactNode } from "react";
import { RefreshIcon, SearchIcon } from "@llmide/ui-kit";
import type { CatalogEntry } from "./decoders.ts";
import { BROWSE_ROW_HEIGHT, browseWindow } from "./list-model.ts";
import { entryKey, type ExtensionsModel, type ExtensionsState } from "./model.ts";
import { catalogNeverFetched, entryAction, kindLabel, repoName, sourceStatusText } from "./presentation.ts";
import { publicHttpsUrl } from "../safe-url.ts";
import { Badge } from "./ui.tsx";
import { useScroller } from "../use-library.ts";

const KINDS: { id: string | null; label: string }[] = [
  { id: null, label: "All kinds" },
  { id: "skill", label: "Skills" },
  { id: "plugin", label: "Plugins" },
  { id: "mcp", label: "MCP servers" },
  { id: "llm-source", label: "Skill bundles" },
];

function EntryRow({ model, entry, index, total, busy, checked, openRepository }: { model: ExtensionsModel; entry: CatalogEntry; index: number; total: number; busy: boolean; checked: boolean; openRepository?: (url: string) => void }): ReactNode {
  const act = entryAction(entry);
  const repo = !act.installable && openRepository && entry.sourceUrl ? publicHttpsUrl(entry.sourceUrl) : null;
  return (
    <div role="listitem" className="ext-entry" style={{ top: index * BROWSE_ROW_HEIGHT, height: BROWSE_ROW_HEIGHT }} aria-posinset={index + 1} aria-setsize={total}>
      {act.installable && !entry.installed ? (
        <input type="checkbox" className="ext-row-check" checked={checked} aria-label={`Select ${entry.name} to install`} onChange={() => model.toggleBrowseChecked(entry)} />
      ) : <span className="ext-row-check" aria-hidden="true" />}
      <div className="ext-entry-main">
        <span className="ext-row-name">{entry.name}</span>
        <span className="ext-row-meta">
          {kindLabel(entry.kind)} · {entry.publisher}
          {entry.version ? ` · ${entry.version}` : ""}
          {entry.sourceUrl ? ` · ${repoName(entry.sourceUrl)}${entry.sourcePath ? `/${entry.sourcePath}` : ""}` : ""}
        </span>
        <span className="ext-entry-desc">{entry.description}</span>
        {!act.installable && act.reason && <span className="ext-entry-reason lib-muted">{act.reason}</span>}
      </div>
      <div className="ext-entry-act">
        {entry.installed ? (
          <Badge tone="ok">Installed</Badge>
        ) : act.installable ? (
          <button type="button" className="lib-btn" disabled={busy} aria-label={`Install ${entry.name}`} onClick={() => model.requestBrowseInstall(entry)}>
            Install
          </button>
        ) : (
          <Badge tone="neutral" title={act.reason ?? undefined}>
            Browse only
          </Badge>
        )}
        {repo && openRepository && (
          <button type="button" className="lib-btn" aria-label={`Open repository of ${entry.name}`} onClick={() => openRepository(repo)}>
            Open repository
          </button>
        )}
      </div>
    </div>
  );
}

export function BrowseTab({ model, state, initialHeight, openRepository }: { model: ExtensionsModel; state: ExtensionsState; initialHeight?: number; openRepository?: (url: string) => void }): ReactNode {
  const b = state.browse;
  const ref = useRef<HTMLDivElement>(null);
  const { scrollTop, height } = useScroller(ref, initialHeight ?? 520);
  const w = browseWindow(b.results.length, scrollTop, height);

  // Debounced cached search on typing or a filter change (never on mount: the tab's first open already read it).
  const last = useRef<string>(`${b.query}|${b.kind}`);
  useEffect(() => {
    const key = `${b.query}|${b.kind}`;
    if (key === last.current) return;
    last.current = key;
    const t = setTimeout(() => void model.search(), 250);
    return () => clearTimeout(t);
  }, [b.query, b.kind, model]);

  // Next page when the window nears the end of what is loaded.
  useEffect(() => {
    if (b.loaded && w.end >= b.results.length - 8 && b.results.length < b.total) void model.loadMore();
  }, [w.end, b.results.length, b.total, b.loaded, model]);

  const never = catalogNeverFetched(b.sources);
  return (
    <div className="ext-browse">
      <div className="ext-browse-bar">
        <div className="lib-search" role="search">
          <SearchIcon />
          <input type="search" className="lib-search-input" placeholder="Search skills, plugins and MCP servers" aria-label="Search the catalog" maxLength={200} value={b.query} onChange={(e) => model.setQuery(e.target.value)} />
        </div>
        <label className="lib-select">
          <span className="ext-sr">Kind</span>
          <select value={b.kind ?? ""} onChange={(e) => model.setKind(e.target.value === "" ? null : e.target.value)} aria-label="Kind">
            {KINDS.map((k) => (
              <option key={k.id ?? "all"} value={k.id ?? ""}>
                {k.label}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="lib-btn" disabled={b.refreshing || state.catalogOff} onClick={() => void model.refreshCatalog()} title="Contacts GitHub and the MCP registry">
          <RefreshIcon /> {b.refreshing ? "Refreshing…" : "Refresh catalog"}
        </button>
      </div>
      <p className="lib-muted ext-browse-note">Searching reads the saved catalog on this computer. Only Refresh contacts GitHub and the MCP registry.</p>
      {b.sources.length > 0 && (
        <details className="ext-sources">
          <summary>Catalog sources ({b.sources.length})</summary>
          <ul aria-label="Catalog sources">
            {b.sources.map((s) => (
              <li key={s.id}>
                <strong>{s.title}</strong> <span className="lib-muted">{sourceStatusText(s)}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      {b.error && (
        <p className="ext-inline-error" role="alert">
          {b.error}
        </p>
      )}
      {!b.loaded && !b.error ? (
        <p className="lib-empty" role="status">
          Reading the saved catalog…
        </p>
      ) : b.results.length === 0 && b.loaded ? (
        <div className="lib-empty" role="status">
          <p className="lib-empty-title">{never ? "The catalog has not been fetched yet" : "No matches"}</p>
          <p className="lib-muted">{never ? "Press Refresh catalog to fetch the indexes from GitHub and the MCP registry." : "Try fewer words, or another kind."}</p>
        </div>
      ) : (
        <>
          <div className="ext-selbar-row">
            <p className="lib-muted" role="status" aria-live="polite">
              {b.total.toLocaleString()} {b.total === 1 ? "match" : "matches"}
              {b.results.length < b.total ? `, ${b.results.length.toLocaleString()} loaded` : ""}
            </p>
            {state.browseChecked.length > 0 ? (
              <span className="ext-selbar-actions" role="group" aria-label={`${state.browseChecked.length} selected`}>
                <span className="ext-selcount">{state.browseChecked.length} selected</span>
                <button type="button" className="lib-btn lib-btn-primary" disabled={state.install.installing} onClick={() => model.requestInstallSelected()}>
                  {state.install.installing ? "Installing…" : "Install selected"}
                </button>
                <button type="button" className="lib-btn" onClick={() => model.clearBrowseChecked()}>Clear</button>
              </span>
            ) : <span className="lib-muted">Tick several to install them together.</span>}
          </div>
          <div ref={ref} className="lib-scroll ext-list" role="list" aria-label="Catalog results" tabIndex={0}>
            <div style={{ height: b.results.length * BROWSE_ROW_HEIGHT, position: "relative" }}>
              {b.results.slice(w.start, w.end).map((e, i) => (
                <EntryRow key={`${e.indexId}|${e.sourcePath ?? ""}|${e.name}`} model={model} entry={e} index={w.start + i} total={b.total} busy={state.install.installing} checked={state.browseChecked.includes(entryKey(e))} openRepository={openRepository} />
              ))}
            </div>
            {b.loadingMore && (
              <p className="lib-muted" role="status">
                Loading more…
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
