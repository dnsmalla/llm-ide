// Doc Gen and Visual: one screen, two surfaces (the surface only picks which templates and commands are offered,
// the title and the wording; both generate through the same core route, like the Mac app).
import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { StatusBanner } from "@llmide/ui-kit";
import { HistoryPanel } from "./HistoryPanel";
import { estimateFit } from "./model.ts";
import { ResultPanel } from "./ResultPanel";
import { SetupPanel } from "./SetupPanel";
import { SourcePanel, type SourceEnv } from "./SourcePanel";
import { estimateChars, sendOrder } from "./sources.ts";
import type { DocGenStore } from "./store.ts";
import { TemplateManager } from "./TemplateManager";
import type { FsApi } from "../explorer/fs";

export interface DocGenScreenProps {
  store: DocGenStore;
  env: SourceEnv & { fs: Pick<FsApi, "list"> | null };
  active: boolean;
  projectRoot: string | null;
  onOpenFile: (path: string) => void;
  onOpenExternal: (url: string) => void;
  onOpenSettings: () => void;
  /** Test hooks. */
  initialView?: "result" | "history";
  initialViewport?: number;
  initialSections?: number;
  showManager?: boolean;
}

export function DocGenScreen(p: DocGenScreenProps): ReactNode {
  const { store } = p;
  const s = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const run = useSyncExternalStore(store.run.subscribe, store.run.getSnapshot, store.run.getSnapshot);
  const [view, setView] = useState<"result" | "history">(p.initialView ?? "result");
  const [manage, setManage] = useState(p.showManager ?? false);
  useEffect(() => {
    void store.setProject(p.projectRoot);
  }, [store, p.projectRoot]);
  const items = useMemo(() => sendOrder(s.selection.items()), [s.selection]);
  const fit = useMemo(() => (items.length ? estimateFit(items.map((i) => ({ name: i.name, chars: i.kind === "paste" ? i.bytes : estimateChars(i.bytes) }))) : null), [items]);
  const title = store.surface === "visual" ? "Visual" : "Doc Gen";
  const busy = run.phase === "reading" || run.phase === "generating";

  let body: ReactNode;
  if (s.setup === "no_project") {
    body = (
      <div className="dg-empty">
        <h2 className="dg-h2">Open a project first</h2>
        <p className="dg-muted">{title} saves its output inside the project (<code>llm-doc/generated</code>) and reads templates from it.</p>
      </div>
    );
  } else if (s.setup === "loading") {
    body = (
      <p className="dg-muted" role="status" aria-live="polite">
        Connecting to the core and loading templates…
      </p>
    );
  } else if (s.setup === "error") {
    body = (
      <div className="dg-error" role="alert">
        <h2 className="dg-h2">{title} is not ready</h2>
        <p>{s.setupError?.message}</p>
        <div className="dg-actions">
          <button type="button" className="dg-btn dg-primary" onClick={() => void store.load()}>
            Try again
          </button>
          {s.setupError?.action === "settings" && (
            <button type="button" className="dg-btn" onClick={p.onOpenSettings}>
              Open Settings
            </button>
          )}
        </div>
      </div>
    );
  } else {
    body = (
      <div className="dg-grid">
        <div className="dg-left">
          <SetupPanel
            surface={store.surface}
            templates={s.templates}
            commands={s.commands}
            truncated={s.truncated}
            templateId={s.templateId}
            commandId={s.commandId}
            command={s.command}
            prompt={s.prompt}
            fit={fit}
            sourceCount={s.selection.size}
            run={run}
            onTemplate={(id) => store.selectTemplate(id)}
            onCommandPick={(id) => store.selectCommand(id)}
            onCommandText={(t) => store.setCommandText(t)}
            onPrompt={(t) => store.setPrompt(t)}
            onManage={() => setManage(true)}
            onGenerate={() => {
              setView("result");
              void store.generate();
            }}
            onCancel={() => store.run.cancel()}
          />
          <SourcePanel
            env={p.env}
            selection={s.selection}
            note={s.selectionNote}
            surface={store.surface}
            onAdd={(i) => store.addItems(i)}
            onRemove={(k) => store.removeKeys(k)}
            onClear={() => store.clearSelection()}
            onPaste={(t) => store.addPaste(t)}
            initialViewport={p.initialViewport}
          />
        </div>
        <div className="dg-right">
          <div className="dg-tabs" role="tablist" aria-label="Output">
            <button type="button" role="tab" id="dg-out-result" aria-selected={view === "result"} aria-controls="dg-out-pane" tabIndex={view === "result" ? 0 : -1} className="dg-tab" onClick={() => setView("result")}>
              Result
            </button>
            <button type="button" role="tab" id="dg-out-history" aria-selected={view === "history"} aria-controls="dg-out-pane" tabIndex={view === "history" ? 0 : -1} className="dg-tab" onClick={() => setView("history")}>
              History
            </button>
          </div>
          <div role="tabpanel" id="dg-out-pane" aria-labelledby={view === "result" ? "dg-out-result" : "dg-out-history"} className="dg-pane">
            {view === "result" ? (
              <ResultPanel
                surface={store.surface}
                run={run}
                onCancel={() => store.run.cancel()}
                onRetry={() => void store.generate()}
                onRefine={(t) => void store.run.refine(t)}
                onSave={() => void store.run.save()}
                onSaveAsNew={() => void store.run.save({ asNew: true })}
                onOpenSaved={p.onOpenFile}
                onDiscard={() => store.run.reset()}
                onOpenExternal={p.onOpenExternal}
                onOpenSettings={p.onOpenSettings}
                onSignIn={p.onOpenSettings}
                initialSections={p.initialSections}
              />
            ) : (
              <HistoryPanel fs={p.env.fs} version={run.saved?.hash ?? ""} active={p.active} onOpen={p.onOpenFile} initialViewport={p.initialViewport} />
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="dg-root" data-active={p.active} data-surface={store.surface} aria-busy={busy}>
      <header className="dg-top">
        <h1 className="dg-title">{title}</h1>
        {s.setup === "ready" && <p className="dg-muted">{store.surface === "visual" ? "Describe or diagram your sources." : "Turn sources into a document."}</p>}
      </header>
      {body}
      {manage && s.setup === "ready" && (
        <TemplateManager
          templates={s.templates}
          busy={s.templateBusy}
          error={s.templateError}
          onSave={(i) => store.saveTemplate(i)}
          onDelete={(t) => store.deleteTemplate(t)}
          onClose={() => setManage(false)}
        />
      )}
      {s.setup === "ready" && s.templates.length === 0 && (
        <StatusBanner severity="info" message={<>No templates for this project yet. Use Manage templates to create one, or write a command.</>} />
      )}
    </div>
  );
}
