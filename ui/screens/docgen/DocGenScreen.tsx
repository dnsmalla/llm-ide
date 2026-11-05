// Doc Gen and Visual: one screen, two surfaces (the surface only picks which templates and commands are offered,
// the title and the wording; both generate through the same core route, like the Mac app).
import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { StatusBanner } from "@llmide/ui-kit";
import { NoProjectCard } from "../shell/NoProjectCard";
import { HistoryPanel } from "./HistoryPanel";
import { estimateFit } from "./model.ts";
import { GENERATED_DIR, normalizeDestination } from "./naming.ts";
import { ResultPanel } from "./ResultPanel";
import type { MermaidRuntimeApi } from "./mermaid/renderer.ts";
import type { DocCommand, DocTemplate, FitReport } from "./model.ts";
import type { Failure } from "./errors.ts";
import type { RunState } from "./run.ts";
import { SourcePanel, type SourceEnv } from "./SourcePanel";
import { checklistSteps } from "./checklist.ts";
import { MAX_COMMAND, MAX_PROMPT, formatBytes } from "./model.ts";
import { estimateChars, sendOrder } from "./sources.ts";
import type { DocGenStore } from "./store.ts";
import { TemplateManager } from "./TemplateManager";
import type { PickedTemplateFile } from "./template-file.ts";
import { CommandManager } from "./CommandManager";
import type { FsApi } from "../explorer/fs";
import { chatOutputStore } from "../shell/chat-output";
import { ChatDockSlot } from "../shell/chat-dock";

export interface DocGenScreenProps {
  store: DocGenStore;
  env: SourceEnv & { fs: Pick<FsApi, "list"> | null };
  active: boolean;
  projectRoot: string | null;
  onOpenFile: (path: string) => void;
  /** Reveal a project-relative path in the OS file manager (desktop only). */
  onReveal?: (path: string) => void;
  /** A failed reveal, shown as a banner until the next reveal (null when none). */
  revealNotice?: string | null;
  /** The host's picker for a Markdown template file (desktop only). */
  pickTemplateFile?: () => Promise<PickedTemplateFile>;
  /** Native save panel for an out-of-project copy (desktop only). */
  onExport?: (name: string, text: string) => Promise<void>;
  /** Result of the last out-of-project export (null when none). */
  exportNotice?: { kind: "ok" | "error"; message: string } | null;
  /** Display name of a host-chosen output folder; null = the project folder. */
  externalDestination?: string | null;
  onPickExternal?: () => void;
  onClearExternal?: () => void;
  onOpenExternal: (url: string) => void;
  onOpenSettings: () => void;
  /** The diagram renderer binding (host builds only). */
  mermaid?: MermaidRuntimeApi;
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
  const [manageCommands, setManageCommands] = useState(false);
  const pref = (suffix: string): string => `llmide.docgen.${store.surface}.${suffix}`;
  const [showChat, setShowChat] = useState(() => { try { return localStorage.getItem(pref("chat")) !== "0"; } catch { return true; } });
  const [showSources, setShowSources] = useState(() => { try { return localStorage.getItem(pref("sources")) !== "0"; } catch { return true; } });
  useEffect(() => {
    void store.setProject(p.projectRoot);
  }, [store, p.projectRoot]);
  const chatOutput = useSyncExternalStore(chatOutputStore.subscribe, chatOutputStore.get, chatOutputStore.get);
  const [useChat, setUseChat] = useState(() => { try { return localStorage.getItem(pref("useChat")) === "1"; } catch { return false; } });
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    try { const raw = localStorage.getItem(pref("sections")); if (raw === null) return new Set(["template", "sources"]); const v = JSON.parse(raw) as unknown; return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : ["template", "sources"]); } catch { return new Set(["template", "sources"]); }
  });
  const setSection = (id: string, open: boolean) => setExpanded((cur) => {
    const next = new Set(cur); if (open) next.add(id); else next.delete(id);
    try { localStorage.setItem(pref("sections"), JSON.stringify([...next])); } catch { /* session */ }
    return next;
  });
  const isOpen = (id: string) => expanded.has(id);
  // The folder field edits a local draft so a trailing "/" typed on the way to "a/b" is not trimmed away mid-keystroke;
  // the draft is committed (normalized, remembered) on blur, Enter, or the default button.
  const [folderDraft, setFolderDraft] = useState<string | null>(null);
  const commitFolder = (raw: string) => {
    const clean = normalizeDestination(raw);
    store.setDestination(clean);
    store.run.setExternalDestination(null);
    setFolderDraft(null);
    try { localStorage.setItem("llmide.docgen.destination", clean); } catch { /* session */ }
  };
  useEffect(() => { try { localStorage.setItem(pref("chat"), showChat ? "1" : "0"); } catch { /* session */ } }, [showChat, pref]);
  useEffect(() => { try { localStorage.setItem(pref("sources"), showSources ? "1" : "0"); } catch { /* session */ } }, [showSources, pref]);
  useEffect(() => { try { localStorage.setItem(pref("useChat"), useChat ? "1" : "0"); } catch { /* session */ } }, [useChat, pref]);
  const chatItem = useMemo(() => (useChat && chatOutput ? { key: "chat:latest", kind: "paste" as const, rel: "", name: "Latest chat reply", bytes: chatOutput.text.length, text: chatOutput.text } : null), [useChat, chatOutput]);
  const items = useMemo(() => sendOrder([...s.selection.items(), ...(chatItem ? [chatItem] : [])]), [s.selection, chatItem]);
  const fit = useMemo(() => (items.length ? estimateFit(items.map((i) => ({ name: i.name, chars: i.kind === "paste" ? i.bytes : estimateChars(i.bytes) }))) : null), [items]);
  const title = store.surface === "visual" ? "Visual" : "Doc Gen";
  const busy = run.phase === "reading" || run.phase === "generating";
  const hasShape = useChat || Boolean(s.templateId || s.command.trim());
  const missing = !hasShape ? "Choose a template or write a command." : s.selection.size + (chatItem ? 1 : 0) === 0 ? "Select at least one source." : null;

  let body: ReactNode;
  if (s.setup === "no_project") {
    body = (
      <NoProjectCard what={`use ${title}`} hint={`${title} saves its output inside the project (llm-doc/generated) and reads templates from it.`} />
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
      <div className="dg-grid" data-chat={showChat} data-sources={showSources}>
        {showSources ? (
          <aside className="dg-sidebar" aria-label="Sources and template">
            {/* Mac: the whole left panel is disabled while a run is in flight, so inputs cannot drift from the run. */}
            <fieldset className="dg-lock" disabled={busy}>
            <div className="dg-sidebar-use"><div><label className="dg-inline"><input type="checkbox" checked={useChat} disabled={chatOutput === null} onChange={(e) => setUseChat(e.target.checked)} /> Use chat</label><p className="dg-muted">{useChat ? "On: generate can use the latest chat reply as a source; template/command is optional." : "Off: pick a template or command and at least one source, then Generate."}</p></div></div>
            <details className="dg-side-collapse" open={isOpen("setup")} onToggle={(e) => setSection("setup", e.currentTarget.open)}><summary>SETUP</summary>
              <div className="dg-field" role="radiogroup" aria-label="Where to deliver">
                <span>Deliver to</span>
                {OUTPUT_DESTINATIONS.map((d) => (
                  <label key={d.id} className="dg-inline"><input type="radio" name={`dg-deliver-${store.surface}`} value={d.id} checked={d.id === "local"} disabled={!d.available} onChange={() => undefined} /> {d.label}{d.available ? null : <em className="dg-muted"> Coming soon</em>}</label>
                ))}
              </div>
              <label className="dg-field"><span>Output folder</span><input value={folderDraft ?? s.destination} placeholder={GENERATED_DIR} disabled={p.externalDestination !== null && p.externalDestination !== undefined} onChange={(e) => setFolderDraft(e.target.value)} onBlur={() => commitFolder(folderDraft ?? s.destination)} onKeyDown={(e) => { if (e.key === "Enter") commitFolder(folderDraft ?? s.destination); }} /><em className="dg-muted">Where generated files are saved, relative to the project.</em></label>
              <div className="dg-bar">
                <button type="button" className="dg-btn" disabled={p.externalDestination != null || (s.destination === GENERATED_DIR && folderDraft === null)} onClick={() => commitFolder(GENERATED_DIR)}>Use default folder</button>
                {p.onPickExternal ? <button type="button" className="dg-btn" onClick={p.onPickExternal}>Choose outside folder…</button> : null}
                {p.externalDestination && p.onClearExternal ? <button type="button" className="dg-btn" onClick={p.onClearExternal}>Use project folder</button> : null}
              </div>
              {p.externalDestination ? <p className="dg-muted" role="status">Saving to external folder <strong>{p.externalDestination}</strong>.</p> : null}
            </details>
            <details className="dg-side-collapse" open={isOpen("template")} onToggle={(e) => setSection("template", e.currentTarget.open)}><summary>TEMPLATE &amp; COMMAND</summary><TemplateCommandPanel
              surface={store.surface}
              templates={s.templates}
              commands={s.commands}
              truncated={s.truncated}
              templateId={s.templateId}
              commandId={s.commandId}
              command={s.command}
              onTemplate={(id) => store.selectTemplate(id)}
              onCommandPick={(id) => store.selectCommand(id)}
              onCommandText={(t) => store.setCommandText(t)}
              onManage={() => setManage(true)}
              onManageCommands={() => setManageCommands(true)}
            /></details>
            <details className="dg-side-collapse" open={isOpen("sources")} onToggle={(e) => setSection("sources", e.currentTarget.open)}><summary>SOURCES</summary><SourcePanel env={p.env} unreadable={run.skippedKeys} selection={s.selection} note={s.selectionNote} surface={store.surface} onAdd={(i) => store.addItems(i)} onRemove={(k) => store.removeKeys(k)} onClear={() => store.clearSelection()} onPaste={(t) => store.addPaste(t)} initialViewport={p.initialViewport} sourceTabKey={pref("sourceKind")} /></details>
            </fieldset>
          </aside>
        ) : null}
        <main className="dg-center">
          <p className="dg-breadcrumb">← Choose a template or command from the left panel</p>
          <SelectedSources items={s.selection.items()} chatItem={chatItem} busy={busy} onRemove={(k) => store.removeKeys(k)} onClear={() => store.clearSelection()} />
          <section className="dg-steps" aria-label="Steps to generate">
            <h2 className="dg-steps-title">Steps to generate</h2>
            <ol className="dg-steps-list">
              {checklistSteps(store.surface, Boolean(s.templateId || s.commandId), s.selection.size).map((step, i) => (
                <li key={step.title} className="dg-step" data-done={step.done || undefined}>
                  <span className="dg-step-no" aria-hidden="true">{step.done ? "✓" : i + 1}</span>
                  <div><span className="dg-step-title">{step.title}</span><p className="dg-step-detail">{step.detail}</p></div>
                </li>
              ))}
            </ol>
          </section>
          <div className="dg-tabs" role="tablist" aria-label="Output">
            <button type="button" role="tab" id="dg-out-result" aria-selected={view === "result"} aria-controls="dg-out-pane" tabIndex={view === "result" ? 0 : -1} className="dg-tab" onClick={() => setView("result")}>Result</button>
            <button type="button" role="tab" id="dg-out-history" aria-selected={view === "history"} aria-controls="dg-out-pane" tabIndex={view === "history" ? 0 : -1} className="dg-tab" onClick={() => setView("history")}>History</button>
          </div>
          <div role="tabpanel" id="dg-out-pane" aria-labelledby={view === "result" ? "dg-out-result" : "dg-out-history"} className="dg-pane dg-center-pane">
            {view === "result" ? (
              <ResultPanel surface={store.surface} run={run} externalDestination={p.externalDestination ?? null} onCancel={() => store.run.cancel()} onRetry={() => void store.generate()} onRefine={(t) => store.run.refine(t)} onSave={() => void store.run.save()} onSaveAsNew={() => void store.run.save({ asNew: true })} onExport={p.onExport ? (name, text) => void p.onExport!(name, text) : undefined} onOpenSaved={p.onOpenFile} onReveal={p.onReveal} onDiscard={() => store.run.reset()} onOpenExternal={p.onOpenExternal} onOpenSettings={p.onOpenSettings} onSignIn={p.onOpenSettings} mermaid={p.mermaid} initialSections={p.initialSections} />
            ) : (
              <HistoryPanel fs={p.env.fs} version={run.saved?.hash ?? ""} active={p.active} onOpen={p.onOpenFile} initialViewport={p.initialViewport} />
            )}
          </div>
        </main>
        <aside className="dg-chat" aria-label="Chat assistant" data-hidden={!showChat || undefined}>
          <PromptBar
            surface={store.surface}
            prompt={s.prompt}
            sourceCount={s.selection.size + (chatItem ? 1 : 0)}
            hasShape={hasShape}
            missing={missing}
            fit={fit}
            run={run}
            onPrompt={(t) => store.setPrompt(t)}
            onGenerate={() => { setView("result"); void store.generate(chatItem ? [chatItem] : []); }}
            onCancel={() => store.run.cancel()}
            useChat={useChat}
            chatReply={chatOutput?.text ?? null}
            chatSaved={s.chatSaved}
            chatSaveError={s.chatSaveError}
            onSaveChat={() => { if (chatOutput) void store.saveChatReply(chatOutput.text); }}
          />
          {showChat ? <div className="dg-chat-dock"><ChatDockSlot active={p.active && showChat} projectRoot={p.projectRoot} initialPath={store.surface === "visual" ? s.selection.items().find((i) => i.kind === "file" && /\.(png|jpe?g|gif|webp|bmp|heic|avif|tiff?|svg)$/i.test(i.rel))?.rel ?? null : null} /></div> : null}
        </aside>
      </div>
    );
  }

  return (
    <div className="dg-root" data-active={p.active} data-surface={store.surface} aria-busy={busy}>
      {p.revealNotice && <StatusBanner severity="error" message={<>{p.revealNotice}</>} />}
      {p.exportNotice && <StatusBanner severity={p.exportNotice.kind === "ok" ? "info" : "error"} message={<>{p.exportNotice.message}</>} />}
      <header className="dg-top">
        <h1 className="dg-title">{title}</h1>
        {s.setup === "ready" && <button type="button" className="dg-btn" aria-pressed={showSources} onClick={() => setShowSources((v) => !v)}>{showSources ? "Hide sources" : "Show sources"}</button>}
        {s.setup === "ready" && <button type="button" className="dg-btn" aria-pressed={showChat} onClick={() => setShowChat((v) => !v)}>{showChat ? "Hide chat" : "Show chat"}</button>}
        {s.setup === "ready" && <p className="dg-muted">{store.surface === "visual" ? "Describe or diagram your sources." : "Turn sources into a document."}</p>}
      </header>
      {body}
      {manageCommands && s.setup === "ready" && (
        <CommandManager
          commands={s.commands}
          busy={s.templateBusy}
          error={s.templateError}
          onSave={(input) => store.saveCommand(input)}
          onDelete={(c) => store.deleteCommand(c)}
          onClose={() => setManageCommands(false)}
        />
      )}
      {manage && s.setup === "ready" && (
        <TemplateManager
          templates={s.templates}
          busy={s.templateBusy}
          error={s.templateError}
          onSave={(i) => store.saveTemplate(i)}
          onDelete={(t) => store.deleteTemplate(t)}
          pickFile={p.pickTemplateFile}
          onClose={() => setManage(false)}
        />
      )}
      {s.setup === "ready" && s.templates.length === 0 && (
        <StatusBanner severity="info" message={<>No templates for this project yet. Use Manage templates to create one, or write a command.</>} />
      )}
    </div>
  );
}


function TemplateCommandPanel(p: {
  surface: "doc" | "visual";
  templates: readonly DocTemplate[];
  commands: readonly DocCommand[];
  truncated: boolean;
  templateId: string | null;
  commandId: string | null;
  command: string;
  onTemplate: (id: string | null) => void;
  onCommandPick: (id: string | null) => void;
  onCommandText: (text: string) => void;
  onManage: () => void;
  onManageCommands: () => void;
}): ReactNode {
  return (
    <section className="dg-side-section dg-template" aria-label="Template and command">
      <label className="dg-field"><span>Template</span><select value={p.templateId ?? ""} onChange={(e) => p.onTemplate(e.target.value || null)}><option value="">No template</option>{p.templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
      <div className="dg-bar"><button type="button" className="dg-btn" onClick={p.onManage}>Manage templates</button><button type="button" className="dg-btn" onClick={p.onManageCommands}>Manage commands</button></div>
      {p.truncated ? <p className="dg-muted">More templates than the core lists.</p> : null}
      <label className="dg-field"><span>Saved command</span><select value={p.commandId ?? ""} onChange={(e) => p.onCommandPick(e.target.value || null)}><option value="">Custom</option>{p.commands.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
      <label className="dg-field"><span>Instruction (optional with a template)</span><textarea rows={3} value={p.command} maxLength={MAX_COMMAND} onChange={(e) => p.onCommandText(e.target.value)} /></label>
    </section>
  );
}

function SelectedSources(p: { items: readonly { key: string; name: string; kind?: string; bytes?: number }[]; chatItem: { key: string; name: string; bytes: number } | null; busy: boolean; onRemove: (keys: readonly string[]) => void; onClear: () => void }): ReactNode {
  const all = [...p.items, ...(p.chatItem ? [p.chatItem] : [])];
  // Locked with the left panel while a run is in flight (Mac shows this card only in the idle setup view).
  return (
    <section className="dg-selected" aria-label="Selected sources">
      <header><h3 className="dg-side-title">SELECTED SOURCES</h3>{all.length > 0 ? <button type="button" className="dg-link" disabled={p.busy} onClick={p.onClear}>Clear</button> : null}</header>
      {all.length === 0 ? <div className="dg-empty dg-selected-empty"><p>No sources selected</p><p className="dg-muted">Check files from Code, LLM Doc or Data in the left panel.</p></div> : <ul className="dg-selected-list">{all.map((i) => <li key={i.key}><span className="dg-name">{i.name}</span>{typeof i.bytes === "number" ? <span className="dg-muted">{formatBytes(i.bytes)}</span> : null}<button type="button" className="dg-link" disabled={p.busy} onClick={() => p.onRemove([i.key])}>Remove</button></li>)}</ul>}
    </section>
  );
}

/** Delivery choices as on the Mac's Setup: only the local folder is wired; the others are shown and disabled. */
const OUTPUT_DESTINATIONS: readonly { id: string; label: string; available: boolean }[] = [
  { id: "local", label: "Local folder", available: true },
  { id: "box", label: "Box", available: false },
  { id: "slack", label: "Slack", available: false },
  { id: "email", label: "Email", available: false },
];

function PromptBar(p: { surface: "doc" | "visual"; prompt: string; sourceCount: number; hasShape: boolean; missing: string | null; fit: FitReport | null; run: RunState; useChat: boolean; chatReply: string | null; chatSaved: { reply: string; path: string } | null; chatSaveError: Failure | null; onSaveChat: () => void; onPrompt: (text: string) => void; onGenerate: () => void; onCancel: () => void }): ReactNode {
  const busy = p.run.phase === "reading" || p.run.phase === "generating";
  // Mac's "Save chat output" row (Use chat only): the chat's latest reply goes to its own file, never into the document.
  const chatSavedNow = p.chatReply !== null && p.chatSaved !== null && p.chatSaved.reply === p.chatReply;
  return (
    <section className="dg-prompt" aria-label="Prompt">
      <label className="dg-field"><span className="dg-sr">Prompt</span><textarea rows={2} value={p.prompt} maxLength={MAX_PROMPT} placeholder="Add a short prompt (optional)" onChange={(e) => p.onPrompt(e.target.value)} /></label>
      <div className="dg-prompt-actions"><span className="dg-muted">{p.missing ?? `${p.sourceCount} source${p.sourceCount === 1 ? "" : "s"}${p.fit ? ` · ${p.fit.tokens.toLocaleString("en")} tokens` : ""}`}</span>{busy ? <button type="button" className="dg-btn" onClick={p.onCancel}>Cancel</button> : <button type="button" className="dg-btn dg-primary" disabled={p.missing !== null} aria-describedby={p.missing ? "dg-prompt-missing" : undefined} onClick={p.onGenerate}>Generate</button>}</div>{p.missing ? <p id="dg-prompt-missing" className="dg-muted">{p.missing}</p> : null}
      {p.useChat ? (
        <div className="dg-chat-save">
          <button type="button" className="dg-btn" disabled={p.chatReply === null || chatSavedNow} title={p.chatReply === null ? "No finished assistant reply yet. Send a message in the chat first." : chatSavedNow ? "Already saved this reply. Send another message to save again." : "Save the chat's latest reply to the output folder (does not change the document)."} onClick={p.onSaveChat}>
            {chatSavedNow ? "Chat output saved" : "Save chat output"}
          </button>
          {p.chatSaved && <p className="dg-muted" role="status">Saved to <code>{p.chatSaved.path}</code></p>}
          {p.chatSaveError && <p className="dg-muted" role="alert">{p.chatSaveError.message}</p>}
        </div>
      ) : null}
    </section>
  );
}
