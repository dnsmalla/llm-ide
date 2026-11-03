// Named prompt templates for Auto Tasks (the Mac's AutoTask template store): a local, bounded set of reusable
// prompts. The task's built-in prompt is not a template and is never overwritten.
export interface PromptTemplate {
  id: string;
  name: string;
  prompt: string;
}

export const TEMPLATES_KEY = "llmide.autoTaskTemplates.v1";
export const MAX_TEMPLATES = 50;
export const MAX_TEMPLATE_NAME = 80;
export const MAX_TEMPLATE_PROMPT = 20_000;

type Store = Pick<Storage, "getItem" | "setItem">;
const defaultStore = (): Store | undefined => (typeof localStorage === "undefined" ? undefined : localStorage);

export function loadTemplates(storage: Store | undefined = defaultStore()): PromptTemplate[] {
  try {
    const raw = storage?.getItem(TEMPLATES_KEY);
    const v: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(v)) return [];
    return v.filter((x): x is PromptTemplate => !!x && typeof x === "object"
      && typeof (x as PromptTemplate).id === "string"
      && typeof (x as PromptTemplate).name === "string"
      && typeof (x as PromptTemplate).prompt === "string")
      .slice(0, MAX_TEMPLATES);
  } catch { return []; }
}

export function saveTemplates(list: readonly PromptTemplate[], storage: Store | undefined = defaultStore()): void {
  try { storage?.setItem(TEMPLATES_KEY, JSON.stringify(list.slice(0, MAX_TEMPLATES))); } catch { /* session only */ }
}

/** Add or replace by name. Returns the next list and the saved entry; a blank name/prompt is refused. */
export function addTemplate(list: readonly PromptTemplate[], name: string, prompt: string, id = crypto.randomUUID()): { list: PromptTemplate[]; saved: PromptTemplate } | null {
  const n = name.trim().slice(0, MAX_TEMPLATE_NAME);
  const p = prompt.trim().slice(0, MAX_TEMPLATE_PROMPT);
  if (!n || !p) return null;
  const existing = list.find((t) => t.name.toLowerCase() === n.toLowerCase());
  const saved = { id: existing?.id ?? id, name: n, prompt: p };
  const next = [saved, ...list.filter((t) => t.id !== saved.id)].slice(0, MAX_TEMPLATES);
  return { list: next, saved };
}

export function removeTemplate(list: readonly PromptTemplate[], id: string): PromptTemplate[] {
  return list.filter((t) => t.id !== id);
}
