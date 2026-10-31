import { useState } from "react";
import { THEMES, BellIcon, ChatBubbleIcon, FolderIcon, TerminalIcon, ChevronIcon, type ThemeId } from "@llmide/ui-kit";
import type { CoreStatus } from "./useCoreStatus";

interface Props {
  status: CoreStatus | null;
  pollError: string | null;
  theme: ThemeId;
  onTheme: (id: ThemeId) => void;
  projectName: string;
}

/** Bottom bar (Mac StatusBar): project switcher left, utilities right, core status compact. */
export function AppStatusBar({ status, pollError, theme, onTheme, projectName }: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const themeLabel = THEMES.find((t) => t.id === theme)?.label ?? theme;

  const core = !status
    ? `core: starting… ${pollError ?? ""}`
    : `core: ${status.state} · ${status.url.replace("http://", "")} · ${status.adopted ? "adopted (unverified)" : "spawned"} · ${status.ms_to_healthy ?? "-"} ms`;

  return (
    <div className="ui-statusbar" data-state={status?.state ?? "starting"}>
      <button type="button" className="ui-statusbar-project">
        <FolderIcon />
        <span>{projectName}</span>
        <span className="ui-statusbar-caret">
          <ChevronIcon />
        </span>
      </button>
      <span className="ui-statusbar-core" title={status?.error ?? status?.notice ?? undefined}>
        {core}
      </span>
      <span className="ui-statusbar-spacer" />
      <div className="ui-statusbar-theme">
        <button
          type="button"
          className="ui-statusbar-item"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((v) => !v)}
        >
          {themeLabel}
          <span className="ui-statusbar-caret">
            <ChevronIcon />
          </span>
        </button>
        {menuOpen && (
          <div className="ui-statusbar-menu" role="menu">
            {THEMES.map((t) => (
              <button
                key={t.id}
                type="button"
                role="menuitemradio"
                aria-checked={t.id === theme}
                className="ui-statusbar-menu-item"
                onClick={() => {
                  onTheme(t.id);
                  setMenuOpen(false);
                }}
              >
                {t.label}
              </button>
            ))}
          </div>
        )}
      </div>
      <button type="button" className="ui-icon-button" aria-label="Toggle Terminal" title="Toggle Terminal">
        <TerminalIcon />
      </button>
      <button type="button" className="ui-icon-button" aria-label="Activity" title="Activity">
        <BellIcon />
      </button>
      <button type="button" className="ui-statusbar-item ui-statusbar-chat" title="llm-chat">
        <ChatBubbleIcon />
        <span>llm-chat</span>
      </button>
    </div>
  );
}
