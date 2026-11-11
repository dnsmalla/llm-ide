// The Chat screen: session dropdown, conversation, composer, pickers. Wiring only; the logic lives in the pure
// modules (events, state, controller, route, virtual, markdown) and is tested without a DOM.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { StatusBanner } from "@llmide/ui-kit";
import { shellBus } from "../shell/bus";
import { Composer, type ComposerProps } from "./Composer";
import { ComposerWithExtras } from "./slash/ComposerWithExtras";
import type { ComposeServices } from "./slash/extras";
import { PlanController } from "./plan/controller";
import { PlanArea, refineSeed } from "./plan/PlanArea";
import { HeaderBadges } from "./badges/HeaderBadges";
import { ENDED_REASON, isEndedChat } from "./badges/Badges";
import { MessageList } from "./MessageList";
import { ContextMeter } from "./ContextMeter";
import { BudgetMeter, budgetPercent } from "./BudgetMeter";
import { EmptyChat } from "./EmptyChat";
import { PlanSwitchNotice } from "./plan/PlanSwitchNotice";
import { EffortPicker, ModePicker, ModelPicker, PendingSwitchNote, PermissionChip } from "./Pickers";
import { effectiveEffort, effortLevelsFor, effortStore, turnEffort } from "./effort";
import { enableProviderTools, ModelNotices, modelNotices } from "./model-notices";
import { addTargetGroup, addUserModel, afterRefusedPin, forgetUserModel, loadUserModels, saveUserModels, withUserModels, type UserModels } from "./custom-models";
import { ModeBanner } from "./approvals/ModeBanner";
import { remoteProjectId, subscribeRemoteProject } from "../shell/remote-selection";
import { BYPASS_NEEDS_APPROVAL_NOTICE, bypassSummary, type BypassGate } from "./bypass";
import type { ChatController } from "./controller";
import { useChatState, useControllerVersion } from "./hooks";
import { chatApprovalStore } from "../shell/chat-approvals";
import { chatOutputStore } from "../shell/chat-output";
import {
  AUTO_MODE, MODES, PROVIDER_BLOCKED_NOTE, defaultModelForMode, planProgress, showsPlanProgress, getRoute, loadModelGroups, modelPickPlan, pickerMode, pickerModeAfterSessionChange, plainChatReason, providerCannotChat, putRoute as putRouteWire, type RoutePatch,
  restoreFailedPick, routeRereadDue, type ModelGroup, type PermissionMode, type RouteView,
} from "./route";
import { memoryClient } from "./memory-client";
import { factText, loadMemory } from "../explorer/memory/memory-model.ts";
import { ProjectMemoryView } from "../explorer/memory/ProjectMemoryView";
import type { ChatState } from "./state";
import { createChatUiStore, type ChatPrefs, type ChatUiStore } from "./ui-state";
import { DockHeader } from "./DockHeader";
import { chatTotalLabel } from "./usage";
import type { ChatStore, SessionSummary } from "./store";
import type { FileRefs } from "./MessageView";
import { describeError, type CoreTransport } from "./transport";
import { isDeclined, isPendingCorrupt, PENDING_CORRUPT_NOTICE } from "./tauri-store";
import { claimSession, sessionVisible } from "./surface-sessions";
import { coreStatusStore } from "../shell/runtime";
import { allowedModes, chatBlockReason, permissionsFromMe } from "../shell/permissions";
import { projectIdFor } from "../docgen/docs-api";
import { projectsFromMe } from "../settings/team-projects-model";

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
  /**
   * Host-signed Bypass approval (bypass.ts). Absent (plain browser, no host bridge) = Bypass stays refused. The same gate
   * is the controller's `bypass` dep, so the token the dialog returns reaches only that chat's next turn.
   */
  bypass?: BypassGate;
  /** The open project folder (named in the dialog's summary). */
  projectRoot?: () => string | null;
  /** A compact summary of the project graph, or null when there is no graph. */
  graphSummary?: () => Promise<string | null>;
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
  /**
   * Chat UI choices shared with another screen (open chat, picker choices, permission, session-list revision). The Chat
   * section and the Explorer dock pass the same store; absent = this screen keeps its own.
   */
  shared?: ChatUiStore;
  /** This chat surface is on screen; window shortcuts bind only then. */
  active?: boolean;
  /** Docked beside the editor (Explorer): no session column, a compact "Code Assistant" header with chat history and New chat. */
  dock?: boolean;
  /** Dock only: hides the dock (the header shows the button when this is given). */
  onCollapse?: () => void;
  /** Which surface owns this chat list; each dock sees only the chats it created. */
  surface?: string;
}

const SESSION_PAGE = 100;

export function ChatScreen({ controller, store, core, host, initialSessionId = null, approvals, banner, noProject = false, shared, active = false, dock = false, onCollapse, surface = "chat" }: ChatScreenProps) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [remoteId, setRemoteId] = useState<string | null>(remoteProjectId);
  useEffect(() => subscribeRemoteProject(() => setRemoteId(remoteProjectId())), []);
  const [projectMemoryOpen, setProjectMemoryOpen] = useState(false);
  const memoryCore = useMemo(() => memoryClient(core), [core]);
  const memoryChip = useRef<HTMLButtonElement>(null);
  // Closing the viewer hands focus back to the chip that opened it.
  const closeProjectMemory = useCallback(() => { setProjectMemoryOpen(false); memoryChip.current?.focus(); }, []);
  // Errors the user caused or can ignore are not alarms: a declined confirm is silent, bookkeeping is an info notice.
  const reportStoreError = useCallback((e: unknown) => {
    if (isDeclined(e)) return;
    if (isPendingCorrupt(e)) { setNotice(PENDING_CORRUPT_NOTICE); return; }
    setListError(describeError(e).message);
  }, []);
  // One store for the open chat, picker choices and permission: shared with the other chat surface when given.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const ui = useMemo(() => shared ?? createChatUiStore(initialSessionId), [shared]);
  const uiState = useSyncExternalStore(ui.subscribe, ui.getSnapshot, ui.getSnapshot);
  const { activeId, prefs, permission } = uiState;
  const { setActiveId, setPrefs, setPermission } = ui;
  const skipRev = useRef<number | null>(null);
  const bumpSessions = useCallback(() => { ui.bumpSessions(); skipRev.current = ui.getSnapshot().sessionsRev; }, [ui]);
  const [listedGroups, setListedGroups] = useState<ModelGroup[]>([]);
  // The ids the user added ("Add model…"), kept per connection in this browser and joined onto the listed groups.
  const [userModels, setUserModels] = useState<UserModels>(loadUserModels);
  const groups = useMemo(() => withUserModels(listedGroups, userModels), [listedGroups, userModels]);
  const [modelNotice, setModelNotice] = useState<string | null>(null);
  const [groupsLoaded, setGroupsLoaded] = useState(false);
  const [toolsEnabled, setToolsEnabled] = useState(false);
  // The effort pick is one app-wide choice (the Mac's chat.effort), remembered across launches.
  const effortPick = useSyncExternalStore(effortStore.subscribe, effortStore.get, effortStore.get);
  const [route, setRoute] = useState<RouteView | null>(null);
  // Plan H1.2: the action classes the core says this member may use; null = unknown (an older core), hide nothing.
  // ADR 0022: when a project is open, the PROJECT grant's permissions replace the team ones, so a project
  // viewer sees Ask only even if they are an engineer elsewhere.
  const [perms, setPerms] = useState<ReadonlySet<string> | null>(null);
  const openProjectRoot = host.projectRoot?.() ?? null;
  // A supervised core restart invalidates running-turn state and provider/model caches: follow its restart counter.
  const coreRestarts = useSyncExternalStore(coreStatusStore.subscribe, () => coreStatusStore.getSnapshot().status?.restarts ?? 0, () => 0);
  const plans = useMemo(() => new PlanController(host.compose?.project ?? null), [host.compose?.project]);
  const [refineNonce, setRefineNonce] = useState(0);
  /** Local context pack: put the facts the core already remembers into the draft instead of making the model re-read files. */
  const addMemoryToDraft = useCallback(async () => {
    const chatId = activeId;
    if (!chatId) return;
    try {
      const m = await loadMemory(memoryCore, { repos: [], workspaceRoot: host.projectRoot?.() ?? null, sessionId: chatId });
      const facts = [...m.session, ...(m.project?.facts ?? [])].map(factText).filter(Boolean).slice(0, 40);
      const graph = host.graphSummary ? await host.graphSummary().catch(() => null) : null;
      if (facts.length === 0 && !graph) { setNotice("No project or session memory yet."); return; }
      const marker = "Use this local project context.";
      const block = `${marker} Do not ask me to repeat it.\n\n${graph ? `${graph}\n\n` : ""}${facts.map((f) => `- ${f}`).join("\n")}`.slice(0, 4000);
      const current = controller.getView(chatId).draft;
      // Replacing an earlier pack keeps this idempotent: clicking twice must not append the same facts again.
      const base = current.includes(marker) ? current.slice(0, current.indexOf(marker)).trimEnd() : current.trim();
      controller.setView(chatId, { draft: base ? `${base}\n\n${block}` : block });
      setRefineNonce((n) => n + 1);
      setMemoryOpen(false);
    } catch { setNotice("Project memory could not be read."); }
  }, [activeId, controller, host, memoryCore]);
  useControllerVersion(controller); // re-render when any chat's busy flag changes

  // Sessions: first page now, more on demand.
  const sessionsRev = uiState.sessionsRev;
  useEffect(() => {
    if (skipRev.current === sessionsRev) return undefined; // our own change: the list is already up to date here
    const ac = new AbortController();
    store.listSessions({ limit: SESSION_PAGE, offset: 0 }, ac.signal)
      .then((list) => setSessions(list.filter((x) => sessionVisible(surface, x.id))))
      .catch((e) => { if (!ac.signal.aborted) setListError(describeError(e).message); });
    return () => ac.abort();
  }, [store, sessionsRev, coreRestarts, surface]);

  // No session column: open the most recent chat when none is open yet, as the Mac does.
  useEffect(() => {
    if (!activeId && sessions.length > 0) setActiveId(sessions[0]!.id);
  }, [activeId, sessions, setActiveId]);

  // Graph/memory "Ask in Chat": put the prepared prompt in this chat's composer. The event is sticky, so it
  // survives the section mount that happens after the sender's goto-section.
  useEffect(() => {
    if (!activeId) return undefined;
    const take = (ev: { prompt: string } | null) => {
      if (!ev) return;
      controller.setView(activeId, { draft: ev.prompt });
      setRefineNonce((n) => n + 1);
    };
    take(shellBus.takePending("ask-chat"));
    return shellBus.subscribe("ask-chat", take);
  }, [activeId, controller]);

  // Model list once per screen and after every core restart.
  useEffect(() => {
    const ac = new AbortController();
    loadModelGroups(core, ac.signal).then((r) => { setListedGroups(r.groups); setToolsEnabled(r.toolsEnabled); setGroupsLoaded(true); }).catch(() => undefined);
    return () => ac.abort();
  }, [core, coreRestarts]);

  // The caller's permitted action classes, once per screen and after every core restart (plan H1.2).
  useEffect(() => {
    const ac = new AbortController();
    core.json<unknown>("GET", "/auth/me", undefined, ac.signal)
      .then(async (body) => {
        const remote = remoteProjectId();
        if (remote || openProjectRoot) {
          const projectId = remote ?? await projectIdFor(openProjectRoot!);
          if (ac.signal.aborted) return; // unmounted or another core restart superseded this read
          const project = projectsFromMe(body)?.find((p) => p.id === projectId);
          if (project) { setPerms(new Set(project.permissions)); return; }
        }
        setPerms(permissionsFromMe(body));
      })
      .catch(() => setPerms(null));
    return () => ac.abort();
  }, [core, coreRestarts, openProjectRoot, remoteId]);

  // A restarted core may have lost the live stream: pick up a turn that is still running.
  useEffect(() => {
    if (coreRestarts <= 0) return undefined;
    const ac = new AbortController();
    void controller.reattachRunning(ac.signal);
    return () => ac.abort();
  }, [controller, coreRestarts]);

  // Opening a chat: history, route (cap + pinned model), "running on the core" hint.
  useEffect(() => {
    if (!activeId) return;
    const ac = new AbortController();
    void controller.open(activeId, ac.signal);
    void controller.refreshRemoteBusy(ac.signal);
    getRoute(core, activeId, ac.signal).then(setRoute).catch(() => setRoute(null));
    return () => ac.abort();
  }, [activeId, controller, core, coreRestarts]);

  const state = useChatState(controller, activeId ?? "");
  useEffect(() => {
    chatApprovalStore.set(state.pendingApprovals.length);
    return () => chatApprovalStore.set(0);
  }, [state.pendingApprovals.length]);
  useEffect(() => {
    const last = [...state.messages].reverse().find((m) => m.role === "assistant");
    if (!last || last.role !== "assistant") return;
    const text = last.parts.map((p) => (p.kind === "text" ? p.sealed.join("") + p.open : "")).join("").trim();
    if (text) chatOutputStore.set({ title: "Latest chat reply", text: text.slice(0, 80_000), at: Date.now() });
  }, [state.messages]);
  const current: ChatPrefs = (activeId && prefs[activeId]) || { mode: pickerModeAfterSessionChange(), provider: null, model: null };
  const setCurrent = (patch: Partial<ChatPrefs>) => { if (activeId) setPrefs((p) => ({ ...p, [activeId]: { ...current, ...patch } })); };
  // A chat with no explicit model starts on the mode's default: cheap for Ask/Document/Review, strong for
  // Plan/Execute. A saved pick (or a pinned route) always wins.
  useEffect(() => {
    if (!activeId || !groupsLoaded || current.provider || current.model || route?.pinned) return;
    const pick = defaultModelForMode(groups, current.mode);
    if (pick) setCurrent({ provider: pick.provider, model: pick.model });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, groupsLoaded, groups, current.mode, current.provider, current.model, route?.pinned]);

  // A viewer has exactly one permitted mode (Ask): the picker never shows Auto and the chat runs as Ask.
  const modeOptions = useMemo(() => allowedModes(perms, MODES), [perms]);
  useEffect(() => {
    if (activeId && modeOptions.length === 1 && current.mode !== modeOptions[0]!.id) setCurrent({ mode: "ask" });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, modeOptions]);

  // Auto follows the server's resolved mode; a hand-picked mode never moves.
  useEffect(() => {
    if (!activeId || !state.resolvedMode) return;
    const follow = pickerMode(current.mode, state.resolvedMode);
    if (follow) setPrefs((p) => ({ ...p, [activeId]: { ...current, mode: follow } }));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.resolvedMode, activeId]);

  // The route's PUT, with a refused id dropped from the user's list and the core's own message shown (the pick itself is
  // put back by the caller's catch). The other route writes go through it unchanged.
  // Only a model write gets the notice: the cap chip shows its own errors.
  const putRoute = (c: CoreTransport, id: string, patch: RoutePatch) => putRouteWire(c, id, patch).catch((e: unknown) => {
    if (patch.model === undefined) throw e;
    const next = afterRefusedPin(listedGroups, userModels, patch, e);
    if (next !== userModels) { setUserModels(next); saveUserModels(next); }
    setModelNotice(describeError(e).message);
    throw e;
  });
  // A pick sets the composer's model and pins the route; "Default" only unpins a pinned route (modelPickPlan).
  function pickModel(provider: string, model: string) {
    const chat = activeId;
    if (!chat) return;
    const plan = modelPickPlan(route, provider, model);
    setModelNotice(null);
    if (plan.composer) setCurrent({ provider: plan.composer.provider || null, model: plan.composer.model || null });
    // A refused pin puts the picker back to the previous choice, so it never shows a model the route does not hold.
    const prev = { provider: current.provider, model: current.model };
    const restore = () => setPrefs((p) => restoreFailedPick(p, chat, { provider, model }, prev));
    if (plan.route === "pin") putRoute(core, chat, { provider, model }).then(setRoute).catch(restore);
    else if (plan.route === "unpin") putRoute(core, chat, { provider: "", model: "" }).then(setRoute).catch(() => undefined);
  }
  function addModel(groupId: string, id: string) {
    const next = addUserModel(userModels, groupId, id);
    setUserModels(next);
    saveUserModels(next);
    setModelNotice(null);
    const g = groups.find((x) => x.id === groupId);
    if (g?.provider) pickModel(g.provider, id);
  }
  function removeModel(groupId: string, id: string) {
    const next = forgetUserModel(userModels, groupId, id);
    setUserModels(next);
    saveUserModels(next);
    if (current.model === id) setCurrent({ provider: null, model: null });
  }

  const newChat = useCallback(async () => {
    try {
      const s = await store.createSession({ projectId: remoteProjectId() ?? undefined }); claimSession(surface, s.id);
      setSessions((cur) => [s, ...cur]);
      setActiveId(s.id);
      bumpSessions();
    } catch (e) { reportStoreError(e); }
  }, [store, reportStoreError, bumpSessions]);

  /** Start a new chat with a short local recap of this one: no model call and much less context than re-sending it. */
  const continueWithRecap = useCallback(async () => {
    const lines: string[] = [];
    for (const m of state.messages.slice(-6)) {
      const text = m.role === "user" ? m.text : m.parts.map((p) => (p.kind === "text" ? p.sealed.join("") + p.open : "")).join("");
      if (text.trim()) lines.push(`${m.role === "user" ? "User" : "Assistant"}: ${text.trim().slice(0, 900)}`);
    }
    const recap = `Context from the previous chat (local recap; do not repeat it):\n\n${lines.join("\n\n")}`.slice(0, 4000);
    try {
      const s = await store.createSession({ projectId: remoteProjectId() ?? undefined });
      claimSession(surface, s.id);
      setSessions((cur) => [s, ...cur]);
      setActiveId(s.id);
      controller.setView(s.id, { draft: recap });
      bumpSessions();
    } catch (e) { reportStoreError(e); }
  }, [state.messages, store, controller, bumpSessions, reportStoreError]);
  const busy = state.phase === "streaming" || state.phase === "aborting";
  const persistFailure = controller.getPersistFailure();
  // The chat whose plan card started the current plan run (the Mac's PlanExecutionTracker); a new ordinary message ends it.
  const [planRunChat, setPlanRunChat] = useState<string | null>(null);
  // A turn ended: re-read the route so a pending model switch (and the meter) reflect what the core applied.
  const wasBusy = useRef(false);
  useEffect(() => {
    const due = routeRereadDue(wasBusy.current, busy, activeId, route?.enabled);
    wasBusy.current = busy;
    if (!due || !activeId) return undefined;
    const ac = new AbortController();
    getRoute(core, activeId, ac.signal).then(setRoute).catch(() => undefined);
    return () => ac.abort();
  }, [busy, activeId, core, route?.enabled]);
  const history = useMemo(() => state.messages.filter((m) => m.role === "user").map((m) => (m as { text: string }).text).slice(-50), [state.messages]);
  // This chat's total, summed from the loaded replies' own counts (the Mac header's "N tokens").
  const sessionTotal = useMemo(() => chatTotalLabel(state.messages, state.hasMoreOlder), [state.messages, state.hasMoreOlder]);
  const turnCount = useMemo(() => state.messages.filter((m) => m.role === "user").length, [state.messages]);
  const busyIds = useMemo(() => new Set(controller.busyIds()), [controller, state]);
  // Re-read on every controller change (useControllerVersion above), so a background chat's approval shows up at once.
  const approvalIds = new Set(controller.approvalChatIds());
  const plain = plainChatReason(current.provider ?? "", current.model ?? "", current.mode, groups, toolsEnabled);
  const effortLevels = effortLevelsFor(groups, current.provider, current.model);
  const remoteBusy = activeId ? controller.isRemoteBusy(activeId) : false;
  const sendBlock = chatBlockReason(perms) ?? (isEndedChat(sessions.find((s) => s.id === activeId)) ? ENDED_REASON : noProject ? "Open a project to send messages." : null);
  const allowProviderTools = useCallback(async () => {
    setModelNotice(null);
    try {
      await enableProviderTools(core);
      const r = await loadModelGroups(core);
      setListedGroups(r.groups);
      setToolsEnabled(r.toolsEnabled);
    } catch (e) {
      setModelNotice(describeError(e).message);
    }
  }, [core]);

  const onLoadOlder = useCallback(() => (activeId ? controller.loadOlder(activeId) : Promise.resolve(0)), [activeId, controller]);
  const onFullHistoryNext = useCallback(() => { if (activeId) controller.fullHistoryNext(activeId); }, [activeId, controller]);
  const onScrollState = useCallback((scrollTop: number, stick: boolean) => { if (activeId) controller.setView(activeId, { scrollTop, stickToBottom: stick }); }, [activeId, controller]);

  // Bypass: a native host dialog per chat (a live grant is not asked again). A decline leaves the mode as it was,
  // silently; the core refusing a turn drops the picker to Ask with a plain notice and never retries on its own.
  const gate = host.bypass;
  const [, bumpGate] = useState(0);
  useEffect(() => gate?.subscribe(() => bumpGate((n) => n + 1)), [gate]);
  useEffect(() => {
    const handler = (id: string) => { setPermission("ask"); if (id === activeIdRef.current) setNotice(BYPASS_NEEDS_APPROVAL_NOTICE); };
    controller.onBypassRejected = handler;
    // Two chat surfaces can share a controller: only the one that still owns the hook clears it.
    return () => { if (controller.onBypassRejected === handler) controller.onBypassRejected = null; };
  }, [controller]);
  const activeIdRef = useRef<string | null>(activeId);
  activeIdRef.current = activeId;
  // Re-render when the believed grant runs out so the banner turns to "needs approval" on time.
  const msLeft = gate && activeId ? gate.msLeft(activeId) : null;
  useEffect(() => {
    if (msLeft === null) return;
    const t = setTimeout(() => bumpGate((n) => n + 1), msLeft + 50);
    return () => clearTimeout(t);
  }, [msLeft, activeId]);
  const bypassLive = !!(gate && activeId && gate.live(activeId));

  const changePermission = async (m: PermissionMode) => {
    if (m !== "bypass") {
      if (activeId) gate?.end(activeId);
      setPermission(m);
      return;
    }
    if (!gate) { setNotice("Bypass is only available in the desktop app."); return; } // fail closed without the host
    if (!activeId) return;
    const title = sessions.find((s) => s.id === activeId)?.title;
    const r = await gate.request(activeId, bypassSummary(title, host.projectRoot?.() ?? null));
    if (r === "approved") setPermission("bypass"); // declined: previous mode, no banner
  };

  const renameSession = (id: string, title: string) => {
    setSessions((cur) => cur.map((s) => (s.id === id ? { ...s, title } : s)));
    store.renameSession(id, title).then(bumpSessions).catch(reportStoreError);
  };
  const deleteSession = (id: string) => {
    store.deleteSession(id).then(() => { controller.forget(id); setSessions((cur) => cur.filter((s) => s.id !== id)); if (activeId === id) setActiveId(null); bumpSessions(); })
      .catch(reportStoreError);
  };
  return (
    <div className={dock ? "chat-screen chat-dock-mode" : "chat-screen"} data-dock={dock ? "" : undefined}>
      <section className="chat-main" aria-label={dock ? "Code Assistant" : "Chat"}>
        <DockHeader
          sessions={sessions} activeId={activeId} busyIds={busyIds} approvalIds={approvalIds} route={route} routeDisabled={busy || !activeId}
          meta={`${turnCount} turn${turnCount === 1 ? "" : "s"}${sessionTotal ? ` · ${sessionTotal.text}` : ""}`}
          onSelect={setActiveId} onNew={() => void newChat()} onCollapse={dock ? onCollapse : undefined}
          onRename={(title) => activeId && renameSession(activeId, title)}
          onDelete={() => activeId && deleteSession(activeId)} hasMessages={state.messages.length > 0}
          onSetLimit={async (limit) => { if (!activeId) return; const r = await putRoute(core, activeId, { tokenLimit: limit }); setRoute(r); return r; }}
        />
        {notice && <StatusBanner severity="info" message={notice} onDismiss={() => setNotice(null)} />}
        {state.budget && (budgetPercent(state.budget) >= 80 || state.budget.level === "warning" || state.budget.level === "exceeded") ? (
          <div className="chat-budget-warning" role="status">
            <span>Token budget {budgetPercent(state.budget)}% used · {state.budget.remaining.toLocaleString("en-US")} left. {state.budget.level === "exceeded" ? "This chat is at its limit." : "The next turn may stop at the limit."}</span>
            <button type="button" className="chat-btn" onClick={() => void newChat()}>Start a fresh chat</button>
          </div>
        ) : null}
        {listError && <StatusBanner severity="error" message={listError} onDismiss={() => setListError(null)} />}
        {persistFailure && <StatusBanner severity="error" message={persistFailure} onDismiss={() => controller.dismissPersistFailure()} />}
        <ModeBanner mode={permission} bypassLive={permission !== "bypass" || !gate || bypassLive} />
        {typeof banner === "function" ? banner(state) : banner}
        {!activeId ? (
          <div className="chat-empty"><p>Start a new chat.</p><button type="button" className="chat-btn chat-primary" onClick={() => void newChat()}>New chat</button></div>
        ) : (
          <>
            <div className="chat-badges"><HeaderBadges chatId={activeId} state={state} core={core} /></div>
            {projectMemoryOpen && (
              <div className="chat-memory-modal" onMouseDown={(e) => { if (e.target === e.currentTarget) closeProjectMemory(); }} onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); closeProjectMemory(); } }}>
                <div role="dialog" aria-modal="true" aria-label="Project memory" className="chat-memory-sheet">
                  <ProjectMemoryView client={memoryCore} repos={[]} workspaceRoot={host.projectRoot?.() ?? null} sessionId={activeId} onClose={closeProjectMemory} />
                </div>
              </div>
            )}
            {state.loadError && (
              <StatusBanner severity="error" message={<>{state.loadError.message} <button type="button" className="chat-link-btn" onClick={() => void controller.open(activeId)}>Retry</button></>} />
            )}
            {remoteBusy && <StatusBanner severity="info" message="A turn is running for this chat on the core. Its live output cannot be shown here yet." />}
            {state.phase === "error" && state.error && (
              <StatusBanner severity="error" message={<>{state.error.message}{state.error.retryable && <> <button type="button" className="chat-link-btn" onClick={() => controller.retry(activeId)}>Retry</button></>}</>} onDismiss={() => controller.clearError(activeId)} />
            )}
            <MessageList
              key={activeId} messages={state.messages} hasMoreOlder={state.hasMoreOlder} onLoadOlder={onLoadOlder}
              initialScrollTop={controller.getView(activeId).stickToBottom ? null : controller.getView(activeId).scrollTop}
              onScrollState={onScrollState} onOpenLink={host.openLink} onCopy={host.copy} files={host.files} onRetry={() => controller.retry(activeId)}
              onFullHistoryNext={onFullHistoryNext}
              empty={<EmptyChat onPick={(text) => { controller.setView(activeId, { draft: text }); setRefineNonce((n) => n + 1); }} />}
            />
            {showsPlanProgress(planRunChat, activeId, state.tasks) && <PlanProgress tasks={state.tasks} />}
            {state.tasks.length > 0 && (
              <ul className="chat-tasks" aria-label="Tasks">
                {state.tasks.map((t) => <li key={t.id} data-status={t.status}>{t.title} <span className="chat-muted">{t.status}</span></li>)}
              </ul>
            )}
            <PlanArea
              chatId={activeId} state={state} mode={current.mode} plans={plans} onOpenLink={host.openLink} onCopy={host.copy} onOpenFile={host.files?.open}
              onRefine={(title) => { controller.setView(activeId, { draft: refineSeed(title) }); setRefineNonce((n) => n + 1); }}
              onExecute={(turn) => {
                if (sendBlock) return; // the same reason the composer shows (no project, ended chat, no permission)
                setCurrent({ mode: "execute" });
                setPlanRunChat(activeId);
                controller.send(activeId, turn.text, { ...turn.options, model: current.model, provider: current.provider, permissionMode: permission, effort: turnEffort(effortPick, effortLevels) });
                touchSession(activeId);
              }}
            />
            {approvals?.(state)}
            {groupsLoaded && providerCannotChat(current.provider, groups) && <p className="chat-note" role="note">{PROVIDER_BLOCKED_NOTE}</p>}
            <div className="chat-notes">
              {modelNotice && <p className="chat-error" role="alert">{modelNotice}</p>}
              <ModelNotices kinds={modelNotices({ plainChat: plain, routerOn: route?.enabled, groups })} onAllowTools={() => void allowProviderTools()} />
              <PendingSwitchNote pending={route?.pending} />
            </div>
            <DraftComposer
              key={`${activeId}:${refineNonce}:${controller.getView(activeId).draftRev}`} controller={controller} id={activeId} active={active} collapsible
              compose={host.compose} models={groups} mode={current.mode} setMode={(mode) => setCurrent({ mode })} clearChat={() => void newChat()}
              setModel={(provider, model) => { setCurrent({ provider, model }); if (route?.enabled) putRoute(core, activeId, { provider, model }).then(setRoute).catch(() => undefined); }}
              busy={busy} aborting={state.phase === "aborting"} queue={state.queue} history={history}
              meter={<><BudgetMeter budget={state.budget} /><ContextMeter usage={state.context} onNewChat={() => void newChat()} onContinueWithRecap={state.messages.length > 0 ? () => void continueWithRecap() : undefined} /></>}
              controls={<>
                <ModePicker value={current.mode} resolved={state.resolvedMode} onChange={(mode) => setCurrent({ mode })} modes={modeOptions} />
                <ModelPicker groups={groups} provider={current.provider} model={current.model} plainChat={plain} route={route} onConnectProvider={() => shellBus.publish({ type: "goto-section", section: "settings", anchor: "providers" })}
                  onChange={pickModel} addGroup={addTargetGroup(groups, current.provider)} onAdd={addModel}
                  userModels={userModels} onRemove={removeModel} />
                <EffortPicker levels={effortLevels} value={effectiveEffort(effortPick, effortLevels)} onChange={effortStore.set} />
                <PermissionChip value={permission} onChange={(m) => void changePermission(m)} />
              </>}
              memory={<>
                <button ref={memoryChip} type="button" className="chat-icon-btn" aria-label={state.memory ? `Session memory ${state.memory.approxTokens} tokens` : "Memory"} aria-haspopup="dialog" aria-expanded={memoryOpen} title="Session memory" onClick={() => setMemoryOpen((v) => !v)}>
                  <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><rect x="3.5" y="3.5" width="9" height="9" rx="2" fill="none" stroke="currentColor" strokeWidth="1.3"/><path d="M6 1.5v2M10 1.5v2M6 12.5v2M10 12.5v2M1.5 6h2M1.5 10h2M12.5 6h2M12.5 10h2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>
                </button>
                {memoryOpen ? <div role="dialog" aria-label="Session memory" className="chat-popover chat-memory-popover" onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setMemoryOpen(false); } }}>{state.memory && <p className="chat-muted">{state.memory.sessionFacts.toLocaleString()} session fact{state.memory.sessionFacts === 1 ? "" : "s"} from {state.memory.chars.toLocaleString()} characters (~{state.memory.approxTokens.toLocaleString()} tokens) are injected into this chat.</p>}<button type="button" className="chat-btn" onClick={() => void addMemoryToDraft()}>Add memory to prompt</button>
                  <button type="button" className="chat-btn" onClick={() => { setMemoryOpen(false); setProjectMemoryOpen(true); }}>Project memory</button></div> : null}
              </>}
              onSend={(text, extra) => { if (!busy) setPlanRunChat(null); controller.send(activeId, text, { mode: current.mode || AUTO_MODE, model: current.model, provider: current.provider, permissionMode: permission, skills: extra?.skills, attachments: extra?.attachments, effort: turnEffort(effortPick, effortLevels) }); touchSession(activeId); }}
              onStop={() => controller.abort(activeId)} onDropQueued={(i) => controller.dropQueued(activeId, i)} onAttach={host.attachFiles} disabledReason={sendBlock}
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
function DraftComposer({ controller, id, compose, models, mode, setMode, setModel, clearChat, active, ...rest }: { controller: ChatController; id: string; compose?: ComposeServices; models: ModelGroup[]; mode: string; setMode: (id: string) => void; setModel: (provider: string, model: string) => void; clearChat: () => void; active: boolean } & Omit<ComposerProps, "draft" | "onDraft" | "extras" | "active">) {
  const [draft, setDraft] = useState(() => controller.getView(id).draft);
  const onDraft = (t: string) => { setDraft(t); controller.setView(id, { draft: t }); };
  const notice = <PlanSwitchNotice draft={draft} mode={mode} onSwitch={() => setMode("plan")} />;
  if (!compose) return <>{notice}<Composer {...rest} active={active} draft={draft} onDraft={onDraft} /></>;
  return <>{notice}<ComposerWithExtras {...rest} active={active} draft={draft} onDraft={onDraft} compose={compose} models={models} setMode={setMode} setModel={setModel} clearChat={clearChat} chatId={id} /></>;
}

/** The plan run's progress bar and counts, above the task list (the Mac's PlanExecutionCard header). */
function PlanProgress({ tasks }: { tasks: readonly { status: string }[] }) {
  const p = planProgress(tasks);
  return (
    <div className="chat-progress" role="status" aria-label="Plan progress">
      <progress value={p.done} max={p.total || 1} aria-label="Steps done" />
      <span className="chat-muted">Step {Math.max(p.current, 1)} of {p.total} · {p.done} done · {p.percent}%</span>
    </div>
  );
}
