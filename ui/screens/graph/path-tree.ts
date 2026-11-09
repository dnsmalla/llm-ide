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

/** Rows the tree renders. Beyond this the tree shows the first files in alphabetical order and says how many exist. */
export const MAX_TREE_FILES = 2000;

/** One collator for every sort here: building a Collator per comparison is the expensive part of localeCompare. */
const COLLATOR = new Intl.Collator("en");

/** Safe project-relative paths: no absolute paths, ".", "..", control characters, or empty segments. */
function cleanPath(p: string): string | null {
  const t = p.trim();
  if (t === "" || t.length > 1024 || t.startsWith("/") || t.includes("\0") || /[\u0000-\u001f]/.test(t)) return null;
  const parts = t.split("/").filter((s) => s !== "");
  if (parts.some((s) => s === "." || s === "..")) return null;
  return parts.join("/");
}

interface UniquePaths {
  set: Set<string>;
  sorted: string[];
}

/** The last graph's paths, cleaned, de-duplicated and sorted. The tree, its cap note and the file count all read the
 *  same array in one render, so the work is done once per array. Callers must not mutate the array between calls. */
let memo: { source: readonly (string | null)[]; unique: UniquePaths } | null = null;

function uniquePaths(paths: readonly (string | null)[]): UniquePaths {
  if (memo !== null && memo.source === paths) return memo.unique;
  const set = new Set<string>();
  for (const raw of paths) {
    if (typeof raw !== "string") continue;
    const p = cleanPath(raw);
    if (p !== null) set.add(p);
  }
  const unique: UniquePaths = { set, sorted: [...set].sort((a, b) => COLLATOR.compare(a, b)) };
  memo = { source: paths, unique };
  return unique;
}

/** The unique, sorted file paths of the graph: the first `MAX_TREE_FILES` in alphabetical order. */
export function graphFiles(paths: readonly (string | null)[]): string[] {
  return uniquePaths(paths).sorted.slice(0, MAX_TREE_FILES);
}

/** How many unique file paths the graph has, before the tree's cap (for the "first N of M" note). */
export function totalGraphFiles(paths: readonly (string | null)[]): number {
  return uniquePaths(paths).set.size;
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
  dir.children.sort((a, b) => (a.kind === b.kind ? COLLATOR.compare(a.name, b.name) : a.kind === "dir" ? -1 : 1));
  for (const c of dir.children) if (c.kind === "dir") sortTree(c);
}

/** How many files the tree contains (for the cap note). */
export function fileCount(node: FileDir): number {
  let n = 0;
  for (const c of node.children) n += c.kind === "file" ? 1 : fileCount(c);
  return n;
}
