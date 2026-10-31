// Pure Source Control logic: grouping, flattening, windowing, selection, form validation, error wording.
// No React, no host. The Rust side re-validates everything; these checks only give early, readable feedback.
import type { ScmStatusEntry } from "./api";

export type GroupId = "conflicts" | "staged" | "changes" | "untracked";
export const GROUP_ORDER: readonly GroupId[] = ["conflicts", "staged", "changes", "untracked"];
export const GROUP_LABEL: Record<GroupId, string> = {
  conflicts: "Merge conflicts",
  staged: "Staged changes",
  changes: "Changes",
  untracked: "Untracked files",
};

/** Row height used by the virtual list (px). */
export const ROW_HEIGHT = 24;
/** Limits that mirror the host (`MAX_STAGE_PATHS`, `MAX_DISCARD_PATHS`, commit message cap). */
export const STAGE_CHUNK = 500;
export const MAX_DISCARD = 200;
export const MAX_MESSAGE_BYTES = 20_000;

// ---- untrusted text (paths, subjects, author names, diffs) -------------------------------------------------

const INVISIBLE = /[\u00AD\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF\uFFF9-\uFFFB]|\uDB40[\uDC00-\uDC7F]/g;
const INVISIBLE_ONE = new RegExp(INVISIBLE.source);
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;

/** Plain display text: control characters and bidi/invisible format characters removed. */
export function displayText(s: string): string {
  return s.replace(CONTROL, "").replace(INVISIBLE, "");
}

/** Single-line variant for names and subjects. */
export function displayLine(s: string): string {
  return displayText(s).replace(/[\n\t]+/g, " ");
}

export function splitPath(path: string): { dir: string; name: string } {
  const p = path.endsWith("/") ? path.slice(0, -1) : path;
  const i = p.lastIndexOf("/");
  return { dir: i < 0 ? "" : p.slice(0, i), name: (i < 0 ? p : p.slice(i + 1)) + (path.endsWith("/") ? "/" : "") };
}

// ---- grouping ----------------------------------------------------------------------------------------------

export interface FileItem {
  /** Unique within the flattened list: `<group>:<path>`. */
  key: string;
  group: GroupId;
  entry: ScmStatusEntry;
  /** The status letter shown for this placement (index column for staged, worktree column otherwise). */
  letter: string;
}

const cmp = (a: FileItem, b: FileItem) => (a.entry.path < b.entry.path ? -1 : a.entry.path > b.entry.path ? 1 : 0);

export type Groups = Record<GroupId, FileItem[]>;

/** One entry can appear in two groups (staged and changed). Each group is sorted by path. */
export function buildGroups(entries: readonly ScmStatusEntry[]): Groups {
  const g: Groups = { conflicts: [], staged: [], changes: [], untracked: [] };
  for (const e of entries) {
    const mk = (group: GroupId, letter: string): FileItem => ({ key: `${group}:${e.path}`, group, entry: e, letter });
    if (e.kind === "unmerged") g.conflicts.push(mk("conflicts", "!"));
    else if (e.kind === "untracked") g.untracked.push(mk("untracked", "U"));
    else {
      if (e.index !== "." && e.index !== " ") g.staged.push(mk("staged", e.index));
      if (e.worktree !== "." && e.worktree !== " ") g.changes.push(mk("changes", e.worktree));
    }
  }
  for (const id of GROUP_ORDER) g[id].sort(cmp);
  return g;
}

export type Row = { type: "header"; group: GroupId; count: number; collapsed: boolean } | { type: "file"; item: FileItem };

/** Header + files for each non-empty group; collapsed groups contribute only their header. */
export function flatten(groups: Groups, collapsed: ReadonlySet<GroupId>): Row[] {
  const rows: Row[] = [];
  for (const id of GROUP_ORDER) {
    const items = groups[id];
    if (items.length === 0) continue;
    const isCollapsed = collapsed.has(id);
    rows.push({ type: "header", group: id, count: items.length, collapsed: isCollapsed });
    if (!isCollapsed) for (const item of items) rows.push({ type: "file", item });
  }
  return rows;
}

export function rowKey(r: Row): string {
  return r.type === "header" ? `h:${r.group}` : r.item.key;
}

// ---- windowing ---------------------------------------------------------------------------------------------

export interface Win {
  start: number;
  end: number;
  padTop: number;
  padBottom: number;
  total: number;
}

/** Which rows to render for a scroll offset: a fixed window plus overscan, spacers for the rest. */
export function windowRows(count: number, scrollTop: number, viewport: number, rowH = ROW_HEIGHT, overscan = 8): Win {
  const first = Math.max(0, Math.floor(scrollTop / rowH) - overscan);
  const visible = Math.ceil(Math.max(viewport, rowH) / rowH) + overscan * 2;
  const start = Math.min(first, count);
  const end = Math.min(count, start + visible);
  return { start, end, padTop: start * rowH, padBottom: (count - end) * rowH, total: count * rowH };
}

/** Scroll offset that brings row `index` fully into view, or null if it already is. */
export function scrollToReveal(index: number, scrollTop: number, viewport: number, rowH = ROW_HEIGHT): number | null {
  const top = index * rowH;
  if (top < scrollTop) return top;
  if (top + rowH > scrollTop + viewport) return top + rowH - viewport;
  return null;
}

// ---- selection ---------------------------------------------------------------------------------------------

export interface Selection {
  keys: ReadonlySet<string>;
  anchor: string | null;
}
export const NO_SELECTION: Selection = { keys: new Set(), anchor: null };

/** Click semantics: plain = only this, toggle (ctrl/cmd) = add/remove, shift = range from the anchor (files only). */
export function selectRow(sel: Selection, rows: readonly Row[], key: string, mods: { shift: boolean; toggle: boolean }): Selection {
  const idx = rows.findIndex((r) => rowKey(r) === key);
  if (idx < 0 || rows[idx].type !== "file") return sel;
  if (mods.shift && sel.anchor) {
    const a = rows.findIndex((r) => rowKey(r) === sel.anchor);
    if (a >= 0) {
      const [lo, hi] = a < idx ? [a, idx] : [idx, a];
      const keys = new Set<string>();
      for (let i = lo; i <= hi; i++) {
        const r = rows[i];
        if (r.type === "file") keys.add(r.item.key);
      }
      return { keys, anchor: sel.anchor };
    }
  }
  if (mods.toggle) {
    const keys = new Set(sel.keys);
    if (keys.has(key)) keys.delete(key);
    else keys.add(key);
    return { keys, anchor: key };
  }
  return { keys: new Set([key]), anchor: key };
}

/** Drops selected keys that no longer exist (after a refresh). */
export function pruneSelection(sel: Selection, groups: Groups): Selection {
  const live = new Set<string>();
  for (const id of GROUP_ORDER) for (const it of groups[id]) live.add(it.key);
  const keys = new Set([...sel.keys].filter((k) => live.has(k)));
  return keys.size === sel.keys.size ? sel : { keys, anchor: sel.anchor && live.has(sel.anchor) ? sel.anchor : null };
}

export function selectedItems(groups: Groups, sel: Selection): FileItem[] {
  const out: FileItem[] = [];
  for (const id of GROUP_ORDER) for (const it of groups[id]) if (sel.keys.has(it.key)) out.push(it);
  return out;
}

export function chunk<T>(items: readonly T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n));
  return out;
}

/** What an action may do with a selection, by group. */
export function actionsFor(items: readonly FileItem[]): { stage: FileItem[]; unstage: FileItem[]; discard: FileItem[]; open: FileItem | null } {
  return {
    stage: items.filter((i) => i.group === "changes" || i.group === "untracked" || i.group === "conflicts"),
    unstage: items.filter((i) => i.group === "staged"),
    discard: items.filter((i) => (i.group === "changes" || i.group === "untracked") && !i.entry.submodule),
    open: items[0] ?? null,
  };
}

// ---- hunk selection ----------------------------------------------------------------------------------------

export function toggleHunk(sel: ReadonlySet<number>, i: number): Set<number> {
  const next = new Set(sel);
  if (next.has(i)) next.delete(i);
  else next.add(i);
  return next;
}

export function selectAllHunks(count: number): Set<number> {
  return new Set(Array.from({ length: count }, (_, i) => i));
}

/** Sorted, de-duplicated indexes in range: exactly what the host is sent. */
export function hunkIndexes(sel: ReadonlySet<number>, count: number): number[] {
  return [...sel].filter((i) => Number.isInteger(i) && i >= 0 && i < count).sort((a, b) => a - b);
}

// ---- commit form -------------------------------------------------------------------------------------------

export interface CommitCheck {
  ok: boolean;
  /** Why the Commit button is disabled (empty when ok). */
  reason: string;
  bytes: number;
}

export function utf8Length(s: string): number {
  let n = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
  }
  return n;
}

export function validateCommit(message: string, stagedCount: number, conflictCount: number): CommitCheck {
  const text = displayText(message.replace(/\r\n?/g, "\n")).trim();
  const bytes = utf8Length(text);
  if (conflictCount > 0) return { ok: false, reason: "Resolve and stage the conflicted files first.", bytes };
  if (stagedCount === 0) return { ok: false, reason: "Nothing is staged.", bytes };
  if (text === "") return { ok: false, reason: "Write a commit message.", bytes };
  if (text.startsWith("-")) return { ok: false, reason: "The message must not start with \"-\".", bytes };
  if (bytes > MAX_MESSAGE_BYTES) return { ok: false, reason: `The message is longer than ${MAX_MESSAGE_BYTES} bytes.`, bytes };
  return { ok: true, reason: "", bytes };
}

/** Mirror of the host's branch-name check (`git check-ref-format --branch`, stricter). Returns an error or null. */
export function branchNameError(name: string): string | null {
  if (name === "" || utf8Length(name) > 200) return "Use 1 to 200 characters.";
  if (name.startsWith("-")) return "A branch name must not start with \"-\".";
  if (name === "@" || name.toLowerCase() === "head") return "That name is reserved.";
  if (name.startsWith("/") || name.endsWith("/") || name.includes("//")) return "A branch name cannot have an empty path part.";
  if (name.includes("..") || name.includes("@{") || name.endsWith(".")) return "A branch name cannot contain \"..\" or \"@{\" or end with \".\".";
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F-\u009F ~^:?*[\\]/.test(name) || INVISIBLE_ONE.test(name)) return "No spaces, control characters or any of ~ ^ : ? * [ \\.";
  for (const part of name.split("/")) if (part.startsWith(".") || part.endsWith(".lock")) return "A part of the name starts with \".\" or ends with \".lock\".";
  return null;
}

// ---- wording -----------------------------------------------------------------------------------------------

export interface ErrorInfo {
  code: string;
  title: string;
  detail: string;
  /** Verbatim commands or steps to show in a code block, if any. */
  steps: string[];
}

export function describeError(code: string, message: string): ErrorInfo {
  const clean = displayText(message).slice(0, 600);
  switch (code) {
    case "untrusted_repo_config":
      return {
        code,
        title: "This repository's git configuration is not trusted",
        detail:
          "Its .git/config (or a config it includes) sets something that makes git run a program, such as a filter driver, an include, fsmonitor, an ssh command or a credential helper. LLM-IDE will not run git here until that is removed. " +
          "Open .git/config in a trusted editor or terminal, review the entry named below, and remove it if you do not recognise it. LLM-IDE cannot mark a repository as trusted for you. " +
          clean,
        steps: [],
      };
    case "identity_missing":
      return {
        code,
        title: "Set your git identity",
        detail: "Git does not know your name and email, and LLM-IDE never writes your git config. Run these in a terminal, then commit again.",
        steps: ['git config --global user.name "Your Name"', 'git config --global user.email "you@example.com"'],
      };
    case "not_a_repo":
      return { code, title: "Not a git repository", detail: "This project folder is not a git repository (or is a bare repository). Run git init in a terminal to start one.", steps: [] };
    case "git_unavailable":
      return { code, title: "git was not found", detail: "Install git and make sure it is on your PATH, then reopen the project.", steps: [] };
    case "git_timeout":
      return { code, title: "git took too long", detail: "The command was stopped after its time limit. Try again, or run it in a terminal for very large changes.", steps: [] };
    case "changed":
      return { code, title: "The file changed", detail: "It changed since the hunks were listed. They were reloaded; select again.", steps: [] };
    case "dirty_conflict":
      return { code, title: "Switch refused", detail: "Your uncommitted changes would be overwritten by that checkout. Commit or discard them first. Nothing was changed.", steps: [] };
    case "conflict":
      return { code, title: "Resolve conflicts first", detail: clean || "Files are in conflict. Edit them, then stage each one to mark it resolved.", steps: [] };
    case "nothing_staged":
      return { code, title: "Nothing is staged", detail: "Stage some changes before committing.", steps: [] };
    case "cancelled":
      return { code, title: "Cancelled", detail: "Nothing was changed.", steps: [] };
    case "invalid_ref":
    case "invalid_message":
    case "empty_message":
    case "exists":
    case "too_large":
    case "unsupported_diff":
    case "binary":
    case "submodule":
    case "nothing_to_discard":
    case "not_found":
      return { code, title: "Cannot do that", detail: clean, steps: [] };
    case "unavailable":
      return { code, title: "Needs the desktop app", detail: "Source Control talks to git through the desktop host, which is not available here.", steps: [] };
    default:
      return { code, title: "Git reported a problem", detail: clean || code, steps: [] };
  }
}

export function relativeTime(sec: number, nowMs: number): string {
  if (!sec) return "";
  const d = Math.max(0, Math.floor(nowMs / 1000 - sec));
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)} min ago`;
  if (d < 86400) return `${Math.floor(d / 3600)} h ago`;
  if (d < 86400 * 60) return `${Math.floor(d / 86400)} d ago`;
  return new Date(sec * 1000).toISOString().slice(0, 10);
}

const LETTER_WORD: Record<string, string> = { M: "modified", A: "added", D: "deleted", R: "renamed", C: "copied", T: "type changed", U: "unmerged", "!": "conflict" };
export function letterWord(letter: string): string {
  return LETTER_WORD[letter] ?? (letter === "?" ? "untracked" : "changed");
}

export const HOOKS_NOTE = "Hooks do not run in LLM-IDE.";
export const TOO_MANY_NOTICE = "Too many changes to list: showing the first 20,000. Commit or discard some, or add ignore rules, to see the rest.";
