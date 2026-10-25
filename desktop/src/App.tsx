import { useState } from "react";
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
      <main className="content">
        <View />
      </main>
    </div>
  );
}
