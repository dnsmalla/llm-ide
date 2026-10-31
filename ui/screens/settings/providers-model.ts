// Settings -> Providers: ONE list of model connections, with the pure rules behind it.
// Keys are write-only: they go to POST /kb/providers/catalog/connect once (the core puts
// them in the per-user vault) and the page keeps only `hasKey`.
import { ApiError, call, type CoreClient } from "./core-api.ts";
import {
  decodeCatalog,
  decodeConnectResult,
  decodeCustomEndpoints,
  decodeModelList,
  decodeProviderSettings,
  decodeRemoved,
  decodeTestResult,
  type Catalog,
  type CatalogProvider,
  type Connection,
  type CustomEndpoint,
  type ModelCapability,
  type ModelList,
  type ProviderSettings,
  type TestResult,
} from "./decoders.ts";
import { describeError } from "./errors.ts";
import { SecretField, scrubSecrets } from "./secret-field.ts";
import { Store } from "./store.ts";

export const OPENAI_KIND_LABEL = "OpenAI-compatible (adapter)";
export const CLAUDE_KIND_LABEL = "Claude-compatible (Claude engine)";

export interface ProviderRow {
  id: string;
  /** Dispatch id, custom:cat-... */
  provider: string;
  catalogId: string;
  name: string;
  baseURL: string;
  kindLabel: string;
  /** null never occurs for catalog rows; reserved for a listing that failed to load. */
  hasKey: boolean | null;
  keyRequired: boolean;
  enabled: boolean;
  allowPrivate: boolean;
  /** A Mac-synced endpoint: shown, never changed here. Absent on managed rows. */
  readOnly?: boolean;
}

/** The managed Claude-compatible endpoints and the Mac-synced ones, as rows (the key is never part of a row). */
export function rowsFromCustom(custom: readonly CustomEndpoint[]): ProviderRow[] {
  return custom.map((c) => ({
    id: c.id,
    provider: c.provider,
    catalogId: CLAUDE_COMPATIBLE_CATALOG_ID,
    name: c.name,
    baseURL: c.baseURL,
    kindLabel: CLAUDE_KIND_LABEL,
    hasKey: c.hasKey,
    keyRequired: true,
    enabled: c.enabled,
    allowPrivate: c.allowPrivate,
    ...(c.source === "synced" ? { readOnly: true } : {}),
  }));
}

/** Flattens the catalog into rows (one per connection). Linear; safe for thousands. */
export function rowsFromCatalog(catalog: Catalog): ProviderRow[] {
  const rows: ProviderRow[] = [];
  for (const p of catalog.providers) {
    for (const c of p.connections) {
      rows.push({
        id: c.id,
        provider: c.provider,
        catalogId: c.catalogId,
        name: c.name,
        baseURL: c.baseURL,
        kindLabel: OPENAI_KIND_LABEL,
        hasKey: c.hasKey,
        keyRequired: p.keyRequired,
        enabled: c.enabled,
        allowPrivate: c.allowPrivate,
      });
    }
  }
  return rows;
}

/** One line a row shows under its name. */
export function rowDetail(r: ProviderRow): string {
  return r.baseURL || "Address not set";
}

// ---- Add from catalog ---------------------------------------------------------------------

export interface AddChoice {
  /** Catalog id, or "claude-compatible" for the Anthropic-style endpoint. */
  id: string;
  name: string;
  available: boolean;
  /** Why an unavailable choice is greyed out (shown to the user). */
  unavailableReason?: string;
  kindLabel: string;
}

export const CLAUDE_COMPATIBLE_ID = "claude-compatible";
/** The catalog id the connect route takes for a Claude-compatible endpoint (hidden from GET /kb/providers/catalog). */
export const CLAUDE_COMPATIBLE_CATALOG_ID = "anthropic-compatible";

/** The entry the add form is built from: the core hides it from the catalog list, so it is described here. */
export const CLAUDE_COMPATIBLE_PROVIDER: CatalogProvider = {
  id: CLAUDE_COMPATIBLE_CATALOG_ID,
  name: "Claude-compatible endpoint",
  baseURL: "",
  keyRequired: true,
  local: false,
  customBaseURL: true,
  allowPrivate: true,
  docsUrl: "",
  notes: "",
  connections: [],
};

/** What a Claude-compatible endpoint can and cannot do, in plain words. Shown wherever one is added or listed. */
export const CLAUDE_COMPATIBLE_LIMITS: readonly string[] = [
  "Chats on this endpoint run on the Claude engine, with its tools. Use it from the chat model picker.",
  "It is not used for one-shot completions (summaries, notes) or for the model tier roles in Model routing: those send a different request format and would fail.",
  "The Claude engine connects to the address itself, so the app cannot pin or re-check what a host name resolves to at that moment. Only add gateways you trust.",
  "An http:// or private-network address needs the operator setting for private providers on the server, and your opt-in here.",
];

/** Catalog entries plus the Claude-compatible choice, which is available once the core answers GET /kb/providers/custom. */
export function addChoices(catalog: Catalog, claudeSupported = false): AddChoice[] {
  const out: AddChoice[] = catalog.providers.map((p) => ({ id: p.id, name: p.name, available: true, kindLabel: OPENAI_KIND_LABEL }));
  out.push({
    id: CLAUDE_COMPATIBLE_ID,
    name: "Claude-compatible endpoint",
    available: claudeSupported,
    ...(claudeSupported ? {} : { unavailableReason: "This core is too old to save Anthropic-style endpoints. Update the app's core (API 99), or add it in the Mac app." }),
    kindLabel: CLAUDE_KIND_LABEL,
  });
  return out;
}

/** A sentence for a refused Claude-compatible connect: the server's own text is never shown (it can echo the address). */
export function describeClaudeConnectError(e: unknown): string {
  if (e instanceof ApiError && (e.code === "VALIDATION_FAILED" || e.code === "PROVIDER_BLOCKED")) {
    return "The core did not accept that endpoint. Check that the address starts with https:// and has no user name, query or #fragment, that the key has no spaces, and that the short name is 1 to 24 lowercase letters or digits. A private-network or http:// address also needs the operator setting for private providers on the server.";
  }
  return describeError(e);
}

/** Legacy provider ids whose already-stored key the core can copy into a new connection. */
export const COPYABLE_LEGACY_KEYS: readonly string[] = ["openai", "google", "deepseek"];

export interface ConnectForm {
  catalogId: string;
  /** Typed key. Never read back into the form. */
  apiKey: SecretField;
  baseURL: string;
  slug: string;
  name: string;
  allowPrivate: boolean;
  /** Use the key already stored for the legacy provider of the same name instead of typing one. */
  copyKey: boolean;
}

export function newConnectForm(catalogId: string): ConnectForm {
  return { catalogId, apiKey: new SecretField(), baseURL: "", slug: "", name: "", allowPrivate: false, copyKey: false };
}

export interface FormIssue {
  field: "apiKey" | "baseURL" | "slug" | "name";
  message: string;
}

const SLUG = /^[a-z0-9]{1,24}$/;

function parseUrl(raw: string): URL | null {
  try {
    return new URL(raw.trim());
  } catch {
    return null;
  }
}

/** Client-side checks that mirror the server's, so most mistakes never leave the page. The server stays authoritative. */
export function validateConnect(p: CatalogProvider, f: ConnectForm): FormIssue[] {
  const issues: FormIssue[] = [];
  const hasTyped = f.apiKey.state.filled;
  const canCopy = f.copyKey && COPYABLE_LEGACY_KEYS.includes(p.id);
  if (p.keyRequired && !hasTyped && !canCopy) {
    issues.push({ field: "apiKey", message: `${p.name} needs an API key. Enter one${COPYABLE_LEGACY_KEYS.includes(p.id) ? " or copy the key you already stored" : ""}.` });
  }
  if (p.customBaseURL || f.baseURL.trim()) {
    const u = parseUrl(f.baseURL);
    if (!u || (u.protocol !== "https:" && u.protocol !== "http:")) {
      issues.push({ field: "baseURL", message: "Enter the full address, starting with https://" });
    } else if (u.protocol === "http:" && !f.allowPrivate) {
      issues.push({ field: "baseURL", message: "http:// is only allowed for a private-network address you opted into. Use https://, or tick the private-network box." });
    } else if (u.username || u.password) {
      issues.push({ field: "baseURL", message: "Do not put a user name or password in the address. Use the key field." });
    }
  }
  if (f.slug.trim() && !SLUG.test(f.slug.trim())) {
    issues.push({ field: "slug", message: "The short name is 1 to 24 lowercase letters or digits." });
  }
  if (f.name.length > 80) issues.push({ field: "name", message: "Keep the name under 80 characters." });
  return issues;
}

/** The slug a connection's id was made from (`cat-<catalog>-<slug>`, `ac-<slug>`), or null when the id has none. */
export function slugOfRow(row: ProviderRow): string | null {
  if (row.catalogId === CLAUDE_COMPATIBLE_CATALOG_ID) return row.id.startsWith("ac-") ? row.id.slice(3) : null;
  return row.id !== `cat-${row.catalogId}` ? row.id.slice(`cat-${row.catalogId}-`.length) : null;
}

export interface ConnectBody {
  catalogId: string;
  apiKey?: string;
  baseURL?: string;
  slug?: string;
  name?: string;
  allowPrivate?: boolean;
  copyKeyFrom?: string;
}

/** Builds the request body. Takes the key out of the field (clearing it). */
export function buildConnectBody(p: CatalogProvider, f: ConnectForm): ConnectBody {
  const body: ConnectBody = { catalogId: p.id };
  const typed = f.apiKey.take();
  if (typed) body.apiKey = typed;
  else if (f.copyKey && COPYABLE_LEGACY_KEYS.includes(p.id)) body.copyKeyFrom = p.id;
  if (f.baseURL.trim()) body.baseURL = f.baseURL.trim();
  if (f.slug.trim()) body.slug = f.slug.trim();
  if (f.name.trim()) body.name = f.name.trim();
  if (f.allowPrivate) body.allowPrivate = true;
  return body;
}

// ---- Words ----------------------------------------------------------------------------------

export function toolsBadge(m: ModelCapability): string | null {
  if (!m.toolsSupported) return null;
  switch (m.toolsSource) {
    case "inferred": return "tools (guessed)";
    case "pattern": return "tools (assumed)";
    case "override": return "tools (yours)";
    default: return "tools";
  }
}

export function contextText(m: ModelCapability): string | null {
  const w = m.contextWindow;
  if (w == null || w <= 0) return null;
  return w >= 1_000_000 ? `${(w / 1_000_000).toFixed(1)}M ctx` : `${Math.floor(w / 1000)}k ctx`;
}

export function overrideKey(connectionId: string, modelId: string): string {
  return `${connectionId}/${modelId}`;
}

/** What the Test button reports. The server's detail can echo provider output, so it is
 *  shown only scrubbed and shortened, behind "Technical detail". */
export function describeTest(t: TestResult): { ok: boolean; summary: string; detail: string } {
  const detail = scrubSecrets(t.detail).slice(0, 300);
  if (t.ok) {
    const n = t.modelCount;
    return { ok: true, summary: n === undefined ? "Connected." : `Connected. ${n} chat model${n === 1 ? "" : "s"} available.`, detail };
  }
  return { ok: false, summary: "The provider did not accept the check. The key may be wrong or expired, or the address cannot be reached.", detail };
}

/** Tools-capable models first, then by id; stable. */
export function sortModels(models: readonly ModelCapability[]): ModelCapability[] {
  return models.slice().sort((a, b) => Number(b.toolsSupported) - Number(a.toolsSupported) || a.id.localeCompare(b.id));
}

/** Fallback order as it should be saved: only connected providers, in order, no duplicates. */
export function cleanFallback(order: ProviderSettings["fallbackOrder"], connectedProviders: ReadonlySet<string>): ProviderSettings["fallbackOrder"] {
  const seen = new Set<string>();
  const out: ProviderSettings["fallbackOrder"] = [];
  for (const e of order) {
    const k = `${e.provider}/${e.model ?? ""}`;
    if (!connectedProviders.has(e.provider) || seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  return out;
}

// ---- API + model ----------------------------------------------------------------------------

export class ProvidersApi {
  readonly #c: CoreClient;
  constructor(client: CoreClient) {
    this.#c = client;
  }
  /** The Claude-compatible endpoints. Rejects with ApiError 404 on a core older than API 99. */
  async custom(signal?: AbortSignal): Promise<CustomEndpoint[]> {
    return decodeCustomEndpoints(await call(this.#c, "GET", "/kb/providers/custom", undefined, signal));
  }
  async catalog(signal?: AbortSignal): Promise<Catalog> {
    return decodeCatalog(await call(this.#c, "GET", "/kb/providers/catalog", undefined, signal));
  }
  async connect(body: ConnectBody): Promise<Connection> {
    return decodeConnectResult(await call(this.#c, "POST", "/kb/providers/catalog/connect", body));
  }
  async disconnect(id: string): Promise<boolean> {
    return decodeRemoved(await call(this.#c, "POST", "/kb/providers/catalog/disconnect", { id }));
  }
  async test(id: string): Promise<TestResult> {
    return decodeTestResult(await call(this.#c, "POST", "/kb/providers/catalog/test", { id }));
  }
  async models(id: string, refresh: boolean): Promise<ModelList> {
    return decodeModelList(await call(this.#c, "POST", "/kb/providers/catalog/models", { id, refresh }));
  }
  async saveSettings(patch: Partial<ProviderSettings>): Promise<ProviderSettings> {
    return decodeProviderSettings(await call(this.#c, "PUT", "/kb/providers/settings", patch));
  }
}

export interface ProvidersState {
  phase: "idle" | "loading" | "ready" | "failed";
  catalog: Catalog | null;
  rows: ProviderRow[];
  /** Claude-compatible endpoints (managed and Mac-synced). */
  custom: CustomEndpoint[];
  /** `ok`: GET /kb/providers/custom answered; `unsupported`: 404 (older core); `failed`: any other failure; `unknown`: not asked yet. */
  customRoute: "unknown" | "ok" | "unsupported" | "failed";
  error: string | null;
  /** Connection ids with a request in flight. */
  busy: ReadonlySet<string>;
  testResults: Readonly<Record<string, { ok: boolean; summary: string; detail: string }>>;
  /** The connection the user asked to remove; removal needs its name typed. */
  pendingRemove: { id: string; name: string } | null;
  adding: boolean;
}

export class ProvidersModel extends Store<ProvidersState> {
  readonly #api: ProvidersApi;
  #generation = 0;
  #abort: AbortController | null = null;

  constructor(api: ProvidersApi) {
    super({ phase: "idle", catalog: null, rows: [], custom: [], customRoute: "unknown", error: null, busy: new Set(), testResults: {}, pendingRemove: null, adding: false });
    this.#api = api;
  }

  /** Loads (or reloads) the catalog. A load that finishes after a newer one started, or after a change, is dropped. */
  async load(): Promise<void> {
    this.#abort?.abort();
    const ac = new AbortController();
    this.#abort = ac;
    const gen = ++this.#generation;
    this.set({ phase: this.getState().catalog ? "ready" : "loading", error: null });
    // The Claude-compatible list is optional: a core without the route (404) or a failure there never blocks the catalog.
    const customP = this.#api.custom(ac.signal).then(
      (custom) => ({ custom, route: "ok" as const }),
      (e: unknown) => ({ custom: null, route: e instanceof ApiError && e.status === 404 ? ("unsupported" as const) : ("failed" as const) }),
    );
    try {
      const catalog = await this.#api.catalog(ac.signal);
      const c = await customP;
      if (gen !== this.#generation) return;
      const keep = c.custom ?? (c.route === "failed" ? this.getState().custom : []);
      this.set({ phase: "ready", catalog, custom: keep, customRoute: c.route, rows: [...rowsFromCatalog(catalog), ...rowsFromCustom(keep)] });
    } catch (e) {
      if (gen !== this.#generation) return;
      this.set({ phase: this.getState().catalog ? "ready" : "failed", error: describeError(e) });
    }
  }

  /** Cancels any in-flight load (call on unmount). */
  dispose(): void {
    this.#generation++;
    this.#abort?.abort();
  }

  #mark(id: string, on: boolean): void {
    const busy = new Set(this.getState().busy);
    if (on) busy.add(id);
    else busy.delete(id);
    this.set({ busy });
  }

  async connect(provider: CatalogProvider, form: ConnectForm): Promise<boolean> {
    if (this.getState().adding) return false;
    const issues = validateConnect(provider, form);
    if (issues.length > 0) {
      this.set({ error: issues[0]!.message });
      return false;
    }
    const claude = provider.id === CLAUDE_COMPATIBLE_CATALOG_ID;
    this.set({ adding: true, error: null });
    this.#generation++; // an older load must not overwrite the new connection
    try {
      await this.#api.connect(buildConnectBody(provider, form));
      form.apiKey.clear();
      this.set({ adding: false });
      await this.load();
      return true;
    } catch (e) {
      form.apiKey.clear();
      this.set({ adding: false, error: claude ? describeClaudeConnectError(e) : describeError(e) });
      return false;
    }
  }

  async setEnabled(row: ProviderRow, enabled: boolean): Promise<void> {
    if (this.getState().busy.has(row.id) || row.readOnly) return;
    this.#mark(row.id, true);
    this.#generation++;
    try {
      // The connect route re-sends the connection; no key is sent, so the stored key is kept.
      const body: ConnectBody & { enabled: boolean } = { catalogId: row.catalogId, name: row.name, enabled };
      if (row.baseURL) body.baseURL = row.baseURL;
      const slug = slugOfRow(row);
      if (slug !== null) body.slug = slug;
      if (row.allowPrivate) body.allowPrivate = true;
      await this.#api.connect(body);
      this.set({ error: null });
      await this.load();
    } catch (e) {
      this.set({ error: describeError(e) });
    } finally {
      this.#mark(row.id, false);
    }
  }

  async test(row: ProviderRow): Promise<void> {
    if (this.getState().busy.has(row.id) || row.readOnly) return;
    this.#mark(row.id, true);
    try {
      const r = describeTest(await this.#api.test(row.id));
      this.set({ testResults: { ...this.getState().testResults, [row.id]: r } });
    } catch (e) {
      this.set({ testResults: { ...this.getState().testResults, [row.id]: { ok: false, summary: describeError(e), detail: "" } } });
    } finally {
      this.#mark(row.id, false);
    }
  }

  requestRemove(row: ProviderRow): void {
    if (row.readOnly) return;
    this.set({ pendingRemove: { id: row.id, name: row.name } });
  }
  cancelRemove(): void {
    this.set({ pendingRemove: null });
  }

  /** Removing deletes the connection and its stored key. The user must type the connection's name. */
  static confirmMatches(pending: { name: string } | null, typed: string): boolean {
    return pending !== null && typed.trim() === pending.name.trim() && pending.name.trim().length > 0;
  }

  async confirmRemove(typed: string): Promise<boolean> {
    const pending = this.getState().pendingRemove;
    if (!ProvidersModel.confirmMatches(pending, typed) || !pending) return false;
    this.set({ pendingRemove: null });
    this.#mark(pending.id, true);
    this.#generation++;
    try {
      await this.#api.disconnect(pending.id);
      this.set({ error: null });
      await this.load();
      return true;
    } catch (e) {
      this.set({ error: describeError(e) });
      return false;
    } finally {
      this.#mark(pending.id, false);
    }
  }

  async saveSettings(patch: Partial<ProviderSettings>): Promise<void> {
    const catalog = this.getState().catalog;
    if (!catalog) return;
    try {
      const settings = await this.#api.saveSettings(patch);
      const next = { ...catalog, settings };
      this.set({ catalog: next, error: null });
    } catch (e) {
      this.set({ error: describeError(e) });
    }
  }
}
