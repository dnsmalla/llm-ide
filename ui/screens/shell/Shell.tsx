import { Suspense, memo, useCallback, useEffect, useMemo, useReducer, useRef, useState, type ComponentType, type ReactNode } from "react";
import { HomeIcon, Icon, StatusBanner, type ThemeId } from "@llmide/ui-kit";
import { AccountMenu, type AccountActions } from "./AccountMenu";
import { forgetLocalSettings } from "./forget-device";
import { disconnectAll, readDisconnectPlan } from "./disconnect-all";
import { GuideDialog } from "../welcome/WelcomeScreen";
import { SectionToolbar } from "./Toolbar";
import { guessPlatform, decodePlatform, hasOverlayTitlebar, type Platform } from "./platform";
import { host as shellHost, invokeHost } from "./host";
import { SectionErrorBoundary } from "./ErrorBoundary";
import { CoreDownPanel, LoginPanel } from "./Panels";
import { CrashReportBanner } from "./CrashReportBanner";
import { LiveBanner } from "./LiveBanner";
import { syncLiveRecordingFromHost } from "./live-status";
import { dismissCrashNotice, loadCrashNotice, type CrashNotice } from "./crash-report";
import { StatusBar } from "./StatusBar";
import { ShellTerminalDock, ShellTerminalItem } from "./ShellTerminalDock";
import { chatApprovalStore } from "./chat-approvals";
import { menuAction } from "./menu-model";
import { useSyncExternalStore } from "react";
import { TERMINAL_BUILT } from "../explorer/terminal/shared";
import { readTerminalPrefs, writeTerminalPrefs } from "./terminal-prefs";
import { computeGate, isInert, shouldMountSections } from "./gate";
import { MissingScreen, screenFor } from "./screens";
import { SECTIONS, devToolsEnabled, enableDevToolsForSession, initialNav, navReducer, sectionForShortcut, subscribeDevTools, visibleSectionsFor, type SectionDef, type SectionId } from "./sections";
import { RemoteProjectBar } from "./RemoteProjectBar";
import { remoteBanner } from "./remote-status";
import { landingFor, readHome, selectHome } from "./landing";
import { activityStore, core, coreStatusStore, trustGate } from "./runtime";
import { shellBus } from "./bus";
import { inboxStore } from "./approvals/inbox-store";
import { decodeSyncStatus } from "../settings/sync-model.ts";
import { installNotifyBridge } from "./notify/bridge";
import { reportSection, setPushSender } from "./notify/notify";
import { getTheme, setTheme as applyThemeChoice, subscribeTheme, showTheme } from "./theme";
import { safeText } from "./safe-text";
import { useActiveProject, useCoreSession, useCoreStatusView, useFeatures } from "./use-shell";
import { featureStore } from "./feature-store";
import { disabledSectionText, isSectionEnabled, keepSectionNotice, type SectionNotice } from "./features";
import { quickSwitchRows } from "./menu-model";
import { coreApiWarning } from "./core-api-floor";
import { startSelfHealPump } from "./self-heal";
declare const __FEATURE_AUTO_TASKS__: boolean | undefined;

export interface ShellProps {
  /** Section to open (launch override); otherwise the shell lands on Welcome, or the home section once a project is open. */
  initialSection?: SectionId | null;
  /** Theme for this launch only (screenshot tooling); not persisted. */
  themeOverride?: ThemeId | null;
  /** The Spike route: Phase 0 bench/graph/terminal/editor views (lazy). Receives no props. */
  spike: ComponentType;
}

/** One mounted section: lazy screen inside its own error boundary and Suspense. */
const SectionSlot = memo(function SectionSlot({ def, active, projectRoot, inert, spike: Spike }: { def: SectionDef; active: boolean; projectRoot: string | null; inert: boolean; spike: ComponentType }) {
  const Screen = def.id === "spike" ? null : screenFor(def.id, def.label);
  return (
    <div className="sh-section" hidden={!active} inert={inert || !active} data-section={def.id}>
      <SectionErrorBoundary name={def.label}>
        <Suspense fallback={<div className="sh-panel" role="status" aria-busy="true"><span className="sh-spinner" aria-hidden="true" /><p className="sh-panel-text sh-muted">Loading {def.label}…</p></div>}>
          {def.id === "spike" ? <Spike /> : Screen ? <Screen active={active} projectRoot={projectRoot} /> : <MissingScreen name={def.label} />}
        </Suspense>
      </SectionErrorBoundary>
    </div>
  );
});

export function Shell({ initialSection, themeOverride, spike }: ShellProps) {
  const [nav, dispatch] = useReducer(navReducer, undefined, () => {
    if (initialSection === "spike") enableDevToolsForSession(); // a spike launch needs its own item
    return initialNav(initialSection ?? null);
  });
  // Developer tools (the Spike item) can be switched on while the app runs: re-render the nav when they change.
  const [, bumpDev] = useReducer((n: number) => n + 1, 0);
  useEffect(() => subscribeDevTools(() => bumpDev()), []);
  useEffect(() => { if (shellHost.isAvailable()) void syncLiveRecordingFromHost(); }, []);
  useEffect(() => {
    const onState = (e: Event) => { const d = (e as CustomEvent<{ open?: unknown; fits?: unknown }>).detail; setAssistant({ open: d?.open === true, fits: d?.fits !== false }); };
    globalThis.addEventListener?.("llmide:code-assistant-state", onState);
    return () => globalThis.removeEventListener?.("llmide:code-assistant-state", onState);
  }, []);
  const [assistant, setAssistant] = useState({ open: false, fits: true });
  const [theme, setTheme] = useState<ThemeId>(() => themeOverride ?? getTheme());
  const [terminalOpen, setTerminalOpen] = useState(() => readTerminalPrefs().open);
  const [platform, setPlatform] = useState<Platform>(() => guessPlatform(typeof navigator === "undefined" ? null : navigator));
  const hostAvailable = shellHost.isAvailable();
  const view = useCoreStatusView();
  const serverMode = coreStatusStore.getSnapshot().status?.mode;
  const modeKnown = serverMode === "local" || serverMode === "remote";
  const remoteMode = serverMode === "remote";
  // Until the first status poll the mode is unknown: render no section rather than briefly mounting local ones.
  const visibleSections = modeKnown ? visibleSectionsFor(remoteMode ? "remote" : "local") : [];
  // Next-launch crash notice (Mac CrashReportBanner): read once; Dismiss deletes the host's records.
  const [crash, setCrash] = useState<CrashNotice | null>(null);
  useEffect(() => {
    let live = true;
    void loadCrashNotice().then((n) => { if (live) setCrash(n); });
    return () => { live = false; };
  }, []);
  const dismissCrash = useCallback(() => {
    setCrash(null);
    void dismissCrashNotice().catch(() => undefined);
  }, []);
  const session = useCoreSession();
  const features = useFeatures();
  const { project, loaded: projectLoaded, notice, dismissNotice, recentAll, openRecent } = useActiveProject();
  // Notifications and the tray (desktop only): counts and sync state to the host, tray actions back to the shell.
  useEffect(() => {
    if (!shellHost.isAvailable()) return undefined;
    // Admitted kinds also go to the paired phone / web app (the core pushes the kind and count, never text).
    setPushSender((kind, count, key) => core.request("/host-api/push/send", { method: "POST", body: { kind, count, ...(key ? { key } : {}) } }));
    const off = installNotifyBridge({
      invoke: (cmd, args) => invokeHost<unknown>(cmd, args),
      listen: (event, cb) => import("@tauri-apps/api/event").then(({ listen }) => listen<unknown>(event, (ev) => cb(ev.payload))),
      chatApprovals: { getSnapshot: chatApprovalStore.get, subscribe: chatApprovalStore.subscribe },
      inbox: inboxStore, activity: activityStore, session: core,
      syncStatus: async () => decodeSyncStatus(await core.request("/kb/sync/status")),
      setSyncEnabled: async (on) => decodeSyncStatus(await core.request("/kb/sync/enabled", { method: "POST", body: { enabled: on } })),
      publish: (ev) => shellBus.publish(ev),
      openInbox: () => globalThis.dispatchEvent?.(new Event("llmide:open-inbox")),
    });
    return () => { setPushSender(null); off(); };
  }, []);
  useEffect(() => {
    if (!shellHost.isAvailable()) return undefined;
    // Self-Heal (debug builds only): the host answers enabled: false in a release build and the pump stops.
    return startSelfHealPump({
      take: () => invokeHost<unknown>("self_heal_take"),
      post: (incidents) => core.request("/kb/self-heal/incidents", { method: "POST", body: { incidents } }),
    });
  }, []);
  useEffect(() => { if (shellHost.isAvailable()) void reportSection(nav.active); }, [nav.active]);

  const [guideOpen, setGuideOpen] = useState(false);
  const [quickOpen, setQuickOpen] = useState(false);
  const [permissionsOpen, setPermissionsOpen] = useState(false);
  const everUsable = useRef(false);
  const main = useRef<HTMLElement>(null);

  const bypass = nav.active === "spike";
  const [sectionNotice, setSectionNotice] = useState<SectionNotice | null>(null);
  // Shown only on the section it was left on: navigating anywhere else clears it (declared before the effect that sets it).
  useEffect(() => setSectionNotice((n) => keepSectionNotice(n, nav.active)), [nav.active]);
  const [apiWarning, setApiWarning] = useState<string | null>(null);
  // Checked each time the core comes up (the public /health route; no token needed).
  useEffect(() => {
    if (view.down) return;
    let live = true;
    core.request<{ apiVersion?: unknown }>("/health", { auth: false }).then(
      (h) => { if (live) setApiWarning(coreApiWarning(h?.apiVersion)); },
      () => { if (live) setApiWarning(null); },
    );
    return () => { live = false; };
  }, [view.down]);
  const gate = computeGate({ view, signedIn: session.signedIn, everUsable: everUsable.current, bypass });
  if (gate === "open" && !bypass) everUsable.current = true;
  const mount = shouldMountSections(gate, everUsable.current) && (projectLoaded || bypass);

  useEffect(() => {
    coreStatusStore.start();
    return () => coreStatusStore.stop();
  }, []);
  // The feature profile decides which sections exist in this run; read it once (the host prefs are cheap).
  useEffect(() => {
    void featureStore.load();
  }, []);
  useEffect(() => showTheme(theme), [theme]);
  // The host says which OS it is (the traffic-light inset is macOS-only); the navigator guess above covers the first paint.
  useEffect(() => {
    if (!shellHost.isAvailable()) return undefined;
    let live = true;
    invokeHost<unknown>("host_platform").then((p) => live && setPlatform(decodePlatform(p)), () => undefined);
    return () => {
      live = false;
    };
  }, []);

  // Landing: Welcome without a project, the home section with one. First load, then project open/close.
  const prevRoot = useRef<string | null | undefined>(undefined);
  const projectRoot = project?.root ?? null;
  // Custom Auto Tasks schedule from the shell, so a cron still fires while another section is open (or Auto Tasks
  // was never opened this session). Loaded lazily and only for a usable Auto Tasks feature so an auto_tasks-off
  // build does not ship or run the scheduler. The built-in tasks keep their page scheduler for now.
  useEffect(() => {
    if (!projectRoot || !session.signedIn || gate !== "open" || !features.usable || !isSectionEnabled("autotasks", features.usable)) return undefined;
    if (typeof __FEATURE_AUTO_TASKS__ === "boolean" && !__FEATURE_AUTO_TASKS__) return undefined;
    let live = true;
    let stop: (() => void) | undefined;
    void import("../autotasks/native/schedule.ts").then((m) => {
      if (live) stop = m.startCustomTaskScheduler(projectRoot);
    });
    return () => { live = false; stop?.(); };
  }, [projectRoot, session.signedIn, gate, features.usable]);
  // The command-bus scheduler (docs/spec/command-bus.md section 9): not tied to a project or a feature, idle on a core
  // that does not see this UI as the desktop class.
  useEffect(() => {
    if (!session.signedIn || gate !== "open") return undefined;
    let live = true;
    let stop: (() => void) | undefined;
    void import("./approvals/scheduler").then((m) => {
      if (live) stop = m.startBusScheduler();
    });
    return () => { live = false; stop?.(); };
  }, [session.signedIn, gate]);
  const overridden = useRef(initialSection != null);
  // A home section whose feature is off (or was not compiled in) falls back to Library, as the Mac's resolveHome does.
  const usableHome = (): SectionId => selectHome(readHome(), features.usable);
  useEffect(() => {
    if (!projectLoaded) return;
    const home = usableHome();
    const to = landingFor({ prev: prevRoot.current, now: projectRoot, home, overridden: overridden.current });
    prevRoot.current = projectRoot;
    if (to) dispatch({ type: "select", id: to });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectLoaded, projectRoot, features.ready, features.usable]);

  // Features can only change at the next start, but a stored/compiled section can disappear after it loads (e.g. a
  // direct deep link into a feature that is off): land somewhere that exists instead of showing an empty shell.
  useEffect(() => {
    if (!features.ready) return;
    if (nav.active !== "welcome" && !isSectionEnabled(nav.active, features.usable)) {
      const label = SECTIONS.find((s) => s.id === nav.active)?.label ?? "This section";
      const home = usableHome();
      setSectionNotice({ text: disabledSectionText(nav.active, label, features.compiled), at: home });
      dispatch({ type: "select", id: home });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [features.ready, features.usable, nav.active]);

  // A restarted core invalidates nothing server-side; but a fatal one cannot refresh tokens: drop them.
  useEffect(() => {
    if (view.fatal) core.clearSession();
  }, [view.fatal]);

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      // The Mac's account-menu shortcuts: Cmd+, Settings, Cmd+/ Help & Guide.
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === "," || e.key === "/")) {
        e.preventDefault();
        if (e.key === ",") dispatch({ type: "select", id: "settings" });
        else setGuideOpen(true);
        return;
      }
      const id = sectionForShortcut(e);
      if (id) {
        e.preventDefault();
        dispatch({ type: "select", id });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Cross-screen requests: "open this file" lands in Explorer, "go to <section>" switches (the target screen
  // reads the sticky event itself once it is mounted, see bus.ts).
  useEffect(() => {
    const offOpen = shellBus.subscribe("open-file", () => dispatch({ type: "select", id: "explorer" }));
    const offGoto = shellBus.subscribe("goto-section", (ev) => dispatch({ type: "select", id: ev.section }));
    return () => {
      offOpen();
      offGoto();
    };
  }, []);

  const onSelect = useCallback((id: SectionId) => dispatch({ type: "select", id }), []);
  const account = useMemo<AccountActions>(
    () => ({
      openSettings: () => dispatch({ type: "select", id: "settings" }),
      openHelp: () => setGuideOpen(true),
      openPermissions: () => setPermissionsOpen(true),
      signOut: () => core.logout(),
      signOutAndForget: async () => { forgetLocalSettings(); await core.logout(); },
      disconnectPlan: () => readDisconnectPlan(core),
      disconnectAll: (plan, onStep) => disconnectAll(core, plan, () => core.logout(), { onStep }),
    }),
    [],
  );
  const onTheme = useCallback((id: ThemeId) => applyThemeChoice(id), []);
  // Settings > Appearance changes the theme through the same store (a launch override stays unpersisted until the user picks).
  useEffect(() => subscribeTheme(() => setTheme(getTheme())), []);
  // Native app-menu commands (Settings, Quick Switch, LLM Chat, Help) arrive as host events.
  useEffect(() => {
    if (!shellHost.isAvailable()) return undefined;
    let off: (() => void) | undefined;
    let gone = false;
    void import("@tauri-apps/api/event").then(({ listen }) => listen<string>("app-menu", (ev) => {
      if (ev.payload === "menu_help") { setGuideOpen(true); return; }
      if (ev.payload === "menu_quick_switch") { setQuickOpen(true); return; }
      const action = menuAction(ev.payload);
      if (action) shellBus.publish(action);
    })).then((un) => { if (gone) un(); else off = un; }).catch(() => undefined);
    return () => { gone = true; off?.(); };
  }, []);

  const inert = isInert(gate);
  const overlay = hasOverlayTitlebar(platform, hostAvailable);
  return (
    <div className="sh-app" data-platform={platform} data-overlay-titlebar={overlay ? "" : undefined}>
      <a className="sh-skip" href="#shell-main" onClick={(e) => { e.preventDefault(); main.current?.focus(); }}>
        Skip to content
      </a>
      <header className="sh-titlebar" aria-label="LLM-IDE" data-tauri-drag-region>
        <button
          type="button"
          className="sh-tool sh-tool-home"
          aria-label="Home"
          aria-current={nav.active === "welcome" || nav.active === (projectRoot ? usableHome() : "welcome") ? "page" : undefined}
          title={projectRoot ? "Home (your home section)" : "Home (Welcome)"}
          onClick={() => dispatch({ type: "select", id: projectRoot ? usableHome() : "welcome" })}
        >
          <HomeIcon />
        </button>
        <SectionToolbar active={nav.active} onSelect={onSelect} devTools={devToolsEnabled()} />
        {nav.active === "explorer" && (
          <button
            type="button"
            className="sh-icon-button sh-code-assistant"
            aria-label="Toggle Code Assistant"
            aria-controls="ex-chat-dock"
            aria-expanded={assistant.open}
            disabled={!assistant.fits}
            title={assistant.fits ? (assistant.open ? "Hide the Code Assistant" : "Show the Code Assistant") : "The window is too narrow for the Code Assistant"}
            onClick={() => globalThis.dispatchEvent?.(new Event("llmide:toggle-code-assistant"))}
          >
            <Icon name="panel-right" size={16} />
          </button>
        )}
        <ApprovalBadge onReveal={() => dispatch({ type: "select", id: "chat" })} />
        <AccountMenu user={session.user} actions={account} mac={platform === "macos"} />
      </header>
      <div className="sh-body">
        <div className="sh-section-column">
        <main id="shell-main" ref={main} tabIndex={-1} className="sh-main" aria-label={visibleSections.find((s) => s.id === nav.active)?.label}>
          {remoteMode ? <div className="sh-row"><RemoteProjectBar /></div> : null}
          {remoteMode && remoteBanner(view.down ? "offline" : "online", session.signedIn) ? <StatusBanner severity="warning" message={remoteBanner(view.down ? "offline" : "online", session.signedIn)!.title} /> : null}
          <LiveBanner activeSection={nav.active} onOpen={() => dispatch({ type: "select", id: "live" })} />
          {crash && <CrashReportBanner notice={crash} onDismiss={dismissCrash} />}
          {gate === "restarting" && <StatusBanner severity="warning" message={`${view.label}. Your screens are kept and will reconnect.`} />}
          {keepSectionNotice(sectionNotice, nav.active) && (
            <div className="sh-notice" role="status" data-testid="section-notice">
              <p>{safeText(sectionNotice!.text, 300)}</p>
              <button type="button" className="sh-button" onClick={() => setSectionNotice(null)}>Dismiss</button>
            </div>
          )}
          {notice && gate === "open" && (
            <div className="sh-notice" role="status" data-testid="project-notice">
              <p>{safeText(notice, 400)}</p>
              <button type="button" className="sh-button" onClick={dismissNotice}>Dismiss</button>
            </div>
          )}
          {mount &&
            visibleSections.filter((s) => nav.visited.includes(s.id)).map((def) => (
              <SectionSlot key={`${def.id}:${def.id === "spike" ? "" : (project?.root ?? "")}`} def={def} active={nav.active === def.id} projectRoot={project?.root ?? null} inert={inert} spike={spike} />
            ))}
          {gate === "core" && (
            <div className="sh-overlay">
              <CoreDownPanel
                view={view}
                onRetry={() => void coreStatusStore.refreshNow()}
                onStart={shellHost.isAvailable() ? () => { void invokeHost<unknown>("core_start").then(() => coreStatusStore.refreshNow()).catch(() => undefined); } : undefined}
              />
            </div>
          )}
          {gate === "login" && (
            <div className="sh-overlay">
              <LoginPanel client={core} gate={trustGate} getStatus={() => coreStatusStore.getSnapshot().status} />
            </div>
          )}
        </main>
        <ShellTerminalDock
          activeSection={nav.active}
          projectRoot={project?.root ?? null}
          projectName={project?.name ?? ""}
          open={terminalOpen}
          onToggle={(open) => { setTerminalOpen(open); writeTerminalPrefs({ open, height: readTerminalPrefs().height }); }}
        />
        </div>
      </div>
      {gate === "open" ? <StatusBar
        apiWarning={apiWarning}
        theme={theme}
        onTheme={onTheme}
        chatActive={nav.active === "chat"}
        terminalItem={<ShellTerminalItem activeSection={nav.active} built={TERMINAL_BUILT} onToggle={() => { const next = !terminalOpen; setTerminalOpen(next); writeTerminalPrefs({ open: next, height: readTerminalPrefs().height }); }} />}
      /> : null}
      {guideOpen ? <GuideDialog onClose={() => setGuideOpen(false)} /> : null}
      {permissionsOpen ? <div className="sh-modal" role="dialog" aria-modal="true" aria-labelledby="sh-permissions-title"><div className="sh-modal-card"><h2 id="sh-permissions-title" className="sh-panel-title">Permissions</h2><p className="sh-panel-text">Accessibility, Screen Recording and Microphone permissions belong to the Mac app’s live-capture engine. The desktop has no capture engine, so there is nothing to grant here.</p><div className="sh-form-actions"><button type="button" className="sh-button" onClick={() => setPermissionsOpen(false)}>Close</button></div></div></div> : null}
      {quickOpen ? <QuickSwitchDialog recent={recentAll.entries} activeRoot={project?.root ?? null} onOpen={(i) => { setQuickOpen(false); void openRecent(i); }} onClose={() => setQuickOpen(false)} /> : null}
    </div>
  );
}


function ApprovalBadge({ onReveal }: { onReveal: () => void }) {
  const count = useSyncExternalStore(chatApprovalStore.subscribe, chatApprovalStore.get, chatApprovalStore.get);
  if (count <= 0) return null;
  return (
    <button type="button" className="sh-approval-badge" aria-label={`${count} pending approval${count === 1 ? "" : "s"}. Open chat`} title="A tool is waiting for your approval in Chat" onClick={onReveal}>
      {count} approval{count === 1 ? "" : "s"}
    </button>
  );
}


function QuickSwitchDialog({ recent, activeRoot, onOpen, onClose }: { recent: readonly import("./host").RecentEntry[]; activeRoot: string | null; onOpen: (index: number) => void; onClose: () => void }): ReactNode {
  const [q, setQ] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); }; window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey); }, [onClose]);
  const shown = quickSwitchRows(recent, activeRoot, q).map(({ entry, index }) => ({ r: entry, index }));
  return (
    <div className="sh-modal" role="dialog" aria-modal="true" aria-labelledby="sh-quick-title">
      <div className="sh-modal-card">
        <h2 id="sh-quick-title" className="sh-panel-title">Quick Switch Project</h2>
        <input ref={input} className="sh-input" value={q} placeholder="Search projects…" onChange={(e) => setQ(e.target.value)} />
        <ul className="sh-quick-list">
          {shown.map(({ r }) => <li key={r.root}><button type="button" className="sh-button sh-quick-row" disabled={r.status !== "ok" || r.openIndex === null} onClick={() => { if (r.openIndex !== null) onOpen(r.openIndex); }}><span>{safeText(r.name, 80)}</span><span className="sh-muted">{safeText(r.root, 240)}</span></button></li>)}
          {shown.length === 0 ? <li className="sh-muted">No matching projects.</li> : null}
        </ul>
        <div className="sh-form-actions"><button type="button" className="sh-button" onClick={onClose}>Cancel</button></div>
      </div>
    </div>
  );
}
