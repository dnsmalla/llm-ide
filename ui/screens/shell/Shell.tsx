import { Suspense, memo, useCallback, useEffect, useMemo, useReducer, useRef, useState, type ComponentType, type ReactNode } from "react";
import { HomeIcon, StatusBanner, type ThemeId } from "@llmide/ui-kit";
import { AccountMenu, type AccountActions } from "./AccountMenu";
import { forgetLocalSettings } from "./forget-device";
import { GuideDialog } from "../welcome/WelcomeScreen";
import { SectionToolbar } from "./Toolbar";
import { guessPlatform, decodePlatform, hasOverlayTitlebar, type Platform } from "./platform";
import { host as shellHost, invokeHost } from "./host";
import { SectionErrorBoundary } from "./ErrorBoundary";
import { CoreDownPanel, LoginPanel } from "./Panels";
import { StatusBar } from "./StatusBar";
import { ShellTerminalDock, ShellTerminalItem } from "./ShellTerminalDock";
import { chatApprovalStore } from "./chat-approvals";
import { menuAction } from "./menu-model";
import { useSyncExternalStore } from "react";
import { TERMINAL_BUILT } from "../explorer/terminal/shared";
import { readTerminalPrefs, writeTerminalPrefs } from "./terminal-prefs";
import { computeGate, isInert, shouldMountSections } from "./gate";
import { MissingScreen, screenFor } from "./screens";
import { SECTIONS, devToolsEnabled, enableDevToolsForSession, initialNav, navReducer, sectionForShortcut, subscribeDevTools, type SectionDef, type SectionId } from "./sections";
import { landingFor, readHome, selectHome } from "./landing";
import { core, coreStatusStore, trustGate } from "./runtime";
import { shellBus } from "./bus";
import { getTheme, setTheme as applyThemeChoice, subscribeTheme, showTheme } from "./theme";
import { safeText } from "./safe-text";
import { useActiveProject, useCoreSession, useCoreStatusView, useFeatures } from "./use-shell";
import { featureStore } from "./feature-store";
import { isSectionEnabled } from "./features";

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
  const [theme, setTheme] = useState<ThemeId>(() => themeOverride ?? getTheme());
  const [terminalOpen, setTerminalOpen] = useState(() => readTerminalPrefs().open);
  const [platform, setPlatform] = useState<Platform>(() => guessPlatform(typeof navigator === "undefined" ? null : navigator));
  const hostAvailable = shellHost.isAvailable();
  const view = useCoreStatusView();
  const session = useCoreSession();
  const features = useFeatures();
  const { project, loaded: projectLoaded, notice, dismissNotice, recentAll, openRecent } = useActiveProject();
  const [guideOpen, setGuideOpen] = useState(false);
  const [quickOpen, setQuickOpen] = useState(false);
  const [permissionsOpen, setPermissionsOpen] = useState(false);
  const everUsable = useRef(false);
  const main = useRef<HTMLElement>(null);

  const bypass = nav.active === "spike";
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
      dispatch({ type: "select", id: usableHome() });
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
        <ApprovalBadge onReveal={() => dispatch({ type: "select", id: "chat" })} />
        <AccountMenu user={session.user} actions={account} mac={platform === "macos"} />
      </header>
      <div className="sh-body">
        <div className="sh-section-column">
        <main id="shell-main" ref={main} tabIndex={-1} className="sh-main" aria-label={SECTIONS.find((s) => s.id === nav.active)?.label}>
          {gate === "restarting" && <StatusBanner severity="warning" message={`${view.label}. Your screens are kept and will reconnect.`} />}
          {notice && gate === "open" && (
            <div className="sh-notice" role="status" data-testid="project-notice">
              <p>{safeText(notice, 400)}</p>
              <button type="button" className="sh-button" onClick={dismissNotice}>Dismiss</button>
            </div>
          )}
          {mount &&
            SECTIONS.filter((s) => nav.visited.includes(s.id)).map((def) => (
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
        theme={theme}
        onTheme={onTheme}
        chatActive={nav.active === "chat"}
        terminalItem={<ShellTerminalItem activeSection={nav.active} built={TERMINAL_BUILT} onToggle={() => { const next = !terminalOpen; setTerminalOpen(next); writeTerminalPrefs({ open: next, height: readTerminalPrefs().height }); }} />}
      /> : null}
      {guideOpen ? <GuideDialog onClose={() => setGuideOpen(false)} /> : null}
      {permissionsOpen ? <div className="sh-modal" role="dialog" aria-modal="true" aria-labelledby="sh-permissions-title"><div className="sh-modal-card"><h2 id="sh-permissions-title" className="sh-panel-title">Permissions</h2><p className="sh-panel-text">Accessibility, Screen Recording and Microphone permissions belong to the Mac app’s live-capture engine. The desktop has no capture engine, so there is nothing to grant here.</p><div className="sh-form-actions"><button type="button" className="sh-button" onClick={() => setPermissionsOpen(false)}>Close</button></div></div></div> : null}
      {quickOpen ? <QuickSwitchDialog recent={recentAll.entries} onOpen={(i) => { setQuickOpen(false); void openRecent(i); }} onClose={() => setQuickOpen(false)} /> : null}
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


function QuickSwitchDialog({ recent, onOpen, onClose }: { recent: readonly import("./host").RecentEntry[]; onOpen: (index: number) => void; onClose: () => void }): ReactNode {
  const [q, setQ] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); }; window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey); }, [onClose]);
  const shown = recent.map((r, index) => ({ r, index })).filter(({ r }) => !q || `${r.name} ${r.root}`.toLowerCase().includes(q.toLowerCase()));
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
