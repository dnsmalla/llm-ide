// The Extensions screen (Library > Extensions): Installed / Browse / Add tabs, a result notice and the one modal.
// Installed has four views (Catalog, Plugins, MCP servers, Skill kits); Add opens the dialog for every way to add one.
// Everything arrives as props (an ExtensionsApi), so it renders and tests without Tauri.
import { useEffect, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from "react";
import { StatusBanner } from "@llmide/ui-kit";
import type { ExtensionsApi } from "./api.ts";
import { BrowseTab } from "./BrowseTab.tsx";
import { AddTab } from "./AddTab.tsx";
import { targetFor, type ExtView } from "./anchors.ts";
import { LegacyView } from "./LegacyPane.tsx";
import { LegacyModel, type LegacyApi, type LegacyKind } from "./legacy.ts";
import type { LocationReveal } from "./legacy-labels.ts";
import { countProblems, problemStore } from "./problems.ts";
import { InstalledTab } from "./InstalledTab.tsx";
import { ExtensionsModel, type ExtensionsState, type Tab } from "./model.ts";
import { activeScopeNote, hasUpdate } from "./presentation.ts";
import { ConfirmSheet, ConsentSheet, PreviewSheet } from "./Sheets.tsx";

const TABS: { id: Tab; label: string }[] = [
  { id: "installed", label: "Installed" },
  { id: "browse", label: "Browse" },
  { id: "install", label: "Add" },
];

const VIEWS: { id: ExtView; label: string }[] = [
  { id: "catalog", label: "Catalog" },
  { id: "plugins", label: "Plugins" },
  { id: "mcp-plugins", label: "MCP servers" },
  { id: "llm-sources", label: "Skill kits" },
];

export type LegacyModels = Partial<Record<LegacyKind, LegacyModel>>;
/** A deep-link request: `id` is the anchor, `n` tells a repeat of the same link apart. */
export interface OpenRequest { id: string; n: number }

export function useExtensionsState(model: ExtensionsModel): ExtensionsState {
  return useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
}

function Sheets({ model, state, initialHeight }: { model: ExtensionsModel; state: ExtensionsState; initialHeight?: number }): ReactNode {
  const sh = state.sheet;
  if (!sh) return null;
  if (sh.kind === "consent") return <ConsentSheet model={model} request={sh.request} ticked={sh.ticked} canConfirm={model.canConfirmConsent} />;
  if (sh.kind === "preview") return <PreviewSheet model={model} itemName={sh.item.name} preview={sh.preview} initialHeight={initialHeight} />;
  return <ConfirmSheet model={model} action={sh.action} />;
}

export function ExtensionsView({ model, initialHeight, openRepository, legacy, revealer, request }: { model: ExtensionsModel; initialHeight?: number; openRepository?: (url: string) => void; legacy?: LegacyModels; revealer?: LocationReveal; request?: OpenRequest | null }): ReactNode {
  const state = useExtensionsState(model);
  const [view, setView] = useState<ExtView>(() => targetFor(request?.id)?.view ?? "catalog");
  // A deep link (a chat command, the MCP notice) picks the tab and view it names; each new request applies once.
  useEffect(() => {
    const t = targetFor(request?.id);
    if (!t) return;
    setView(t.view);
    void model.showTab(t.tab);
    if (t.view !== "catalog") void legacy?.[t.view]?.ensureLoaded();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a request is identified by its counter.
  }, [request?.n]);
  // A list is read the first time its view is shown (never all three at once: each read also asks the Claude and
  // Codex tools and the package registry about updates).
  useEffect(() => {
    if (view !== "catalog") void legacy?.[view]?.ensureLoaded();
  }, [view, legacy]);
  const views = VIEWS.filter((v) => v.id === "catalog" || legacy?.[v.id]);
  const legacyModel = view === "catalog" ? undefined : legacy?.[view];
  const onViewKey = (e: KeyboardEvent): void => {
    const i = views.findIndex((v) => v.id === view);
    const next = e.key === "ArrowRight" ? (i + 1) % views.length : e.key === "ArrowLeft" ? (i + views.length - 1) % views.length : -1;
    if (next < 0) return;
    e.preventDefault();
    setView(views[next]!.id);
    document.getElementById(`ext-view-${views[next]!.id}`)?.focus();
  };
  const updates = state.items.filter(hasUpdate).length;
  const onTabKey = (e: KeyboardEvent): void => {
    const i = TABS.findIndex((t) => t.id === state.tab);
    const next = e.key === "ArrowRight" ? (i + 1) % TABS.length : e.key === "ArrowLeft" ? (i + TABS.length - 1) % TABS.length : -1;
    if (next < 0) return;
    e.preventDefault();
    void model.showTab(TABS[next]!.id);
    document.getElementById(`ext-tab-${TABS[next]!.id}`)?.focus();
  };
  return (
    <div className="ext-root" aria-busy={state.loading}>
      <header className="ext-head">
        <h2 className="ext-title">Extensions</h2>
        <div role="tablist" aria-label="Extensions" className="ext-tabs" onKeyDown={onTabKey}>
          {TABS.map((t) => (
            <button key={t.id} id={`ext-tab-${t.id}`} type="button" role="tab" aria-selected={state.tab === t.id} aria-controls="ext-panel" tabIndex={state.tab === t.id ? 0 : -1} className="ext-tab" data-selected={state.tab === t.id} onClick={() => void model.showTab(t.id)}>
              {t.label}
              {t.id === "installed" && state.loaded ? <span className="lib-count"> {state.items.length.toLocaleString()}</span> : null}
              {t.id === "installed" && updates > 0 ? <span className="ext-dot" aria-label={`${updates} updates available`} /> : null}
            </button>
          ))}
        </div>
        {state.tab === "installed" && view === "catalog" && (
          <button type="button" className="lib-btn" disabled={state.checking || state.catalogOff || state.items.length === 0} onClick={() => void model.checkUpdates()} title="Asks GitHub for the newest commit of each installed item">
            {state.checking ? "Checking…" : "Check for updates"}
          </button>
        )}
      </header>

      {state.catalogOff && <StatusBanner severity="warning" message="The extension catalog is turned off on this server. Installing, updating and refreshing are unavailable; you can still switch items on and off and remove them." />}
      {state.corrupt && <StatusBanner severity="error" message="The installed record is unreadable. Nothing was changed. Existing items are not loaded until it is repaired." />}
      {state.notice && (
        <div className="ext-notice">
          <StatusBanner severity={state.notice.error ? "error" : "info"} message={state.notice.text} onDismiss={() => model.dismissNotice()} />
          {state.notice.retry && (
            <button type="button" className="lib-btn" onClick={() => void model.retry()}>
              Try again
            </button>
          )}
        </div>
      )}
      {state.active?.failClosed && <StatusBanner severity="warning" message="The active set could not be computed, so no installed extension is loaded into chats right now." />}

      <div id="ext-panel" role="tabpanel" aria-labelledby={`ext-tab-${state.tab}`} className="ext-panel">
        {state.tab === "installed" && views.length > 1 && (
          <div role="tablist" aria-label="Kind of extension" className="ext-tabs ext-views" onKeyDown={onViewKey}>
            {views.map((v) => (
              <button key={v.id} id={`ext-view-${v.id}`} type="button" role="tab" aria-selected={view === v.id} aria-controls="ext-panel" tabIndex={view === v.id ? 0 : -1} className="ext-tab" data-selected={view === v.id} onClick={() => setView(v.id)}>
                {v.label}
              </button>
            ))}
          </div>
        )}
        {state.tab === "installed" && !legacyModel && <InstalledTab model={model} state={state} initialHeight={initialHeight} />}
        {state.tab === "installed" && legacyModel && <LegacyView key={legacyModel.kind} model={legacyModel} initialHeight={initialHeight} revealer={legacyModel.kind === "llm-sources" ? revealer : undefined} />}
        {state.tab === "browse" && <BrowseTab model={model} state={state} initialHeight={initialHeight} openRepository={openRepository} />}
        {state.tab === "install" && <AddTab model={model} state={state} legacy={legacy} />}
      </div>
      {state.tab === "installed" && state.active && (
        <>
          <p className="lib-muted ext-active" role="status">
            In chats now: {state.active.skills.toLocaleString()} skills, {state.active.mcpServers.toLocaleString()} MCP servers, {state.active.sdkPlugins.toLocaleString()} plugins.
          </p>
          {activeScopeNote(state.active) && <p className="lib-muted ext-active" role="note">{activeScopeNote(state.active)}</p>}
          {state.active.excluded.length + state.active.warnings.length > 0 ? (
            <details className="ext-notloaded">
              <summary>Not loaded ({(state.active.excluded.length + state.active.warnings.length).toLocaleString()}): switched on but left out of chats, and why</summary>
              <ul>
                {state.active.excluded.map((x) => <li key={`${x.kind}:${x.name}`}><strong>{x.name}</strong> <span className="lib-muted">({x.kind}) {x.reason}</span></li>)}
                {state.active.warnings.map((w) => <li key={w}>{w}</li>)}
              </ul>
            </details>
          ) : null}
          <p className="lib-muted ext-active" role="note">Plugins and MCP servers are used by chats in Execute and Auto. Ask, Plan, Review and Document chats, and Loop and Factory runs, use skills only.</p>
        </>
      )}
      <Sheets model={model} state={state} initialHeight={initialHeight} />
    </div>
  );
}

/**
 * Mount point. The models are made inside the effect and dropped by its cleanup, so a remount (React StrictMode runs
 * every effect twice in development) gets fresh, live models instead of disposed ones. Only the catalog is read on
 * open; each other list is read when its view is first shown.
 */
export function ExtensionsScreen({ api, legacyApi, initialHeight, openRepository, revealer, request }: { api: ExtensionsApi; legacyApi?: LegacyApi; initialHeight?: number; openRepository?: (url: string) => void; revealer?: LocationReveal; request?: OpenRequest | null }): ReactNode {
  const [models, setModels] = useState<{ model: ExtensionsModel; legacy: LegacyModels | undefined } | null>(null);
  useEffect(() => {
    const model = new ExtensionsModel(api);
    const legacy: LegacyModels | undefined = legacyApi
      ? { plugins: new LegacyModel(legacyApi, "plugins"), "mcp-plugins": new LegacyModel(legacyApi, "mcp-plugins"), "llm-sources": new LegacyModel(legacyApi, "llm-sources") }
      : undefined;
    const all = Object.values(legacy ?? {});
    // The sidebar's problem indicator. A list reports only once it has a health result in this mount, so opening the
    // screen (with nothing checked yet) never wipes a count that an earlier visit found.
    const seen = new Set<string>();
    const report = (): void => {
      const cat = model.getSnapshot().health;
      if (seen.has("catalog") || Object.keys(cat).length > 0) { seen.add("catalog"); problemStore.set("catalog", countProblems(cat)); }
      for (const m of all) {
        const h = m.getSnapshot().health;
        if (seen.has(m.kind) || Object.keys(h).length > 0) { seen.add(m.kind); problemStore.set(m.kind, countProblems(h)); }
      }
    };
    const off = [model.subscribe(report), ...all.map((m) => m.subscribe(report))];
    void model.init();
    setModels({ model, legacy });
    return () => {
      off.forEach((f) => f());
      model.dispose();
      all.forEach((m) => m.dispose());
      setModels(null);
    };
  }, [api, legacyApi]);
  if (!models) return null;
  return <ExtensionsView model={models.model} initialHeight={initialHeight} openRepository={openRepository} legacy={models.legacy} revealer={revealer} request={request} />;
}
