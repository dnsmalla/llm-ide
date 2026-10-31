import { memo } from "react";
import { ChevronIcon, FolderIcon, THEMES, type ThemeId } from "@llmide/ui-kit";
import { MenuButton, type MenuItem } from "./MenuButton";
import { useActiveProject, useCoreStatusView } from "./use-shell";

const ProjectSwitcher = memo(function ProjectSwitcher() {
  const { project, recent, openFolder, openRecent, error, refresh } = useActiveProject();
  const items: MenuItem[] = [
    ...recent.map((p, i) => ({
      id: `recent-${i}`,
      label: p.name,
      title: p.root,
      checked: project?.root === p.root,
      onSelect: () => void openRecent(i),
    })),
    { id: "open", label: "Open Folder…", onSelect: () => void openFolder() },
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
        <span className="sh-ellipsis">{project?.name ?? "No project"}</span>
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

/** Core state chip: re-renders only when the derived status view changes. */
const CoreChip = memo(function CoreChip() {
  const view = useCoreStatusView();
  return (
    <>
      <span className="sh-statusbar-core" role="status" aria-live="polite" data-level={view.level} title={view.detail ?? undefined}>
        <span className="sh-dot" aria-hidden="true" />
        {view.label}
      </span>
      {view.claudeNotice && (
        <span className="sh-statusbar-text sh-warning" title={view.claudeNotice}>
          Claude Code not found
        </span>
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
