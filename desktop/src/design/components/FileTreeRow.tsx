// Used from T4+ (not rendered by the T3b shell yet).
import type { ReactNode } from "react";
import { ChevronIcon } from "./icons";

export type GitStatus = "modified" | "added" | "untracked" | "deleted" | "conflicted";

const GIT_LETTER: Record<GitStatus, string> = {
  modified: "M",
  added: "A",
  untracked: "U",
  deleted: "D",
  conflicted: "C",
};

interface Props {
  name: string;
  isFolder: boolean;
  isExpanded?: boolean;
  /** Ancestor levels; each adds one 14px indent guide (Mac TreeRowLabel). */
  depth: number;
  icon?: ReactNode;
  badge?: string;
  gitStatus?: GitStatus;
  selected?: boolean;
  onClick?: () => void;
  /** When set, the chevron is its own button so expanding does not select (Explorer behaviour). */
  onToggle?: () => void;
}

/** One file-tree row: indent guides, chevron/icon, name, git decoration (Mac TreeRowLabel). */
export function FileTreeRow({
  name,
  isFolder,
  isExpanded = false,
  depth,
  icon,
  badge,
  gitStatus,
  selected = false,
  onClick,
  onToggle,
}: Props) {
  return (
    <div
      className="ui-tree-row"
      role="treeitem"
      aria-selected={selected}
      aria-expanded={isFolder ? isExpanded : undefined}
      data-git={gitStatus}
      data-deleted={gitStatus === "deleted" ? "true" : undefined}
      onClick={onClick}
    >
      {depth > 0 && (
        <span className="ui-tree-guides" aria-hidden="true">
          {Array.from({ length: depth }, (_, i) => (
            <span key={i} className="ui-tree-guide" />
          ))}
        </span>
      )}
      {isFolder ? (
        onToggle ? (
          <button
            type="button"
            className="ui-tree-chevron"
            aria-label={isExpanded ? `Collapse ${name}` : `Expand ${name}`}
            onClick={(e) => {
              e.stopPropagation();
              onToggle();
            }}
          >
            <span style={{ transform: isExpanded ? "rotate(90deg)" : undefined, display: "inline-flex" }}>
              <ChevronIcon />
            </span>
          </button>
        ) : (
          <span className="ui-tree-chevron-static" aria-hidden="true">
            <span style={{ transform: isExpanded ? "rotate(90deg)" : undefined, display: "inline-flex" }}>
              <ChevronIcon />
            </span>
          </span>
        )
      ) : (
        <span className="ui-tree-chevron-static" aria-hidden="true" />
      )}
      <span className="ui-tree-icon ui-tree-icon-file" aria-hidden="true">
        {icon}
      </span>
      <span className="ui-tree-name">{name}</span>
      {badge && <span className="ui-tree-badge">{badge}</span>}
      <span className="ui-tree-spacer" />
      {gitStatus && <span className="ui-tree-git-letter">{GIT_LETTER[gitStatus]}</span>}
    </div>
  );
}
