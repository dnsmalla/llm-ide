import { Suspense, memo, useCallback, useEffect, useMemo, useReducer, useRef, useState, type ComponentType } from "react";
import { HomeIcon, StatusBanner, type ThemeId } from "@llmide/ui-kit";
import { AccountMenu, type AccountActions } from "./AccountMenu";
import { SectionToolbar } from "./Toolbar";
import { guessPlatform, decodePlatform, hasOverlayTitlebar, type Platform } from "./platform";
import { host as shellHost, invokeHost } from "./host";
import { SectionErrorBoundary } from "./ErrorBoundary";
import { CoreDownPanel, LoginPanel } from "./Panels";
import { StatusBar } from "./StatusBar";
import { computeGate, isInert, shouldMountSections } from "./gate";
import { MissingScreen, screenFor } from "./screens";
import { SECTIONS, devToolsEnabled, enableDevToolsForSession, initialNav, navReducer, sectionForShortcut, subscribeDevTools, type SectionDef, type SectionId } from "./sections";
import { landingFor, readHome } from "./landing";
import { core, coreStatusStore, trustGate } from "./runtime";
import { shellBus } from "./bus";
import { getTheme, setTheme as applyThemeChoice, subscribeTheme, showTheme } from "./theme";
import { safeText } from "./safe-text";
import { useActiveProject, useCoreSession, useCoreStatusView } from "./use-shell";

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
  const [platform, setPlatform] = useState<Platform>(() => guessPlatform(typeof navigator === "undefined" ? null : navigator));
  const hostAvailable = shellHost.isAvailable();
  const view = useCoreStatusView();
  const session = useCoreSession();
  const { project, loaded: projectLoaded, notice, dismissNotice } = useActiveProject();
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
  useEffect(() => {
    if (!projectLoaded) return;
    const to = landingFor({ prev: prevRoot.current, now: projectRoot, home: readHome(), overridden: overridden.current });
    prevRoot.current = projectRoot;
    if (to) dispatch({ type: "select", id: to });
  }, [projectLoaded, projectRoot]);

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
        else shellBus.publish({ type: "goto-section", section: "welcome", anchor: "guide" });
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
      openHelp: () => shellBus.publish({ type: "goto-section", section: "welcome", anchor: "guide" }),
      openPermissions: () => shellBus.publish({ type: "goto-section", section: "settings", anchor: "tool-permissions" }),
      signOut: () => core.logout(),
    }),
    [],
  );
  const onTheme = useCallback((id: ThemeId) => applyThemeChoice(id), []);
  // Settings > Appearance changes the theme through the same store (a launch override stays unpersisted until the user picks).
  useEffect(() => subscribeTheme(() => setTheme(getTheme())), []);

  const inert = isInert(gate);
  const overlay = hasOverlayTitlebar(platform, hostAvailable);
  return (
    <div className="sh-app" data-platform={platform} data-overlay-titlebar={overlay ? "" : undefined}>
      <a className="sh-skip" href="#shell-main" onClick={(e) => { e.preventDefault(); main.current?.focus(); }}>
        Skip to content
      </a>
      <header className="sh-titlebar" aria-label="LLM-IDE" data-tauri-drag-region>
        <button type="button" className="sh-tool sh-tool-home" aria-label="Home" aria-current={nav.active === "welcome" ? "page" : undefined} title="Home (Welcome)" onClick={() => dispatch({ type: "select", id: "welcome" })}>
          <HomeIcon />
        </button>
        <SectionToolbar active={nav.active} onSelect={onSelect} devTools={devToolsEnabled()} />
        <AccountMenu user={session.user} actions={account} mac={platform === "macos"} />
      </header>
      <div className="sh-body">
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
              <CoreDownPanel view={view} onRetry={() => void coreStatusStore.refreshNow()} />
            </div>
          )}
          {gate === "login" && (
            <div className="sh-overlay">
              <LoginPanel client={core} gate={trustGate} getStatus={() => coreStatusStore.getSnapshot().status} />
            </div>
          )}
        </main>
      </div>
      <StatusBar theme={theme} onTheme={onTheme} chatActive={nav.active === "chat"} />
    </div>
  );
}
