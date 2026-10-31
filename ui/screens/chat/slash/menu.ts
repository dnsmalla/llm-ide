// The "/" menu model (pure): which rows, in which order, with which section headers, and what accepting a row
// means. Group order is fixed so the menu renders stable sections instead of interleaving kinds.
import { rank, bestIndex } from "./rank";
import { SECTION_TITLES, type MenuItem } from "./items";
import type { CatalogSnapshot } from "./loader";
import { safeLine } from "./sanitize";
import { draftRemovingLastToken } from "./trigger";

export interface MenuView {
  items: MenuItem[];
  /** Section title to draw above the row at each index (computed in the same pass as the order). */
  headers: ReadonlyMap<number, string>;
  selected: number;
}

export const EMPTY_VIEW: MenuView = { items: [], headers: new Map(), selected: 0 };

export function headerIndex(items: readonly MenuItem[]): Map<number, string> {
  const out = new Map<number, string>();
  let prev: string | null = null;
  items.forEach((it, i) => {
    const t = SECTION_TITLES[it.kind];
    if (t && t !== prev) out.set(i, t);
    prev = t;
  });
  return out;
}

export interface CommandSources { catalog: CatalogSnapshot; modes: MenuItem[]; models: MenuItem[] }

/** Everything discoverable from "/", ranked within each group, groups in a fixed order. */
export function buildCommandView(src: CommandSources, query: string): MenuView {
  const q = query.toLowerCase();
  const c = src.catalog;
  const groups = [c.commands, c.skills, c.subagents, c.library, c.hooks, c.mcp, src.modes, src.models];
  const items: MenuItem[] = [];
  for (const g of groups) for (const it of rank(g, q)) items.push(it);
  return { items, headers: headerIndex(items), selected: bestIndex(items, q) };
}

export function buildMentionView(items: readonly MenuItem[]): MenuView {
  const list = items.slice();
  return { items: list, headers: headerIndex(list), selected: 0 };
}

export type Accept =
  | { type: "replaceDraft"; text: string; /** keep the menu open (a folder was entered) */ keepOpen?: boolean }
  | { type: "useSkill"; id: string; name: string; newDraft: string }
  | { type: "useDirective"; id: string; name: string; directive: string; newDraft: string }
  | { type: "navigate"; target: { kind: "plugin" | "mcp"; id: string }; newDraft: string }
  | { type: "setMode"; mode: string; newDraft: string }
  | { type: "setModel"; provider: string; model: string; newDraft: string }
  | { type: "attachFile"; path: string; newDraft: string }
  | { type: "attachNote"; id: string; label: string; content: string; newDraft: string };

/** What accepting `it` does to `draft`. `tokenStart` is the "@token" start for mention rows. */
export function acceptOf(it: MenuItem, draft: string, tokenStart?: number): Accept | null {
  const stripped = draftRemovingLastToken(draft);
  switch (it.kind) {
    case "command": return { type: "replaceDraft", text: it.insert ?? it.label };
    case "skill":
    case "subagent": {
      const directive = (it.insert ?? it.label).trim();
      return { type: "useDirective", id: it.id, name: it.label, directive, newDraft: stripped };
    }
    case "librarySkill": return it.skillId ? { type: "useSkill", id: it.skillId, name: it.label, newDraft: stripped } : null;
    case "hook":
    case "mcp": return it.target ? { type: "navigate", target: it.target, newDraft: stripped } : null;
    case "mode": return it.mode ? { type: "setMode", mode: it.mode, newDraft: stripped } : null;
    case "model": return it.model ? { type: "setModel", provider: it.model.provider, model: it.model.model, newDraft: stripped } : null;
    case "file": {
      if (!it.path) return null;
      const before = tokenStart === undefined ? stripped : draft.slice(0, tokenStart);
      // A folder keeps browsing: the token becomes "@dir/" and the menu stays open on its children.
      if (it.isDir) return { type: "replaceDraft", text: `${before}@${it.path.replace(/\/+$/, "")}/`, keepOpen: true };
      return { type: "attachFile", path: it.path, newDraft: before };
    }
    case "note": {
      if (!it.path) return null;
      const before = tokenStart === undefined ? stripped : draft.slice(0, tokenStart);
      return { type: "attachNote", id: it.path, label: it.label, content: it.insert ?? it.label, newDraft: before };
    }
  }
}

/** Chip shown in the composer for an invoked skill (one message only). */
export interface SkillChip { id: string; name: string; kind: "directive" | "library"; directive?: string }

export const MAX_SKILL_CHIPS = 5; // the server accepts at most 5 invoked skill ids

export function skillChipLabel(c: SkillChip): string { return safeLine(c.name, 60); }
