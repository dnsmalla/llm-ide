// Context-menu items for the file tree, as plain data (no React), so the rules for a server folder are tested without a DOM.
import type { MenuItem } from "./ContextMenu";
import type { ExplorerSnapshot } from "./controller";
import { parentOf } from "./fs";
import { topLevel } from "./tree-model";

export interface TreeMenuContext {
  projectRoot: string | null;
  /** A cut or copy is pending, so Paste is enabled. */
  clipboardSet: boolean;
  /** The project lives on an SSH server: actions that open this computer's file manager are left out. */
  serverFiles: boolean;
}

/** The entry at `path` in the already-loaded listing of its folder, or null. */
export function findEntry(snap: ExplorerSnapshot, path: string) {
  const d = snap.tree.dirs.get(parentOf(path));
  if (!d) return null;
  for (const page of d.pages.values()) for (const e of page) if (e.path === path) return e;
  return null;
}

/** The tree's context menu for `path` (null = the empty space of the tree). */
export function treeMenuItems(snap: ExplorerSnapshot, path: string | null, ctx: TreeMenuContext): MenuItem[] {
  const sel = path !== null && snap.selection.paths.has(path) ? topLevel(snap.selection.paths) : path !== null ? [path] : [];
  const single = sel.length === 1;
  const isFile = path !== null && findEntry(snap, path)?.kind === "file";
  // Reveal opens this computer's file manager on the file, so it only exists for a project on this computer.
  const reveal: MenuItem[] = ctx.serverFiles ? [] : [{ id: "reveal", label: "Reveal in Finder", disabled: sel.length === 0 || !ctx.projectRoot }];
  return [
    ...(isFile && single ? [{ id: "open", label: "Open" }] : []),
    { id: "cut", label: sel.length > 1 ? `Cut ${sel.length} Items` : "Cut", disabled: sel.length === 0 },
    { id: "copy", label: sel.length > 1 ? `Copy ${sel.length} Items` : "Copy", disabled: sel.length === 0 },
    { id: "paste", label: "Paste", disabled: !ctx.clipboardSet, separator: true },
    { id: "new-file", label: "New File…", separator: isFile && single },
    { id: "new-dir", label: "New Folder…" },
    { id: "rename", label: "Rename…", disabled: !single, separator: true },
    { id: "delete", label: sel.length > 1 ? `Move ${sel.length} Items to Trash` : "Move to Trash", disabled: sel.length === 0, danger: true },
    { id: "copy-path", label: "Copy Relative Path", disabled: sel.length === 0 },
    { id: "copy-abs", label: "Copy Absolute Path", disabled: sel.length === 0 || !ctx.projectRoot, separator: true },
    ...reveal,
    ...(path !== null && single && findEntry(snap, path)?.kind === "dir" ? [{ id: "find-in", label: "Find in Folder", separator: true }] : []),
    { id: "refresh", label: "Refresh" },
  ];
}
