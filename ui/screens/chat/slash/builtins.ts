// Built-in "/" commands: a port of `ChatSlashCommands.builtins` (mac/Sources/LlmIdeMac/Core/Editor/ChatSlashCommands.swift).
// The Swift list is the single source of truth. `scripts/extract-chat-slash-builtins.mjs` reads it, and the test
// "built-ins match the Swift list" fails when this module drifts (names, aliases, descriptions, inserts, actions).
// Built-ins are CLIENT actions, never sent to the model; a plugin command with a colliding trigger is dropped
// from the menu because the built-in would intercept it first.

export type BuiltinAction =
  | { kind: "clearChat" }
  | { kind: "openSection"; section: string }
  | { kind: "switchModel" };

export interface Builtin {
  label: string;
  aliases: readonly string[];
  description: string;
  /** What the draft becomes when the row is accepted (a trailing space = type the argument now). */
  insert: string;
  action: BuiltinAction;
}

const b = (label: string, description: string, action: BuiltinAction, o: { aliases?: string[]; insert?: string } = {}): Builtin =>
  ({ label, aliases: o.aliases ?? [], description, insert: o.insert ?? label, action });

export const BUILTINS: readonly Builtin[] = [
  b("/clear", "Clear this conversation", { kind: "clearChat" }, { aliases: ["/reset", "/new"] }),
  b("/model", "Switch the model for the current provider", { kind: "switchModel" }, { insert: "/model " }),
  b("/config", "Open Settings", { kind: "openSection", section: "settings" }, { aliases: ["/settings"] }),
  b("/loop", "Open the Loop Engine", { kind: "openSection", section: "loopEngine" }),
  b("/mcp", "Open Library → MCP Plugins", { kind: "openSection", section: "library" }),
  b("/plugin", "Open Library → Plugins", { kind: "openSection", section: "library" }, { aliases: ["/plugins"] }),
  b("/agents", "Open Library → Plugins (subagents)", { kind: "openSection", section: "library" }),
  b("/hooks", "Open Library → Plugins (hook handlers & trust)", { kind: "openSection", section: "library" }),
];

/** Menu description with the aliases appended from the same array the recognisers use. */
export function builtinDetail(x: Builtin): string {
  if (x.aliases.length === 0) return x.description;
  return `${x.description} (${x.aliases.length === 1 ? "alias" : "aliases"}: ${x.aliases.join(", ")})`;
}

/** Every name (canonical + alias) a built-in answers to, lowercased. */
export const RESERVED_NAMES: ReadonlySet<string> = new Set(BUILTINS.flatMap((x) => [x.label, ...x.aliases]).map((s) => s.toLowerCase()));

const BY_NAME = new Map<string, Builtin>(BUILTINS.flatMap((x) => [x.label, ...x.aliases].map((n) => [n.toLowerCase(), x] as const)));

export type BuiltinCall =
  | { kind: "clearChat" }
  | { kind: "openSection"; section: string }
  | { kind: "switchModel"; argument: string };

/** Recognises a built-in in text as typed (whole-message, case/whitespace tolerant, like the Mac). */
export function parseBuiltin(text: string): BuiltinCall | null {
  const t = text.trim();
  if (!t.startsWith("/")) return null;
  const lower = t.toLowerCase();
  if (lower === "/model" || lower.startsWith("/model ")) return { kind: "switchModel", argument: t.slice("/model".length).trim() };
  const hit = BY_NAME.get(lower);
  if (!hit) return null;
  if (hit.action.kind === "clearChat") return { kind: "clearChat" };
  if (hit.action.kind === "openSection") return { kind: "openSection", section: hit.action.section };
  return null;
}
