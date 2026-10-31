// The Extensions screen (Library > Extensions): Installed / Browse / Install tabs, a result notice and the one modal.
// Everything arrives as props (an ExtensionsApi), so it renders and tests without Tauri.
import { useEffect, useMemo, useSyncExternalStore, type KeyboardEvent, type ReactNode } from "react";
import { StatusBanner } from "@llmide/ui-kit";
import type { ExtensionsApi } from "./api.ts";
import { BrowseTab } from "./BrowseTab.tsx";
import { InstallTab } from "./InstallTab.tsx";
import { InstalledTab } from "./InstalledTab.tsx";
import { ExtensionsModel, type ExtensionsState, type Tab } from "./model.ts";
import { hasUpdate } from "./presentation.ts";
import { ConfirmSheet, ConsentSheet, PreviewSheet } from "./Sheets.tsx";

const TABS: { id: Tab; label: string }[] = [
  { id: "installed", label: "Installed" },
  { id: "browse", label: "Browse" },
  { id: "install", label: "Install" },
];

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

export function ExtensionsView({ model, initialHeight }: { model: ExtensionsModel; initialHeight?: number }): ReactNode {
  const state = useExtensionsState(model);
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
        {state.tab === "installed" && (
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
        {state.tab === "installed" && <InstalledTab model={model} state={state} initialHeight={initialHeight} />}
        {state.tab === "browse" && <BrowseTab model={model} state={state} initialHeight={initialHeight} />}
        {state.tab === "install" && <InstallTab model={model} state={state} />}
      </div>
      {state.tab === "installed" && state.active && (
        <p className="lib-muted ext-active" role="status">
          In chats now: {state.active.skills.toLocaleString()} skills, {state.active.mcpServers.toLocaleString()} MCP servers, {state.active.sdkPlugins.toLocaleString()} plugins.
        </p>
      )}
      <Sheets model={model} state={state} initialHeight={initialHeight} />
    </div>
  );
}

/** Mount point: one model per mount, cancelled on unmount. Appearing reads only the core's cached lists. */
export function ExtensionsScreen({ api, initialHeight }: { api: ExtensionsApi; initialHeight?: number }): ReactNode {
  const model = useMemo(() => new ExtensionsModel(api), [api]);
  useEffect(() => {
    void model.init();
    return () => model.dispose();
  }, [model]);
  return <ExtensionsView model={model} initialHeight={initialHeight} />;
}
