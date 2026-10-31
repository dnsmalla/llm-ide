import { useEffect, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { GraphView } from "./views/GraphView";
import { EditorView } from "./views/EditorView";
import { TerminalView } from "./views/TerminalView";
import { ChatView } from "./views/ChatView";
import { BenchView } from "./views/BenchView";
import { ALL_STEPS, runSteps, setBenchNavigator } from "./bench/runner";
import { SectionChromeBar, LibrarySidebar, SelectItemEmpty, GraphIcon, EditorIcon, TerminalIcon, ChatIcon, BenchIcon, HomeIcon, SidebarIcon, DoubleChevronIcon } from "@llmide/ui-kit";
import { AppStatusBar } from "./design/AppStatusBar";
import { applyTheme, isThemeId, readStoredTheme, storeTheme, type ThemeId } from "./design/theme";
import { useCoreStatus } from "./design/useCoreStatus";

// Toolbar items. Names follow the Mac toolbar wording; the PoC has these five sections.
const TABS: ReadonlyArray<{ id: string; label: string; icon: ReactNode; View: (() => ReactNode) | null }> = [
  { id: "graph", label: "Code Graph", icon: <GraphIcon />, View: GraphView },
  { id: "editor", label: "Editor", icon: <EditorIcon />, View: EditorView },
  { id: "terminal", label: "Terminal", icon: <TerminalIcon />, View: TerminalView },
  { id: "chat", label: "Chat", icon: <ChatIcon />, View: ChatView },
  { id: "bench", label: "Bench", icon: <BenchIcon />, View: BenchView },
];

/**
 * Theme for this launch: `LLMIDE_POC_THEME` (screenshot tooling) wins over the
 * persisted choice. The env lookup is a Rust command, so the webview never needs
 * env access; outside Tauri the command is absent and the stored choice is used.
 */
async function launchTheme(): Promise<ThemeId | null> {
  try {
    const override = await invoke<string | null>("theme_override");
    if (isThemeId(override)) return override;
  } catch {
    // not running under Tauri (plain vite dev): no override
  }
  return null;
}

/**
 * Section for this launch. `LLMIDE_POC_AUTOBENCH=editor` opens the Editor, `=terminal`
 * the Terminal and `=chat` the Chat (their benches need them mounted); `all` and `ax` open the
 * Bench tab, which the runner moves through the sections; other autobench modes open the Code
 * Graph; `LLMIDE_POC_SECTION` opens a named section for screenshots; otherwise the Code Graph.
 */
async function launchSection(): Promise<string> {
  try {
    const mode = await invoke<string | null>("autobench_mode");
    // An autobench mode decides the section alone; LLMIDE_POC_SECTION is ignored.
    if (mode === "all" || mode === "ax") return "bench";
    if (mode) return mode === "editor" || mode === "terminal" || mode === "chat" ? mode : "graph";
    const override = await invoke<string | null>("section_override");
    if (override && TABS.some((t) => t.id === override)) return override;
  } catch {
    // not running under Tauri (plain vite dev): default section
  }
  return "graph";
}

export function App() {
  // null until the launch section is known, so no view mounts (and benches) first.
  const [active, setActive] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [theme, setTheme] = useState<ThemeId>(() => readStoredTheme());
  const { status, pollError } = useCoreStatus();

  // Apply the env overrides once at launch; theme changes persist from the status bar.
  // Autobench `all` / `ax` start the runner after the launch section is set, so the runner's
  // first tab switch is not overwritten by the launch section.
  useEffect(() => {
    let cancelled = false;
    setBenchNavigator(setActive);
    void (async () => {
      const id = await launchSection();
      if (cancelled) return;
      setActive(id);
      const mode = await invoke<string | null>("autobench_mode").catch(() => null);
      if (cancelled) return;
      if (mode === "all") void runSteps(ALL_STEPS, true);
      else if (mode === "ax") void runSteps(["ax"], true);
    })();
    void launchTheme().then((id) => {
      if (id && !cancelled) setTheme(id);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Only the user's menu choice persists; a LLMIDE_POC_THEME override applies
  // for this launch alone.
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const chooseTheme = (id: ThemeId) => {
    storeTheme(id);
    setTheme(id);
  };

  const current = TABS.find((t) => t.id === active);
  const View = current?.View ?? null;

  return (
    <div className="shell">
      <header className="ui-toolbar" data-tauri-drag-region>
        <div className="ui-toolbar-brand" data-tauri-drag-region>
          <span className="ui-toolbar-home" aria-hidden="true">
            <HomeIcon />
          </span>
          <span className="ui-toolbar-title" data-tauri-drag-region>
            LLM-IDE
          </span>
        </div>
        <nav className="ui-toolbar-tabs" role="tablist" aria-label="Sections">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={t.id === active}
              className="ui-toolbar-item"
              onClick={() => setActive(t.id)}
            >
              {t.icon}
              <span>{t.label}</span>
            </button>
          ))}
        </nav>
        <span className="ui-toolbar-overflow" aria-hidden="true">
          <DoubleChevronIcon />
        </span>
      </header>
      <div className="shell-secondary">
        <SectionChromeBar
          toggles={[
            {
              id: "sidebar",
              icon: <SidebarIcon />,
              isOn: sidebarOpen,
              helpOn: "Hide Library",
              helpOff: "Show Library",
              onToggle: () => setSidebarOpen((v) => !v),
            },
          ]}
        />
      </div>
      <div className="shell-body">
        {sidebarOpen && <LibrarySidebar />}
        <main className="shell-content">{active === null ? null : View ? <View /> : <SelectItemEmpty />}</main>
      </div>
      <AppStatusBar
        status={status}
        pollError={pollError}
        theme={theme}
        onTheme={chooseTheme}
        projectName="LLM"
      />
    </div>
  );
}
