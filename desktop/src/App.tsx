import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { GraphView } from "./views/GraphView";
import { EditorView } from "./views/EditorView";
import { TerminalView } from "./views/TerminalView";
import { ChatView } from "./views/ChatView";
import { BenchView } from "./views/BenchView";

const TABS = [
  { id: "graph", label: "Graph", View: GraphView },
  { id: "editor", label: "Editor", View: EditorView },
  { id: "terminal", label: "Terminal", View: TerminalView },
  { id: "chat", label: "Chat", View: ChatView },
  { id: "bench", label: "Bench", View: BenchView },
] as const;

// Mirrors the Rust `CoreStatus` struct (src-tauri/src/core_host.rs).
interface CoreStatus {
  url: string;
  adopted: boolean;
  pid: number | null;
  ms_to_healthy: number | null;
  state: "starting" | "ready" | "failed";
  error: string | null;
}

const POLL_MS = 1000;

// The webview never fetches the Node core directly (its CORS allowlist does
// not include the Tauri origin); status always comes through a Rust command.
function CoreStatusBar() {
  const [status, setStatus] = useState<CoreStatus | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);

  useEffect(() => {
    let timer: number | undefined;
    let done = false;
    const poll = async () => {
      try {
        const next = await invoke<CoreStatus>("core_status");
        if (done) return;
        setStatus(next);
        setPollError(null);
        if (next.state === "ready" || next.state === "failed") return;
      } catch (e) {
        if (done) return;
        setPollError(String(e));
      }
      timer = window.setTimeout(poll, POLL_MS);
    };
    void poll();
    return () => {
      done = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, []);

  if (!status) {
    return <div className="statusbar">core: starting… {pollError ?? ""}</div>;
  }
  return (
    <div className="statusbar" data-state={status.state}>
      <span>core: {status.state}</span>
      <span>url: {status.url}</span>
      <span>adopted: {String(status.adopted)}</span>
      <span>pid: {status.pid ?? "-"}</span>
      <span>ms: {status.ms_to_healthy ?? "-"}</span>
      {status.error && <span className="statusbar-error">{status.error}</span>}
    </div>
  );
}

export function App() {
  const [active, setActive] = useState<(typeof TABS)[number]["id"]>("graph");
  const current = TABS.find((t) => t.id === active) ?? TABS[0];
  const View = current.View;

  return (
    <div className="app">
      <nav className="tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={t.id === active}
            className={t.id === active ? "tab active" : "tab"}
            onClick={() => setActive(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>
      <CoreStatusBar />
      <main className="content">
        <View />
      </main>
    </div>
  );
}
