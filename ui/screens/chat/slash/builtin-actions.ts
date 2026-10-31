// Client-side effects of the built-in commands that are not plain navigation: "/model <name>" resolves a name to
// a model of the picker's list (id, label or unique substring); anything else asks the user to pick.
import type { BuiltinCall } from "./builtins";
import type { ModelGroupLike } from "./items";

export type ModelMatch = { provider: string; model: string };

/** Exact id or label first, then a unique case-insensitive substring; null when none or ambiguous. */
export function resolveModelArg(arg: string, groups: readonly ModelGroupLike[]): ModelMatch | null {
  const q = arg.trim().toLowerCase();
  if (!q) return null;
  const all = groups.flatMap((g) => g.models);
  const exact = all.filter((m) => m.model.toLowerCase() === q || m.label.toLowerCase() === q);
  if (exact.length === 1) return { provider: exact[0].provider, model: exact[0].model };
  const part = all.filter((m) => m.model.toLowerCase().includes(q) || m.label.toLowerCase().includes(q));
  return part.length === 1 ? { provider: part[0].provider, model: part[0].model } : null;
}

export interface BuiltinHandlers {
  clearChat(): void;
  openSection(section: string): void;
  setModel(provider: string, model: string): void;
  say(message: string): void;
}

export function runBuiltin(call: BuiltinCall, groups: readonly ModelGroupLike[], h: BuiltinHandlers): void {
  if (call.kind === "clearChat") return h.clearChat();
  if (call.kind === "openSection") return h.openSection(call.section);
  const m = resolveModelArg(call.argument, groups);
  if (m) return h.setModel(m.provider, m.model);
  h.say(call.argument ? `No single model matches "${call.argument.slice(0, 60)}". Pick one from the model list.` : "Pick a model from the model list below.");
}
