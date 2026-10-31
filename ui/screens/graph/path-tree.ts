// The graph's left-panel file tree: unique file paths from the loaded graph, folded into folders. The Mac's
// Library tree lists project files; this lists the files the graph actually covers, so a row never opens an empty
// target. Bounded: a graph can name tens of thousands of files, and the tree is a navigation aid, not an index.
export interface FileDir {
  kind: "dir";
  name: string;
  /** The project-relative directory path ("" for the root). */
  path: string;
  children: FileNode[];
}
export interface FileLeaf {
  kind: "file";
  name: string;
  path: string;
}
export type FileNode = FileDir | FileLeaf;

export const MAX_TREE_FILES = 500;

/** Safe project-relative paths: no absolute paths, ".", "..", control characters, or empty segments. */
function cleanPath(p: string): string | null {
  const t = p.trim();
  if (t === "" || t.length > 1024 || t.startsWith("/") || t.includes("\0") || /[\u0000-\u001f]/.test(t)) return null;
  const parts = t.split("/").filter((s) => s !== "");
  if (parts.some((s) => s === "." || s === "..")) return null;
  return parts.join("/");
}

/** The unique, sorted file paths of the graph (bounded by `MAX_TREE_FILES`). */
export function graphFiles(paths: readonly (string | null)[]): string[] {
  const set = new Set<string>();
  for (const raw of paths) {
    if (typeof raw !== "string") continue;
    const p = cleanPath(raw);
    if (p !== null) set.add(p);
    if (set.size >= MAX_TREE_FILES) break;
  }
  return [...set].sort((a, b) => a.localeCompare(b, "en"));
}

/** A folder tree of the graph's files, folders first and alphabetical, built in one pass. */
export function buildPathTree(paths: readonly (string | null)[]): FileDir {
  const root: FileDir = { kind: "dir", name: "", path: "", children: [] };
  const dirs = new Map<string, FileDir>([["", root]]);
  for (const path of graphFiles(paths)) {
    const parts = path.split("/");
    const file = parts.pop()!;
    let parent = root;
    let prefix = "";
    for (const part of parts) {
      prefix = prefix ? `${prefix}/${part}` : part;
      let dir = dirs.get(prefix);
      if (!dir) {
        dir = { kind: "dir", name: part, path: prefix, children: [] };
        dirs.set(prefix, dir);
        parent.children.push(dir);
      }
      parent = dir;
    }
    parent.children.push({ kind: "file", name: file, path });
  }
  sortTree(root);
  return root;
}

function sortTree(dir: FileDir): void {
  dir.children.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, "en") : a.kind === "dir" ? -1 : 1));
  for (const c of dir.children) if (c.kind === "dir") sortTree(c);
}

/** How many files the tree contains (for the cap note). */
export function fileCount(node: FileDir): number {
  let n = 0;
  for (const c of node.children) n += c.kind === "file" ? 1 : fileCount(c);
  return n;
}
