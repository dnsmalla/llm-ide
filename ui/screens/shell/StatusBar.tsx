import { memo, useState, type ReactNode } from "react";
import { ChatBubbleIcon, ChevronIcon, FolderIcon, THEMES, type ThemeId } from "@llmide/ui-kit";
import { ActivityBell } from "./ActivityBell";
import { BusInbox } from "./approvals/BusInbox";
import { MenuButton, type MenuItem } from "./MenuButton";
import { shellBus } from "./bus";
import { host, type ProjectInfo } from "./host";
import { DiagnosticsPanel } from "./DiagnosticsPanel";
import { useActiveProject, useCoreSession, useCoreStatusView, useFeatures } from "./use-shell";
import { HOME_CHOICES, readHome, selectHome, storeHome } from "./landing";
import { SECTIONS, type SectionId } from "./sections";
import { isSectionEnabled } from "./features";
import { safeText } from "./safe-text";

export interface ProjectMenuActions {
  openRecent(index: number): Promise<void>;
  openFolder(): Promise<void>;
  closeProject(): Promise<void>;
  reveal(): void;
}

/**
 * The project switcher's rows (Mac `ProjectSwitcher`): recent projects, New, Open Folder, then "Reveal in Finder"
 * only while a project is open (the Mac shows it only for the active project), then Close. Pure, so tests need no DOM.
 */
export function projectSwitcherItems(project: ProjectInfo | null, recent: readonly ProjectInfo[], a: ProjectMenuActions): MenuItem[] {
  return [
    ...recent.map((p, i) => ({
      id: `recent-${i}`,
      label: safeText(p.name, 60),
      title: safeText(p.root, 300),
      checked: project?.root === p.root,
      onSelect: () => void a.openRecent(i),
    })),
    { id: "new", label: "New project…", onSelect: () => shellBus.publish({ type: "goto-section", section: "welcome", anchor: "new" }) },
    { id: "open", label: "Open Folder…", onSelect: () => void a.openFolder() },
    ...(project ? [{ id: "reveal", label: "Reveal in Finder", title: "Show the project folder in the file manager.", onSelect: a.reveal }] : []),
    { id: "close", label: "Close project", title: "Back to the Welcome page. Nothing is deleted.", disabled: !project, onSelect: () => void a.closeProject() },
  ];
}

const ProjectSwitcher = memo(function ProjectSwitcher() {
  const { project, recent, openFolder, openRecent, closeProject, error, refresh } = useActiveProject();
  const [revealError, setRevealError] = useState<string | null>(null);
  const items = projectSwitcherItems(project, recent, {
    openRecent,
    openFolder,
    closeProject,
    reveal: () => {
      setRevealError(null);
      host.projectReveal().catch((e: unknown) => setRevealError(safeText(e instanceof Error ? e.message : String(e), 200)));
    },
  });
  return (
    <>
      <MenuButton
        ariaLabel={`Project: ${project?.name ?? "none"}. Switch project`}
        className="sh-statusbar-item sh-statusbar-project"
        items={items}
        up
        onOpen={() => void refresh()}
      >
        <FolderIcon />
        <span className="sh-ellipsis">{project ? safeText(project.name, 60) : "No project"}</span>
        <span className="sh-caret">
          <ChevronIcon />
        </span>
      </MenuButton>
      {error && (
        <span className="sh-statusbar-text sh-danger" role="status" title={error}>
          Project error
        </span>
      )}
      {revealError && (
        <span className="sh-statusbar-text sh-danger" role="status" title={revealError}>
          Could not reveal the folder
        </span>
      )}
    </>
  );
});

/** Which section a project lands on (stored per viewer; default Explorer). */
const HomePicker = memo(function HomePicker() {
  const features = useFeatures();
  const [home, setHome] = useState<SectionId>(() => readHome());
  const choices = HOME_CHOICES.filter((id) => isSectionEnabled(id, features.usable));
  // The status shows the section a project would really open on, not a stored choice whose feature is off.
  const effective = selectHome(home, features.usable);
  const label = SECTIONS.find((s) => s.id === effective)?.label ?? "Explorer";
  return (
    <MenuButton
      ariaLabel={`Home page: ${label}. Choose the section a project opens on`}
      className="sh-statusbar-item"
      up
      items={choices.map((id) => ({
        id,
        label: SECTIONS.find((s) => s.id === id)?.label ?? id,
        checked: id === effective,
        onSelect: () => {
          storeHome(id);
          setHome(id);
        },
      }))}
    >
      Home: {label}
      <span className="sh-caret">
        <ChevronIcon />
      </span>
    </MenuButton>
  );
});

/** Core state chip: re-renders only when the derived status view changes. */
const CoreChip = memo(function CoreChip() {
  const view = useCoreStatusView();
  const [diag, setDiag] = useState(false);
  return (
    <>
      <button type="button" className="sh-statusbar-core sh-statusbar-item" aria-live="polite" aria-haspopup="dialog" aria-expanded={diag} data-level={view.level} title={view.detail ?? "Show core diagnostics"} onClick={() => setDiag((v) => !v)}>
        <span className="sh-dot" aria-hidden="true" />
        {view.label}
      </button>
      {diag && (
        <div style={{ position: "fixed", left: 8, bottom: 32, zIndex: 50 }} onKeyDown={(e) => e.key === "Escape" && setDiag(false)}>
          <DiagnosticsPanel onClose={() => setDiag(false)} />
        </div>
      )}
      {view.hints.map((h) => (
        <button
          key={h.id}
          type="button"
          className="sh-statusbar-item"
          data-hint={h.id}
          data-level={h.level}
          aria-label={h.command ? `${h.text} Press to copy the command.` : h.text}
          title={h.text}
          onClick={() => {
            try {
              if (h.command) void navigator.clipboard?.writeText(h.command);
            } catch {
              /* clipboard unavailable */
            }
          }}
        >
          {h.id === "foreign_core" ? "Other server on :3456" : "Ports busy"}
        </button>
      ))}
      {view.claudeNotice && (
        <button type="button" className="sh-statusbar-item sh-warning" title={`${view.claudeNotice} Open Settings.`} onClick={() => shellBus.publish({ type: "goto-section", section: "settings", anchor: "providers" })}>
          Claude Code not found
        </button>
      )}
    </>
  );
});

/** The /health mismatch chip; exported separately so its text/ARIA can be tested without the bar's hooks. */
export function ServerOutdatedChip({ warning }: { warning: string }) {
  return (
    <button type="button" className="sh-statusbar-item sh-warning" title={warning} aria-label={`Server out of date. ${warning} Open Server settings.`} onClick={() => shellBus.publish({ type: "goto-section", section: "settings", anchor: "server" })}>
      Server out of date
    </button>
  );
}

/** The Mac's "llm-chat" badge: Chat is reachable from every screen. Signed-in only, like the Mac's whole bar. */
const ChatItem = memo(function ChatItem({ active }: { active: boolean }) {
  return (
    <button
      type="button"
      className="sh-statusbar-item"
      aria-label="Open Chat"
      aria-current={active ? "page" : undefined}
      title="Chat (Ctrl/Cmd+1)"
      onClick={() => shellBus.publish({ type: "goto-section", section: "chat" })}
    >
      <ChatBubbleIcon size={12} />
      Chat
    </button>
  );
});

interface Props {
  /** `/health` says the core is older than this app; the chip opens the Server settings card. */
  apiWarning?: string | null;
  /** Status-bar terminal toggle (non-Explorer sections). */
  terminalItem?: ReactNode | null;
  theme: ThemeId;
  /** The Chat section is showing (the item is marked current). */
  chatActive?: boolean;
  onTheme: (id: ThemeId) => void;
}

export const StatusBar = memo(function StatusBar({ apiWarning = null, theme, onTheme, chatActive = false, terminalItem = null }: Props) {
  const { signedIn } = useCoreSession();
  const themeLabel = THEMES.find((t) => t.id === theme)?.label ?? theme;
  return (
    <footer className="sh-statusbar" aria-label="Status">
      <ProjectSwitcher />
      <CoreChip />
      {apiWarning && <ServerOutdatedChip warning={apiWarning} />}
      <span className="sh-spacer" />
      <HomePicker />
      <MenuButton
        ariaLabel={`Theme: ${themeLabel}`}
        up
        items={THEMES.map((t) => ({ id: t.id, label: t.label, checked: t.id === theme, onSelect: () => onTheme(t.id) }))}
      >
        {themeLabel}
        <span className="sh-caret">
          <ChevronIcon />
        </span>
      </MenuButton>
      {terminalItem}
      <BusInbox />
      <ActivityBell />
      {signedIn && <ChatItem active={chatActive} />}
    </footer>
  );
});
