// Settings -> Model routing: the model lists behind each tier's Model picker. One list per provider,
// loaded when a provider is chosen and kept for the section's lifetime. The Anthropic list comes from
// the account's Agent SDK (POST /kb/providers/models); a catalog connection lists through
// POST /kb/providers/catalog/models by its connection id. Providers with no list endpoint get none.
import { call, type CoreClient } from "./core-api.ts";
import { describeError } from "./errors.ts";
import { modelIdProblem } from "./routing-model.ts";
import { Store } from "./store.ts";

export interface ModelOption {
  id: string;
  name: string;
}

export type ModelListEntry =
  | { status: "loading" }
  | { status: "ready"; options: ModelOption[] }
  /** `retry` is false when the provider has no list endpoint at all (asking again cannot help). */
  | { status: "failed"; detail: string; retry: boolean };

export interface ModelListsState {
  lists: Record<string, ModelListEntry>;
}

/** The select value that reveals the free-text model id box. */
export const OTHER_MODEL = "__other__";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const clipText = (v: unknown, max: number): string =>
  typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "";

/** The built-in providers' answer: `entries` (id + display name) when they yield options, else the plain `models` ids. Ids the server would drop are hidden. */
export function decodeBuiltinModels(v: unknown): { options: ModelOption[]; detail: string } {
  const o = isRecord(v) ? v : {};
  const options: ModelOption[] = [];
  const seen = new Set<string>();
  const add = (id: unknown, name: unknown) => {
    if (typeof id !== "string" || !id || seen.has(id) || modelIdProblem(id) !== null) return;
    seen.add(id);
    options.push({ id, name: clipText(name, 80) || id });
  };
  if (Array.isArray(o.entries)) for (const e of o.entries) if (isRecord(e)) add(e.id, e.displayName);
  if (options.length === 0 && Array.isArray(o.models)) for (const m of o.models) add(m, m);
  return { options, detail: clipText(o.detail, 200) };
}

/** A catalog connection's list; a row without a usable id is skipped rather than failing the whole list. */
export function decodeCatalogModels(v: unknown): ModelOption[] {
  const o = isRecord(v) ? v : {};
  const out: ModelOption[] = [];
  const seen = new Set<string>();
  for (const m of Array.isArray(o.models) ? o.models : []) {
    const id = isRecord(m) ? m.id : undefined;
    if (typeof id !== "string" || !id || seen.has(id) || modelIdProblem(id) !== null) continue;
    seen.add(id);
    out.push({ id, name: id });
  }
  return out;
}

const BUILTIN_LISTED = new Set(["anthropic", "openai", "google", "deepseek"]);

const catalogConnectionId = (provider: string): string | null => (provider.startsWith("custom:cat-") ? provider.slice("custom:".length) : null);

export class ModelListsModel extends Store<ModelListsState> {
  readonly #client: CoreClient;
  readonly #connectionIdOf: (provider: string) => string | null;
  readonly #aborts = new Map<string, AbortController>();

  /** `connectionIdOf` maps a routing provider id (`custom:cat-groq`) to its catalog connection id (`cat-groq`). */
  constructor(client: CoreClient, connectionIdOf: (provider: string) => string | null) {
    super({ lists: {} });
    this.#client = client;
    this.#connectionIdOf = connectionIdOf;
  }

  /** Loads `provider`'s models once. A ready or in-flight list is kept; a retryable failure is asked again. */
  async ensure(provider: string): Promise<void> {
    if (!provider) return;
    const have = this.getState().lists[provider];
    if (have && !(have.status === "failed" && have.retry)) return;
    const connectionId = this.#connectionIdOf(provider) ?? catalogConnectionId(provider);
    if (!connectionId && !BUILTIN_LISTED.has(provider)) {
      this.#put(provider, { status: "failed", detail: "This provider has no model list.", retry: false });
      return;
    }
    const ac = new AbortController();
    this.#aborts.set(provider, ac);
    this.#put(provider, { status: "loading" });
    try {
      const found = connectionId
        ? { options: decodeCatalogModels(await call(this.#client, "POST", "/kb/providers/catalog/models", { id: connectionId, refresh: false }, ac.signal)), detail: "" }
        : decodeBuiltinModels(await call(this.#client, "POST", "/kb/providers/models", { provider }, ac.signal));
      if (this.#aborts.get(provider) !== ac) return;
      this.#put(provider, found.options.length > 0 ? { status: "ready", options: found.options } : { status: "failed", detail: found.detail || "The server returned no models for this provider.", retry: true });
    } catch (e) {
      if (this.#aborts.get(provider) !== ac) return;
      this.#put(provider, { status: "failed", detail: describeError(e), retry: true });
    } finally {
      if (this.#aborts.get(provider) === ac) this.#aborts.delete(provider);
    }
  }

  /**
   * Cancels every in-flight request (call on unmount). Not permanent: React StrictMode runs effect, cleanup,
   * effect on the same model, so a later `ensure` must work. Entries that were still loading are removed.
   */
  dispose(): void {
    for (const ac of this.#aborts.values()) ac.abort();
    this.#aborts.clear();
    this.set({ lists: Object.fromEntries(Object.entries(this.getState().lists).filter(([, e]) => e.status !== "loading")) });
  }

  #put(provider: string, entry: ModelListEntry): void {
    this.set({ lists: { ...this.getState().lists, [provider]: entry } });
  }
}

export type PickerView =
  | { kind: "loading" }
  | { kind: "text"; note: string; retry: boolean }
  | { kind: "select"; value: string; options: ModelOption[]; showText: boolean };

/**
 * What a tier's Model cell shows. `otherForced` is set by choosing "Other" and also by typing in the text box,
 * so a typed id that equals a listed one does not close the box mid-typing. A model that is not in the list
 * keeps the box open; a failed or empty list falls back to the text box with the reason.
 */
export function pickerView(entry: ModelListEntry | undefined, model: string, otherForced: boolean): PickerView {
  if (!entry || entry.status === "loading") return { kind: "loading" };
  if (entry.status === "failed") return { kind: "text", note: entry.detail, retry: entry.retry };
  const known = model === "" || entry.options.some((o) => o.id === model);
  if (otherForced || !known) return { kind: "select", value: OTHER_MODEL, options: entry.options, showText: true };
  return { kind: "select", value: model, options: entry.options, showText: false };
}
