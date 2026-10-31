import { memo, useState } from "react";
import { ChevronIcon, FolderIcon, THEMES, type ThemeId } from "@llmide/ui-kit";
import { MenuButton, type MenuItem } from "./MenuButton";
import { shellBus } from "./bus";
import { DiagnosticsPanel } from "./DiagnosticsPanel";
import { useActiveProject, useCoreStatusView } from "./use-shell";
import { HOME_CHOICES, readHome, storeHome } from "./landing";
import { SECTIONS, type SectionId } from "./sections";
import { safeText } from "./safe-text";

const ProjectSwitcher = memo(function ProjectSwitcher() {
  const { project, recent, openFolder, openRecent, closeProject, error, refresh } = useActiveProject();
  const items: MenuItem[] = [
    ...recent.map((p, i) => ({
      id: `recent-${i}`,
      label: safeText(p.name, 60),
      title: safeText(p.root, 300),
      checked: project?.root === p.root,
      onSelect: () => void openRecent(i),
    })),
    { id: "new", label: "New project…", onSelect: () => shellBus.publish({ type: "goto-section", section: "welcome", anchor: "new" }) },
    { id: "open", label: "Open Folder…", onSelect: () => void openFolder() },
    { id: "close", label: "Close project", title: "Back to the Welcome page. Nothing is deleted.", disabled: !project, onSelect: () => void closeProject() },
  ];
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
    </>
  );
});

/** Which section a project lands on (stored per viewer; default Explorer). */
const HomePicker = memo(function HomePicker() {
  const [home, setHome] = useState<SectionId>(() => readHome());
  const label = SECTIONS.find((s) => s.id === home)?.label ?? "Explorer";
  return (
    <MenuButton
      ariaLabel={`Home page: ${label}. Choose the section a project opens on`}
      className="sh-statusbar-item"
      up
      items={HOME_CHOICES.map((id) => ({
        id,
        label: SECTIONS.find((s) => s.id === id)?.label ?? id,
        checked: id === home,
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

interface Props {
  theme: ThemeId;
  onTheme: (id: ThemeId) => void;
}

export const StatusBar = memo(function StatusBar({ theme, onTheme }: Props) {
  const themeLabel = THEMES.find((t) => t.id === theme)?.label ?? theme;
  return (
    <footer className="sh-statusbar" aria-label="Status">
      <ProjectSwitcher />
      <CoreChip />
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
    </footer>
  );
});
