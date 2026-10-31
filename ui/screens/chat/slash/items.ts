// Menu items for the "/" menu: seven surfaces in the Mac's order (built-ins and plugin commands, agent skills,
// plugin subagents, the skill library, plugin hooks, MCP servers) plus the desktop's own two: modes and models.
// Every string that came from a plugin, a catalog or the user's notes is untrusted: it goes through `safeLine`
// (text only, bidi stripped, capped) and anything inserted into the draft through `safeToken`.
import { BUILTINS, RESERVED_NAMES, builtinDetail } from "./builtins";
import { ownedDetail, safeDirectiveName, safeLine, safeToken } from "./sanitize";
import type { Rankable } from "./rank";

export type ItemKind = "command" | "skill" | "subagent" | "librarySkill" | "hook" | "mcp" | "mode" | "model" | "file" | "note";

export interface MenuItem extends Rankable {
  id: string;
  kind: ItemKind;
  label: string;
  detail: string;
  /** command / skill / subagent: the text the draft becomes or the directive a chip carries. */
  insert: string | null;
  /** librarySkill: "<family>/<dir>" sent in `skills`. */
  skillId: string | null;
  /** hook / mcp: the Library row to open. */
  target: { kind: "plugin" | "mcp"; id: string } | null;
  /** mode / model payload. */
  mode: string | null;
  model: { provider: string; model: string } | null;
  /** file / note payload (project-relative path, or the note key). */
  path: string | null;
  isDir: boolean;
}

export const SECTION_TITLES: Record<ItemKind, string | null> = {
  command: "Commands", skill: "Skills", subagent: "Subagents", librarySkill: "Skill Library", hook: "Hooks",
  mcp: "MCP Servers", mode: "Modes", model: "Models", file: "Files", note: "Notes",
};

export function item(kind: ItemKind, id: string, label: string, detail: string, extra: Partial<MenuItem> = {}): MenuItem {
  const l = safeLine(label, 80);
  const d = safeLine(detail, 200);
  return {
    id, kind, label: l, detail: d, insert: null, skillId: null, target: null, mode: null, model: null, path: null, isDir: false,
    ...extra,
    searchLabel: (l.startsWith("/") ? l.slice(1) : l).toLowerCase(),
    searchDetail: d.toLowerCase(),
  };
}

// --- wire shapes (decoded defensively: unknown shapes are skipped, never thrown on) ----------

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
/** A hard bound on how many entries one source may contribute (a hostile plugin cannot build a 10M-row menu). */
export const MAX_ITEMS_PER_SOURCE = 20_000;

export interface PluginCommand { trigger: string; description: string; args: Array<{ name: string; required: boolean }>; pluginName: string | null }

export function decodeCommands(raw: unknown): PluginCommand[] {
  const out: PluginCommand[] = [];
  for (const c of arr(isObj(raw) ? raw.commands : null).slice(0, MAX_ITEMS_PER_SOURCE)) {
    if (!isObj(c)) continue;
    const trigger = safeToken(c.trigger);
    if (!trigger) continue;
    const args = arr(c.args).flatMap((a) => (isObj(a) && safeToken(a.name, 40) ? [{ name: a.name as string, required: a.required === true }] : []));
    out.push({ trigger, description: safeLine(c.description), args, pluginName: typeof c.pluginName === "string" ? safeLine(c.pluginName, 60) : null });
  }
  return out;
}

/** The draft a plugin command row inserts: "/trigger " plus "name=" for each required argument. */
export function commandInsert(c: PluginCommand): string {
  const req = c.args.filter((a) => a.required);
  return `/${c.trigger} ${req.length ? `${req.map((a) => `${a.name}=`).join(" ")} ` : ""}`;
}

export function buildCommandItems(commands: readonly PluginCommand[]): MenuItem[] {
  const builtin = BUILTINS.map((x) => item("command", `cmd:${x.label}`, x.label, builtinDetail(x), { insert: x.insert }));
  const plugin = commands
    .filter((c) => !RESERVED_NAMES.has(`/${c.trigger.toLowerCase()}`)) // a built-in would intercept it: listing it would be a lie
    .map((c) => item("command", `cmd:${c.trigger}`, `/${c.trigger}`, ownedDetail(c.pluginName, c.description), { insert: commandInsert(c) }));
  return builtin.concat(plugin);
}

export interface Catalog {
  skills: MenuItem[];
  subagents: MenuItem[];
}

export function buildCatalogItems(raw: unknown): Catalog {
  const skills: MenuItem[] = [];
  const subagents: MenuItem[] = [];
  const root = isObj(raw) ? raw : {};
  const sk = isObj(root.skills) ? root.skills : {};
  const pushSkill = (id: string, name: unknown, owner: unknown, desc: unknown) => {
    // The directive carries the id-shaped name only; a name with free text is not offered (it cannot be referenced safely).
    const directive = safeDirectiveName(name);
    if (!directive || skills.length >= MAX_ITEMS_PER_SOURCE) return;
    skills.push(item("skill", id, directive, ownedDetail(owner, desc), { insert: `Use the ${directive} skill:` }));
  };
  for (const s of [...arr(sk.global), ...arr(sk.internal)]) if (isObj(s)) pushSkill(`skill:${safeLine(s.name, 80)}`, s.name, null, s.description);
  for (const g of arr(sk.plugins)) {
    if (!isObj(g)) continue;
    for (const s of arr(g.skills)) if (isObj(s)) pushSkill(`skill:${safeLine(g.pluginName, 60)}:${safeLine(s.name, 80)}`, s.name, g.pluginName, s.description);
  }
  const sub = isObj(root.subagents) ? root.subagents : {};
  for (const g of arr(sub.plugins)) {
    if (!isObj(g)) continue;
    for (const s of arr(g.subagents)) {
      if (!isObj(s) || subagents.length >= MAX_ITEMS_PER_SOURCE) continue;
      const n = safeDirectiveName(s.name);
      if (n) subagents.push(item("subagent", `sub:${safeLine(g.pluginName, 60)}:${n}`, n, ownedDetail(g.pluginName, s.description), { insert: `Use the ${n} subagent:` }));
    }
  }
  return { skills, subagents };
}

/** "<family>/<dir>": the id the server resolves to a SKILL.md. Anything else is dropped. */
const LIBRARY_ID = /^[A-Za-z0-9_.-]{1,64}\/[A-Za-z0-9_.@+-]{1,128}$/;

export function buildLibraryItems(raw: unknown): MenuItem[] {
  const out: MenuItem[] = [];
  for (const s of arr(isObj(raw) ? raw.skills : null)) {
    if (!isObj(s) || typeof s.id !== "string" || !LIBRARY_ID.test(s.id) || out.length >= MAX_ITEMS_PER_SOURCE) continue;
    const name = safeLine(s.name, 80);
    if (name) out.push(item("librarySkill", `lib:${s.id}`, name, ownedDetail(s.sourceName, s.description), { skillId: s.id }));
  }
  return out;
}

export function buildHookItems(raw: unknown): MenuItem[] {
  const out: MenuItem[] = [];
  for (const p of arr(isObj(raw) ? raw.plugins : null)) {
    if (!isObj(p) || typeof p.name !== "string") continue;
    const n = typeof p.hookCount === "number" ? p.hookCount : 0;
    if (!(n > 0 || p.declaresHooks === true) || out.length >= MAX_ITEMS_PER_SOURCE) continue;
    out.push(item("hook", `hook:${safeLine(p.name, 80)}`, safeLine(p.displayName, 80) || p.name, `${n} hook${n === 1 ? "" : "s"}`, { target: { kind: "plugin", id: p.name } }));
  }
  return out;
}

export function buildMcpItems(raw: unknown): MenuItem[] {
  const out: MenuItem[] = [];
  for (const m of arr(isObj(raw) ? raw.plugins : null)) {
    if (!isObj(m) || typeof m.id !== "string" || out.length >= MAX_ITEMS_PER_SOURCE) continue;
    const status = m.enabled === true ? (m.consented === true ? "enabled" : "needs consent") : "disabled";
    out.push(item("mcp", `mcp:${m.id}`, safeLine(m.name, 80) || m.id, `${status} · ${safeLine(m.transport, 20) || "mcp"}`, { target: { kind: "mcp", id: m.id } }));
  }
  return out;
}

export interface ModeLike { id: string; label: string; hint: string }
export interface ModelGroupLike { label: string; models: Array<{ provider: string; model: string; label: string }> }

export function buildModeItems(modes: readonly ModeLike[]): MenuItem[] {
  return modes.map((m) => item("mode", `mode:${m.id}`, m.label, `Mode · ${m.hint}`, { mode: m.id }));
}

export function buildModelItems(groups: readonly ModelGroupLike[]): MenuItem[] {
  const out: MenuItem[] = [];
  for (const g of groups) for (const m of g.models) {
    if (out.length >= MAX_ITEMS_PER_SOURCE) return out;
    out.push(item("model", `model:${m.provider}:${m.model}`, m.label || m.model, `${safeLine(g.label, 40)} · ${safeLine(m.model, 80)}`, { model: { provider: m.provider, model: m.model } }));
  }
  return out;
}
