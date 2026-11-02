// Model ids the user added ("Add model...", the Mac's MEETNOTES_CUSTOM_MODELS): kept per connection in this browser,
// joined onto that connection's group. The core takes any id as a string (routes check length and control characters
// only); the id it refuses is removed by the user (Remove) or by a refused pin (see ChatScreen).
import type { ModelChoice, ModelGroup } from "./route";

export const USER_MODELS_KEY = "chat.userModels";
export const MAX_MODEL_ID_CHARS = 100;
export const MAX_USER_MODELS_PER_CONNECTION = 50;

export type UserModels = Readonly<Record<string, readonly string[]>>;
type Store = Pick<Storage, "getItem" | "setItem">;
const defaultStore = (): Store | undefined => (typeof localStorage === "undefined" ? undefined : localStorage);

/** Trimmed; non-empty, at most 100 characters, no spaces and no control or invisible format characters. */
export function validateModelId(raw: string): { ok: true; id: string } | { ok: false; message: string } {
  const id = raw.trim();
  if (!id) return { ok: false, message: "Enter a model id." };
  if (id.length > MAX_MODEL_ID_CHARS) return { ok: false, message: `A model id is at most ${MAX_MODEL_ID_CHARS} characters.` };
  if (/[\p{C}\p{Z}]/u.test(id)) return { ok: false, message: "A model id has no spaces or control characters." };
  return { ok: true, id };
}

/** Reads the stored lists. Anything malformed reads as empty; bad entries are dropped. */
export function loadUserModels(storage: Store | undefined = defaultStore()): UserModels {
  let raw: unknown;
  try { raw = JSON.parse(storage?.getItem(USER_MODELS_KEY) || "{}"); } catch { return {}; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string[]> = {};
  for (const [group, ids] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(ids)) continue;
    const clean = [...new Set(ids.filter((x): x is string => typeof x === "string" && validateModelId(x).ok))];
    if (clean.length) out[group] = clean.slice(-MAX_USER_MODELS_PER_CONNECTION);
  }
  return out;
}

/** Best effort: a refused write only means the list is not kept after a reload. */
export function saveUserModels(models: UserModels, storage: Store | undefined = defaultStore()): void {
  try { storage?.setItem(USER_MODELS_KEY, JSON.stringify(models)); } catch { /* not kept */ }
}

export function addUserModel(models: UserModels, group: string, id: string): UserModels {
  const list = models[group] ?? [];
  if (list.includes(id)) return models;
  return { ...models, [group]: [...list, id].slice(-MAX_USER_MODELS_PER_CONNECTION) };
}

export function forgetUserModel(models: UserModels, group: string, id: string): UserModels {
  const list = (models[group] ?? []).filter((x) => x !== id);
  return { ...models, [group]: list };
}

/**
 * The list after a route PUT for `patch` failed with `err`: the added id is dropped only when the core refused the id
 * itself (400 VALIDATION_FAILED); a transient failure (core unreachable, 409, 503) keeps it. Same object when unchanged.
 */
export function afterRefusedPin(groups: readonly ModelGroup[], models: UserModels, patch: { provider?: string; model?: string }, err: unknown): UserModels {
  const e = err as { status?: unknown; code?: unknown } | null;
  if (!patch.model || e?.status !== 400 || e?.code !== "VALIDATION_FAILED") return models;
  const owner = groups.find((g) => g.provider === patch.provider && (models[g.id] ?? []).includes(patch.model!));
  return owner ? forgetUserModel(models, owner.id, patch.model) : models;
}

/** The connection an added id belongs to: the group of the composer's provider, else Claude. None for a custom provider. */
export function addTargetGroup(groups: readonly ModelGroup[], provider: string | null | undefined): ModelGroup | undefined {
  if (!provider) return groups.find((g) => !g.catalog);
  return groups.find((g) => g.provider === provider) ?? (provider === "anthropic" ? groups.find((g) => !g.catalog) : undefined);
}

/** The groups with the user's ids appended (once each) to their connection. Pure. */
export function withUserModels(groups: readonly ModelGroup[], models: UserModels): ModelGroup[] {
  return groups.map((g) => {
    const ids = models[g.id] ?? [];
    const provider = g.provider ?? g.models[0]?.provider;
    if (!ids.length || !provider) return g;
    const have = new Set(g.models.map((m) => m.model));
    const added: ModelChoice[] = ids.filter((id) => !have.has(id)).map((id) => ({ provider, model: id, label: id }));
    return added.length ? { ...g, models: [...g.models, ...added] } : g;
  });
}
