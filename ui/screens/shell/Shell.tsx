import { Suspense, memo, useCallback, useEffect, useReducer, useRef, useState, type ComponentType, type KeyboardEvent, type ReactNode } from "react";
import { ChatIcon, EditorIcon, FolderIcon, GraphIcon, DocIcon, PuzzleIcon, BenchIcon, ChartIcon, SidebarIcon, HomeIcon, StatusBanner, type ThemeId } from "@llmide/ui-kit";
import { SectionErrorBoundary } from "./ErrorBoundary";
import { CoreDownPanel, LoginPanel } from "./Panels";
import { StatusBar } from "./StatusBar";
import { computeGate, isInert, shouldMountSections } from "./gate";
import { MissingScreen, screenFor } from "./screens";
import { SECTIONS, SELECTABLE, initialNav, navKeyTarget, navReducer, readStoredSection, sectionForShortcut, storeSection, type SectionDef, type SectionId } from "./sections";
import { core, coreStatusStore } from "./runtime";
import { readStoredTheme, showTheme, storeTheme } from "./theme";
import { useActiveProject, useCoreSession, useCoreStatusView } from "./use-shell";

const ICONS: Record<SectionId, ReactNode> = {
  chat: <ChatIcon />,
  explorer: <FolderIcon />,
  library: <DocIcon />,
  settings: <PuzzleIcon />,
  graph: <GraphIcon />,
  issues: <ChartIcon />,
  docgen: <EditorIcon />,
  autotasks: <HomeIcon />,
  spike: <BenchIcon />,
};

export interface ShellProps {
  /** Section to open (launch override); falls back to the last used one, then Chat. */
  initialSection?: SectionId | null;
  /** Theme for this launch only (screenshot tooling); not persisted. */
  themeOverride?: ThemeId | null;
  /** The Spike route: Phase 0 bench/graph/terminal/editor views (lazy). Receives no props. */
  spike: ComponentType;
}

const NavItem = memo(function NavItem({ def, active, index, onSelect, onKey }: { def: SectionDef; active: boolean; index: number; onSelect: (id: SectionId) => void; onKey: (e: KeyboardEvent<HTMLButtonElement>, index: number) => void }) {
  return (
    <li data-spike={def.id === "spike" ? "" : undefined}>
      <button
        type="button"
        className="sh-nav-item"
        data-nav-index={def.enabled ? index : undefined}
        aria-current={active ? "page" : undefined}
        aria-disabled={def.enabled ? undefined : true}
        title={def.note ? `${def.label}: ${def.note}` : def.shortcut ? `${def.label} (Ctrl/Cmd+${def.shortcut})` : def.label}
        tabIndex={def.enabled && active ? 0 : -1}
        onClick={() => def.enabled && onSelect(def.id)}
        onKeyDown={(e) => def.enabled && onKey(e, index)}
      >
        {ICONS[def.id]}
        <span className="sh-nav-label">{def.label}</span>
        {!def.enabled && <span className="sh-nav-soon">Soon</span>}
      </button>
    </li>
  );
});

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
  const [nav, dispatch] = useReducer(navReducer, undefined, () => initialNav(initialSection ?? readStoredSection()));
  const [theme, setTheme] = useState<ThemeId>(() => themeOverride ?? readStoredTheme());
  const [navOpen, setNavOpen] = useState(true);
  const view = useCoreStatusView();
  const session = useCoreSession();
  const { project, loaded: projectLoaded } = useActiveProject();
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
  useEffect(() => storeSection(nav.active), [nav.active]);

  // A restarted core invalidates nothing server-side; but a fatal one cannot refresh tokens: drop them.
  useEffect(() => {
    if (view.fatal) core.clearSession();
  }, [view.fatal]);

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      const id = sectionForShortcut(e);
      if (id) {
        e.preventDefault();
        dispatch({ type: "select", id });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const onSelect = useCallback((id: SectionId) => dispatch({ type: "select", id }), []);
  const onNavKey = useCallback((e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const target = navKeyTarget(e.key, index, SELECTABLE.length);
    if (target === null) return;
    e.preventDefault();
    const def = SELECTABLE[target];
    if (def) {
      dispatch({ type: "select", id: def.id });
      // Roving focus: move DOM focus to the newly current item after it renders.
      requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-nav-index="${target}"]`)?.focus());
    }
  }, []);
  const onTheme = useCallback((id: ThemeId) => {
    storeTheme(id);
    setTheme(id);
  }, []);

  const inert = isInert(gate);
  let selectableIndex = -1;
  return (
    <div className="sh-app">
      <a className="sh-skip" href="#shell-main" onClick={(e) => { e.preventDefault(); main.current?.focus(); }}>
        Skip to content
      </a>
      <header className="sh-titlebar" data-tauri-drag-region>
        <button type="button" className="sh-icon-button" aria-label={navOpen ? "Hide sidebar" : "Show sidebar"} aria-pressed={navOpen} onClick={() => setNavOpen((v) => !v)}>
          <SidebarIcon />
        </button>
        <span className="sh-title" data-tauri-drag-region>
          LLM-IDE{project ? ` · ${project.name}` : ""}
        </span>
      </header>
      <div className="sh-body">
        {navOpen && (
          <nav className="sh-nav" aria-label="Sections">
            <ul>
              {SECTIONS.map((def) => {
                if (def.enabled) selectableIndex++;
                return (
                  <NavItem key={def.id} def={def} active={nav.active === def.id} index={def.enabled ? selectableIndex : -1} onSelect={onSelect} onKey={onNavKey} />
                );
              })}
            </ul>
          </nav>
        )}
        <main id="shell-main" ref={main} tabIndex={-1} className="sh-main" aria-label={SECTIONS.find((s) => s.id === nav.active)?.label}>
          {gate === "restarting" && <StatusBanner severity="warning" message={`${view.label}. Your screens are kept and will reconnect.`} />}
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
              <LoginPanel client={core} />
            </div>
          )}
        </main>
      </div>
      <StatusBar theme={theme} onTheme={onTheme} />
    </div>
  );
}
