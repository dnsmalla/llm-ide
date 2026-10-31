// The Phase 0 spike views (graph, editor, terminal, chat replay, bench), kept reachable behind the
// shell's clearly-labelled "Spike" route until their real screens land. Loaded lazily by App.tsx, so
// monaco/sigma/xterm stay out of the startup bundle. Autobench behaviour is unchanged: the host's
// `autobench_mode` / `section_override` pick the tab and `all` / `ax` start the runner.
import { useEffect, useState, type ReactNode } from "react";
import { invokeHost } from "@llmide/screens/shell/host";
import { StatusBanner, GraphIcon, EditorIcon, TerminalIcon, ChatIcon, BenchIcon } from "@llmide/ui-kit";
import { GraphView } from "../views/GraphView";
import { EditorView } from "../views/EditorView";
import { TerminalView } from "../views/TerminalView";
import { ChatView } from "../views/ChatView";
import { BenchView } from "../views/BenchView";
import { ALL_STEPS, runSteps, setBenchNavigator } from "../bench/runner";

const TABS: ReadonlyArray<{ id: string; label: string; icon: ReactNode; View: () => ReactNode }> = [
  { id: "graph", label: "Code Graph", icon: <GraphIcon />, View: GraphView },
  { id: "editor", label: "Editor", icon: <EditorIcon />, View: EditorView },
  { id: "terminal", label: "Terminal", icon: <TerminalIcon />, View: TerminalView },
  { id: "chat", label: "Chat replay", icon: <ChatIcon />, View: ChatView },
  { id: "bench", label: "Bench", icon: <BenchIcon />, View: BenchView },
];

/**
 * Tab for this launch. `LLMIDE_POC_AUTOBENCH=editor|terminal|chat` opens that view (its bench needs it
 * mounted), `all` and `ax` open Bench (the runner moves through the tabs), other modes the Code Graph;
 * `LLMIDE_POC_SECTION` opens a named tab for screenshots; otherwise the Code Graph.
 */
async function launchTab(): Promise<string> {
  try {
    const mode = await invokeHost<string | null>("autobench_mode");
    if (mode === "all" || mode === "ax") return "bench";
    if (mode) return mode === "editor" || mode === "terminal" || mode === "chat" ? mode : "graph";
    const override = await invokeHost<string | null>("section_override");
    if (override && TABS.some((t) => t.id === override)) return override;
  } catch {
    // no host (plain vite dev): default tab
  }
  return "graph";
}

export default function SpikeHost() {
  // null until the launch tab is known, so no view mounts (and benches) first.
  const [active, setActive] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setBenchNavigator(setActive);
    void (async () => {
      const id = await launchTab();
      if (cancelled) return;
      setActive(id);
      const mode = await invokeHost<string | null>("autobench_mode").catch(() => null);
      if (cancelled) return;
      if (mode === "all") void runSteps(ALL_STEPS, true);
      else if (mode === "ax") void runSteps(["ax"], true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const View = TABS.find((t) => t.id === active)?.View ?? null;
  return (
    <div className="spike">
      <StatusBanner severity="info" message="Spike: Phase 0 measurement views. Developer tool, not part of the product." />
      <div className="spike-tabs" role="tablist" aria-label="Spike views">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={t.id === active} className="ui-toolbar-item" onClick={() => setActive(t.id)}>
            {t.icon}
            <span>{t.label}</span>
          </button>
        ))}
      </div>
      <div className="shell-content">{View ? <View /> : null}</div>
    </div>
  );
}
