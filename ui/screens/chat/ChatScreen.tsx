// The Chat screen: session list, conversation, composer, pickers. Wiring only; the logic lives in the pure
// modules (events, state, controller, route, virtual, markdown) and is tested without a DOM.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { StatusBanner } from "@llmide/ui-kit";
import { Composer, type ComposerProps } from "./Composer";
import { ComposerWithExtras } from "./slash/ComposerWithExtras";
import type { ComposeServices } from "./slash/extras";
import { PlanController } from "./plan/controller";
import { PlanArea, refineSeed } from "./plan/PlanArea";
import { HeaderBadges } from "./badges/HeaderBadges";
import { ENDED_REASON, isEndedChat } from "./badges/Badges";
import { MessageList } from "./MessageList";
import { CapChip, ModePicker, ModelPicker, PermissionChip } from "./Pickers";
import { SessionList } from "./SessionList";
import { ModeBanner } from "./approvals/ModeBanner";
import type { ChatController } from "./controller";
import { useChatState, useControllerVersion } from "./hooks";
import {
  AUTO_MODE, getRoute, loadModelGroups, needsBypassConfirm, pickerMode, pickerModeAfterSessionChange, plainChatReason, putRoute,
  type ModelGroup, type PermissionMode, type RouteView,
} from "./route";
import type { ChatState } from "./state";
import type { ChatStore, SessionSummary } from "./store";
import type { FileRefs } from "./MessageView";
import { describeError, type CoreTransport } from "./transport";
import { isDeclined, isPendingCorrupt, PENDING_CORRUPT_NOTICE, unreadableNotice } from "./tauri-store";

export interface ChatHost {
  /** Opens an allowlisted URL with the system handler. */
  openLink: (href: string) => void;
  copy: (text: string) => void;
  /** "Open in Explorer" for files named by tool calls; absent = no button. */
  files?: FileRefs;
  /** Host file dialog; absent = the Attach button is hidden (checklist row stays open). */
  attachFiles?: () => void;
  /** Slash menu, @ mentions, attachments and plan saving (slash/extras.tsx); absent = the plain composer. */
  compose?: ComposeServices;
  /** Native confirmation for Bypass (once per app run). Resolve true to proceed. */
  confirmBypass?: () => Promise<boolean>;
}

export interface ChatScreenProps {
  controller: ChatController;
  store: ChatStore;
  core: CoreTransport;
  host: ChatHost;
  /** Open this chat first (deep link / restore). */
  initialSessionId?: string | null;
  /** S-G slot: approval and question cards for the running turn. */
  approvals?: (state: ChatState) => ReactNode;
  /** Shown above the conversation (trust banner, S-G). */
  banner?: ReactNode | ((state: ChatState) => ReactNode);
  /** No project is open: the core needs a workspace root, so sending is disabled with a reason. */
  noProject?: boolean;
}

const SESSION_PAGE = 100;

interface ChatPrefs { mode: string; provider: string | null; model: string | null }

export function ChatScreen({ controller, store, core, host, initialSessionId = null, approvals, banner, noProject = false }: ChatScreenProps) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [hasMoreSessions, setHasMoreSessions] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [unreadable, setUnreadable] = useState<string | null>(null);
  // Errors the user caused or can ignore are not alarms: a declined confirm is silent, bookkeeping is an info notice.
  const reportStoreError = useCallback((e: unknown) => {
    if (isDeclined(e)) return;
    if (isPendingCorrupt(e)) { setNotice(PENDING_CORRUPT_NOTICE); return; }
    setListError(describeError(e).message);
  }, []);
  const refreshHealth = useCallback(() => { const h = store.listHealth?.(); setUnreadable(h ? unreadableNotice(h) : null); }, [store]);
  const [activeId, setActiveId] = useState<string | null>(initialSessionId);
  const [prefs, setPrefs] = useState<Record<string, ChatPrefs>>({});
  const [permission, setPermission] = useState<PermissionMode>("ask");
  const bypassConfirmed = useRef(false);
  const [groups, setGroups] = useState<ModelGroup[]>([]);
  const [toolsEnabled, setToolsEnabled] = useState(false);
  const [route, setRoute] = useState<RouteView | null>(null);
  const loadingMore = useRef(false);
  const plans = useMemo(() => new PlanController(host.compose?.project ?? null), [host.compose?.project]);
  const [refineNonce, setRefineNonce] = useState(0);
  useControllerVersion(controller); // re-render when any chat's busy flag changes

  // Sessions: first page now, more on demand.
  useEffect(() => {
    const ac = new AbortController();
    store.listSessions({ limit: SESSION_PAGE, offset: 0 }, ac.signal)
      .then((s) => { setSessions(s); setHasMoreSessions(s.length === SESSION_PAGE); refreshHealth(); })
      .catch((e) => { if (!ac.signal.aborted) setListError(describeError(e).message); });
    return () => ac.abort();
  }, [store, refreshHealth]);

  const loadMoreSessions = useCallback(() => {
    if (loadingMore.current) return;
    loadingMore.current = true;
    store.listSessions({ limit: SESSION_PAGE, offset: sessions.length })
      .then((more) => { setSessions((cur) => [...cur, ...more.filter((m) => !cur.some((c) => c.id === m.id))]); setHasMoreSessions(more.length === SESSION_PAGE); })
      .catch((e) => setListError(describeError(e).message))
      .finally(() => { loadingMore.current = false; });
  }, [store, sessions.length]);

  // Model list once per screen.
  useEffect(() => {
    const ac = new AbortController();
    loadModelGroups(core, ac.signal).then((r) => { setGroups(r.groups); setToolsEnabled(r.toolsEnabled); }).catch(() => undefined);
    return () => ac.abort();
  }, [core]);

  // Opening a chat: history, route (cap + pinned model), "running on the core" hint.
  useEffect(() => {
    if (!activeId) return;
    const ac = new AbortController();
    void controller.open(activeId, ac.signal);
    void controller.refreshRemoteBusy(ac.signal);
    getRoute(core, activeId, ac.signal).then(setRoute).catch(() => setRoute(null));
    return () => ac.abort();
  }, [activeId, controller, core]);

  const state = useChatState(controller, activeId ?? "");
  const current: ChatPrefs = (activeId && prefs[activeId]) || { mode: pickerModeAfterSessionChange(), provider: null, model: null };
  const setCurrent = (patch: Partial<ChatPrefs>) => { if (activeId) setPrefs((p) => ({ ...p, [activeId]: { ...current, ...patch } })); };

  // Auto follows the server's resolved mode; a hand-picked mode never moves.
  useEffect(() => {
    if (!activeId || !state.resolvedMode) return;
    const follow = pickerMode(current.mode, state.resolvedMode);
    if (follow) setPrefs((p) => ({ ...p, [activeId]: { ...current, mode: follow } }));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.resolvedMode, activeId]);

  const newChat = useCallback(async () => {
    try {
      const s = await store.createSession({});
      setSessions((cur) => [s, ...cur]);
      setActiveId(s.id);
    } catch (e) { reportStoreError(e); }
  }, [store, reportStoreError]);

  const busy = state.phase === "streaming" || state.phase === "aborting";
  const history = useMemo(() => state.messages.filter((m) => m.role === "user").map((m) => (m as { text: string }).text).slice(-50), [state.messages]);
  const busyIds = useMemo(() => new Set(controller.busyIds()), [controller, state]);
  const plain = plainChatReason(current.provider ?? "", current.model ?? "", current.mode, groups, toolsEnabled);
  const remoteBusy = activeId ? controller.isRemoteBusy(activeId) : false;

  const onLoadOlder = useCallback(() => (activeId ? controller.loadOlder(activeId) : Promise.resolve(0)), [activeId, controller]);
  const onScrollState = useCallback((scrollTop: number, stick: boolean) => { if (activeId) controller.setView(activeId, { scrollTop, stickToBottom: stick }); }, [activeId, controller]);

  const changePermission = async (m: PermissionMode) => {
    if (needsBypassConfirm(m, bypassConfirmed.current)) {
      const ok = host.confirmBypass ? await host.confirmBypass() : false; // fail closed without a native confirm
      if (!ok) return;
      bypassConfirmed.current = true;
    }
    setPermission(m);
  };

  return (
    <div className="chat-screen">
      <SessionList
        sessions={sessions} activeId={activeId} busyIds={busyIds} hasMore={hasMoreSessions} onLoadMore={loadMoreSessions}
        onSelect={setActiveId} onNew={() => void newChat()}
        onRename={(id, title) => { setSessions((cur) => cur.map((s) => (s.id === id ? { ...s, title } : s))); store.renameSession(id, title).catch(reportStoreError); }}
        onDelete={(id) => {
          store.deleteSession(id).then(() => { controller.forget(id); setSessions((cur) => cur.filter((s) => s.id !== id)); if (activeId === id) setActiveId(null); })
            .catch(reportStoreError);
        }}
        unreadableNotice={unreadable}
      />
      <section className="chat-main" aria-label="Chat">
        {notice && <StatusBanner severity="info" message={notice} onDismiss={() => setNotice(null)} />}
        {listError && <StatusBanner severity="error" message={listError} onDismiss={() => setListError(null)} />}
        <ModeBanner mode={permission} />
        {typeof banner === "function" ? banner(state) : banner}
        {!activeId ? (
          <div className="chat-empty"><p>Select a chat or start a new one.</p><button type="button" className="chat-btn chat-primary" onClick={() => void newChat()}>New chat</button></div>
        ) : (
          <>
            <header className="chat-header">
              <h2 className="chat-title">{sessions.find((s) => s.id === activeId)?.title || "Untitled chat"}</h2>
              {state.context && <span className="chat-muted" aria-label={`Context ${state.context.percentage} percent used`}>Context {state.context.percentage}%</span>}
              {state.model && <span className="chat-muted">{state.model}</span>}
              <HeaderBadges chatId={activeId} mode={current.mode} state={state} core={core} />
              <span className="chat-spacer" />
              <CapChip route={route} disabled={busy} onSetLimit={async (limit) => { const r = await putRoute(core, activeId, { tokenLimit: limit }); setRoute(r); return r; }} />
            </header>
            {remoteBusy && <StatusBanner severity="info" message="A turn is running for this chat on the core. Its live output cannot be shown here yet." />}
            {state.phase === "error" && state.error && (
              <StatusBanner severity="error" message={<>{state.error.message}{state.error.retryable && <> <button type="button" className="chat-link-btn" onClick={() => controller.retry(activeId)}>Retry</button></>}</>} onDismiss={() => controller.clearError(activeId)} />
            )}
            <MessageList
              key={activeId} messages={state.messages} hasMoreOlder={state.hasMoreOlder} onLoadOlder={onLoadOlder}
              initialScrollTop={controller.getView(activeId).stickToBottom ? null : controller.getView(activeId).scrollTop}
              onScrollState={onScrollState} onOpenLink={host.openLink} onCopy={host.copy} files={host.files}
              empty={<p className="chat-muted chat-pad">Ask anything. Mode and model are below.</p>}
            />
            {state.tasks.length > 0 && (
              <ul className="chat-tasks" aria-label="Tasks">
                {state.tasks.map((t) => <li key={t.id} data-status={t.status}>{t.title} <span className="chat-muted">{t.status}</span></li>)}
              </ul>
            )}
            <PlanArea
              chatId={activeId} state={state} mode={current.mode} plans={plans} onOpenLink={host.openLink} onCopy={host.copy}
              onRefine={(title) => { controller.setView(activeId, { draft: refineSeed(title) }); setRefineNonce((n) => n + 1); }}
              onExecute={(turn) => {
                setCurrent({ mode: "execute" });
                controller.send(activeId, turn.text, { ...turn.options, model: current.model, provider: current.provider, permissionMode: permission });
                touchSession(activeId);
              }}
            />
            {approvals?.(state)}
            <div className="chat-controls">
              <ModePicker value={current.mode} resolved={state.resolvedMode} onChange={(mode) => setCurrent({ mode })} />
              <ModelPicker groups={groups} provider={current.provider} model={current.model} plainChat={plain}
                onChange={(provider, model) => { setCurrent({ provider: provider || null, model: model || null }); if (route?.enabled && provider) putRoute(core, activeId, { provider, model }).then(setRoute).catch(() => undefined); }} />
              <PermissionChip value={permission} onChange={(m) => void changePermission(m)} />
            </div>
            <DraftComposer
              key={`${activeId}:${refineNonce}:${controller.getView(activeId).draftRev}`} controller={controller} id={activeId}
              compose={host.compose} models={groups} setMode={(mode) => setCurrent({ mode })} clearChat={() => void newChat()}
              setModel={(provider, model) => { setCurrent({ provider, model }); if (route?.enabled) putRoute(core, activeId, { provider, model }).then(setRoute).catch(() => undefined); }}
              busy={busy} aborting={state.phase === "aborting"} queue={state.queue} history={history}
              onSend={(text, extra) => { controller.send(activeId, text, { mode: current.mode || AUTO_MODE, model: current.model, provider: current.provider, permissionMode: permission, skills: extra?.skills, attachments: extra?.attachments }); touchSession(activeId); }}
              onStop={() => controller.abort(activeId)} onDropQueued={(i) => controller.dropQueued(activeId, i)} onAttach={host.attachFiles} disabledReason={isEndedChat(sessions.find((s) => s.id === activeId)) ? ENDED_REASON : noProject ? "Open a project to send messages." : null}
            />
          </>
        )}
      </section>
    </div>
  );

  function touchSession(id: string) {
    setSessions((cur) => { const i = cur.findIndex((s) => s.id === id); if (i <= 0) return cur; const s = { ...cur[i], updatedAt: Date.now() / 1000 }; return [s, ...cur.slice(0, i), ...cur.slice(i + 1)]; });
  }
}

/** Owns the draft text locally (typing never re-renders the conversation) and saves it per chat on every change. */
function DraftComposer({ controller, id, compose, models, setMode, setModel, clearChat, ...rest }: { controller: ChatController; id: string; compose?: ComposeServices; models: ModelGroup[]; setMode: (id: string) => void; setModel: (provider: string, model: string) => void; clearChat: () => void } & Omit<ComposerProps, "draft" | "onDraft" | "extras">) {
  const [draft, setDraft] = useState(() => controller.getView(id).draft);
  const onDraft = (t: string) => { setDraft(t); controller.setView(id, { draft: t }); };
  if (!compose) return <Composer {...rest} draft={draft} onDraft={onDraft} />;
  return <ComposerWithExtras {...rest} draft={draft} onDraft={onDraft} compose={compose} models={models} setMode={setMode} setModel={setModel} clearChat={clearChat} chatId={id} />;
}
