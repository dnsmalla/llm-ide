// The Library's older lists: Plugins (/auth/me/plugins), LLM Sources (/auth/me/llm-sources) and MCP Plugins
// (/auth/me/mcp-plugins). List, switch on/off and the two consent gates are here; add, remove, import and
// update dialogs are parity rows (see the checklist). Same rules as the catalog screen: decoders at the boundary,
// untrusted text cleaned and capped, one request per row at a time, nothing is enabled without its consent.
import { cleanText, hasUnsafeChars } from "./sanitize.ts";
import { DecodeError } from "./decoders.ts";
import { ExtApiError, errorText, toExtApiError, type ExtResponse } from "./errors.ts";
import type { ExtCore } from "./api.ts";

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const rec = (v: unknown, at: string): Rec => {
  if (!isRec(v)) throw new DecodeError(at, "object");
  return v;
};
const list = (v: unknown, at: string, cap: number): unknown[] => {
  if (!Array.isArray(v)) throw new DecodeError(at, "array");
  return v.length > cap ? v.slice(0, cap) : v;
};
const str = (v: unknown, at: string, max = 200): string => {
  if (typeof v !== "string") throw new DecodeError(at, "string");
  return cleanText(v, max);
};
const optStr = (v: unknown, at: string, max = 200): string | undefined => (v == null ? undefined : str(v, at, max));
const bool = (v: unknown, at: string): boolean => {
  if (typeof v !== "boolean") throw new DecodeError(at, "boolean");
  return v;
};
const optBool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);
const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.trunc(v)) : 0);
/** Identifiers go back to the server verbatim: validated, never edited. */
const ident = (v: unknown, at: string): string => {
  if (typeof v !== "string" || v === "" || v.length > 80 || hasUnsafeChars(v)) throw new DecodeError(at, "identifier");
  return v;
};
const strs = (v: unknown, at: string, cap = 50, max = 200): string[] => (v == null ? [] : list(v, at, cap).map((x, i) => str(x, `${at}[${i}]`, max)));

export const MAX_LEGACY_ROWS = 2000;

export interface PluginRow {
  id: string;
  name: string;
  displayName: string;
  description: string;
  author?: string;
  version?: string;
  enabled: boolean;
  format: string;
  hookCount: number;
  declaresHooks: boolean;
  executableKinds: string[];
  hookNotes: string[];
  hooksTrusted: boolean;
  trustOutdated: boolean;
  mcpServerCount: number;
  skillCount: number;
}
export function decodePlugins(body: unknown): PluginRow[] {
  const o = rec(body, "plugins");
  return list(o.plugins, "plugins.plugins", MAX_LEGACY_ROWS).map((x, i) => {
    const r = rec(x, `plugins[${i}]`);
    const name = ident(r.name, `plugins[${i}].name`);
    return {
      id: name,
      name,
      displayName: r.displayName == null ? name : str(r.displayName, `plugins[${i}].displayName`, 120),
      description: r.description == null ? "" : str(r.description, `plugins[${i}].description`, 300),
      author: optStr(r.author, `plugins[${i}].author`, 120),
      version: optStr(r.version, `plugins[${i}].version`, 60),
      enabled: bool(r.enabled, `plugins[${i}].enabled`),
      format: r.format == null ? "" : str(r.format, `plugins[${i}].format`, 40),
      hookCount: count(r.hookCount),
      declaresHooks: optBool(r.declaresHooks) === true,
      executableKinds: strs(r.executableKinds, `plugins[${i}].executableKinds`, 20, 30),
      hookNotes: strs(r.hookNotes, `plugins[${i}].hookNotes`, 20, 200),
      hooksTrusted: optBool(r.hooksTrusted) === true,
      trustOutdated: optBool(r.trustOutdated) === true,
      mcpServerCount: count(r.mcpServerCount),
      skillCount: count(r.skillCount),
    };
  });
}

export interface LlmSourceRow {
  id: string;
  name: string;
  origin: string;
  location: string;
  builtin: boolean;
  version?: string;
  installed: boolean;
  enabled: boolean;
  skillCount: number;
  agentCount: number;
  commandCount: number;
  templateCount: number;
  hookCount: number;
  mcpCount: number;
  disabledItemCount: number;
}
export function decodeLlmSources(body: unknown): LlmSourceRow[] {
  const o = rec(body, "llm-sources");
  return list(o.sources, "llm-sources.sources", MAX_LEGACY_ROWS).map((x, i) => {
    const r = rec(x, `sources[${i}]`);
    return {
      id: ident(r.id, `sources[${i}].id`),
      name: str(r.name, `sources[${i}].name`, 120),
      origin: r.origin == null ? "" : str(r.origin, `sources[${i}].origin`, 40),
      location: r.location == null ? "" : str(r.location, `sources[${i}].location`, 300),
      builtin: optBool(r.builtin) === true,
      version: optStr(r.version, `sources[${i}].version`, 60),
      installed: optBool(r.installed) !== false,
      enabled: bool(r.enabled, `sources[${i}].enabled`),
      skillCount: count(r.skillCount),
      agentCount: count(r.agentCount),
      commandCount: count(r.commandCount),
      templateCount: count(r.templateCount),
      hookCount: count(r.hookCount),
      mcpCount: count(r.mcpCount),
      disabledItemCount: count(r.disabledItemCount),
    };
  });
}

export interface McpRow {
  id: string;
  name: string;
  source: string;
  transport: string;
  /** What would run, as one cleaned line: the command and its arguments, or the server address. */
  runs: string;
  builtin: boolean;
  enabled: boolean;
  consented: boolean;
  credentialMissing: boolean;
  effective?: boolean;
}
export function decodeMcpPlugins(body: unknown): McpRow[] {
  const o = rec(body, "mcp-plugins");
  return list(o.plugins, "mcp-plugins.plugins", MAX_LEGACY_ROWS).map((x, i) => {
    const r = rec(x, `mcp[${i}]`);
    const transport = str(r.transport, `mcp[${i}].transport`, 20);
    const args = strs(r.args, `mcp[${i}].args`, 40, 200);
    const runs = r.command != null ? cleanText([str(r.command, `mcp[${i}].command`, 200), ...args].join(" "), 500) : r.url != null ? str(r.url, `mcp[${i}].url`, 300) : "";
    return {
      id: ident(r.id, `mcp[${i}].id`),
      name: str(r.name, `mcp[${i}].name`, 120),
      source: str(r.source, `mcp[${i}].source`, 20),
      transport,
      runs,
      builtin: bool(r.builtin, `mcp[${i}].builtin`),
      enabled: bool(r.enabled, `mcp[${i}].enabled`),
      consented: bool(r.consented, `mcp[${i}].consented`),
      credentialMissing: bool(r.credentialMissing, `mcp[${i}].credentialMissing`),
      effective: optBool(r.effective),
    };
  });
}

export function decodeToggled(body: unknown): { enabled: boolean } {
  const o = rec(body, "toggle");
  if (o.ok !== true) throw new DecodeError("toggle.ok", "true");
  return { enabled: bool(o.enabled, "toggle.enabled") };
}
export function decodeConsented(body: unknown): { consented: boolean } {
  const o = rec(body, "consent");
  if (o.ok !== true) throw new DecodeError("consent.ok", "true");
  return { consented: bool(o.consented, "consent.consented") };
}
export function decodeHookTrust(body: unknown): { hooksTrusted: boolean } {
  const o = rec(body, "hook-trust");
  if (o.ok !== true) throw new DecodeError("hook-trust.ok", "true");
  return { hooksTrusted: bool(o.hooksTrusted, "hook-trust.hooksTrusted") };
}

// ---- api --------------------------------------------------------------------------------------------
export interface LegacyApi {
  plugins(signal?: AbortSignal): Promise<PluginRow[]>;
  togglePlugin(name: string, enabled: boolean, signal?: AbortSignal): Promise<void>;
  trustHooks(name: string, trusted: boolean, kinds: readonly string[], signal?: AbortSignal): Promise<boolean>;
  llmSources(signal?: AbortSignal): Promise<LlmSourceRow[]>;
  toggleLlmSource(id: string, enabled: boolean, signal?: AbortSignal): Promise<void>;
  mcpPlugins(signal?: AbortSignal): Promise<McpRow[]>;
  consentMcp(id: string, consented: boolean, signal?: AbortSignal): Promise<void>;
  toggleMcp(id: string, enabled: boolean, signal?: AbortSignal): Promise<boolean>;
}

export function createLegacyApi(core: ExtCore): LegacyApi {
  async function call<T>(method: "GET" | "POST", path: string, body: unknown, decode: (b: unknown) => T, signal?: AbortSignal): Promise<T> {
    let res: ExtResponse;
    try {
      res = await core.request(method, path, body, { signal });
    } catch {
      throw new ExtApiError(0, signal?.aborted ? "ABORTED" : "UNREACHABLE");
    }
    if (res.status < 200 || res.status >= 300) throw toExtApiError(res);
    try {
      return decode(res.body);
    } catch (e) {
      if (e instanceof DecodeError) throw new ExtApiError(res.status, "BAD_RESPONSE");
      throw e;
    }
  }
  return {
    plugins: (s) => call("GET", "/auth/me/plugins", undefined, decodePlugins, s),
    togglePlugin: async (name, enabled, s) => void (await call("POST", "/auth/me/plugins/toggle", { name, enabled }, decodeToggled, s)),
    trustHooks: async (name, trusted, kinds, s) => (await call("POST", "/auth/me/plugins/hook-trust", trusted ? { name, trusted, kinds: [...kinds] } : { name, trusted }, decodeHookTrust, s)).hooksTrusted,
    llmSources: (s) => call("GET", "/auth/me/llm-sources", undefined, decodeLlmSources, s),
    toggleLlmSource: async (id, enabled, s) => void (await call("POST", "/auth/me/llm-sources/toggle", { id, enabled }, decodeToggled, s)),
    mcpPlugins: (s) => call("GET", "/auth/me/mcp-plugins", undefined, decodeMcpPlugins, s),
    consentMcp: async (id, consented, s) => void (await call("POST", "/auth/me/mcp-plugins/consent", { id, consented }, decodeConsented, s)),
    toggleMcp: async (id, enabled, s) => (await call("POST", "/auth/me/mcp-plugins/toggle", { id, enabled }, decodeToggled, s)).enabled,
  };
}

// ---- model ------------------------------------------------------------------------------------------
export type LegacyKind = "plugins" | "llm-sources" | "mcp-plugins";
export type LegacyRow = PluginRow | LlmSourceRow | McpRow;

export type LegacySheet =
  | { kind: "hooks"; name: string; label: string; kinds: string[]; notes: string[]; ticked: string[] }
  | { kind: "mcp"; id: string; label: string; runs: string; transport: string; ticked: boolean };

export interface LegacyState {
  kind: LegacyKind;
  rows: readonly LegacyRow[];
  loaded: boolean;
  loading: boolean;
  error: string | null;
  busy: readonly string[];
  notice: { text: string; error: boolean } | null;
  sheet: LegacySheet | null;
}

/** The kinds a hook grant covers, as the server computes them (it adds `hooks` when the plugin has hook entries). */
export function shownHookKinds(p: Pick<PluginRow, "executableKinds" | "hookCount">): string[] {
  const k = new Set(p.executableKinds);
  if (p.hookCount > 0) k.add("hooks");
  return [...k];
}

export class LegacyModel {
  private state: LegacyState;
  private listeners = new Set<() => void>();
  private life = new AbortController();
  private seq = 0;
  private busySet = new Set<string>();
  private readonly api: LegacyApi;
  readonly kind: LegacyKind;

  constructor(api: LegacyApi, kind: LegacyKind) {
    this.api = api;
    this.kind = kind;
    this.state = { kind, rows: [], loaded: false, loading: false, error: null, busy: [], notice: null, sheet: null };
  }
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getSnapshot = (): LegacyState => this.state;
  dispose(): void {
    this.life.abort();
    this.listeners.clear();
  }
  private set(patch: Partial<LegacyState>): void {
    if (this.life.signal.aborted) return;
    this.state = { ...this.state, ...patch };
    for (const l of [...this.listeners]) l();
  }
  private fail(e: unknown): void {
    if (e instanceof ExtApiError && e.code === "ABORTED") return;
    this.set({ notice: { text: errorText(e), error: true } });
  }
  dismissNotice(): void {
    this.set({ notice: null });
  }
  dismissSheet(): void {
    this.set({ sheet: null });
  }

  /** Reads the core's list (local data only). */
  async load(): Promise<void> {
    const mine = ++this.seq;
    this.set({ loading: true });
    const s = this.life.signal;
    try {
      const rows = this.kind === "plugins" ? await this.api.plugins(s) : this.kind === "llm-sources" ? await this.api.llmSources(s) : await this.api.mcpPlugins(s);
      if (mine !== this.seq) return;
      this.set({ rows, loaded: true, loading: false, error: null });
    } catch (e) {
      if (mine !== this.seq) return;
      if (e instanceof ExtApiError && e.code === "ABORTED") return;
      this.set({ loading: false, error: errorText(e) });
    }
  }

  private async withBusy(id: string, work: () => Promise<void>): Promise<void> {
    if (this.busySet.has(id)) {
      this.set({ notice: { text: "Busy, try again.", error: true } });
      return;
    }
    this.busySet.add(id);
    this.set({ busy: [...this.busySet] });
    try {
      await work();
    } finally {
      this.busySet.delete(id);
      this.set({ busy: [...this.busySet] });
    }
  }
  private patchRow(id: string, patch: Record<string, unknown>): void {
    this.set({ rows: this.state.rows.map((r) => (r.id === id ? ({ ...r, ...patch } as LegacyRow) : r)) });
  }
  private row(id: string): LegacyRow | undefined {
    return this.state.rows.find((r) => r.id === id);
  }

  /** The switch. MCP servers need their consent first (a sheet naming what would run); the others switch directly. */
  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const row = this.row(id);
    if (!row) return;
    if (this.kind === "mcp-plugins" && enabled && !(row as McpRow).consented) {
      if (this.state.sheet) return;
      const m = row as McpRow;
      this.set({ sheet: { kind: "mcp", id, label: m.name, runs: m.runs, transport: m.transport, ticked: false } });
      return;
    }
    await this.withBusy(id, async () => {
      const s = this.life.signal;
      try {
        if (this.kind === "plugins") {
          await this.api.togglePlugin(id, enabled, s);
          this.patchRow(id, { enabled });
        } else if (this.kind === "llm-sources") {
          await this.api.toggleLlmSource(id, enabled, s);
          this.patchRow(id, { enabled });
        } else {
          const now = await this.api.toggleMcp(id, enabled, s);
          this.patchRow(id, { enabled: now });
        }
        this.set({ notice: { text: `${(this.row(id) as { name: string }).name} is ${enabled ? "on" : "off"}.`, error: false } });
      } catch (e) {
        if (e instanceof ExtApiError && e.code === "CONSENT_REQUIRED") await this.load();
        this.fail(e);
      }
    });
  }

  // ---- plugin hook trust --------------------------------------------------------------------
  requestHookTrust(name: string): void {
    const p = this.row(name) as PluginRow | undefined;
    if (!p || this.kind !== "plugins" || this.state.sheet) return;
    const kinds = shownHookKinds(p);
    if (kinds.length === 0) return;
    this.set({ sheet: { kind: "hooks", name, label: p.displayName, kinds, notes: p.hookNotes, ticked: [] } });
  }
  async revokeHookTrust(name: string): Promise<void> {
    await this.withBusy(name, async () => {
      try {
        const t = await this.api.trustHooks(name, false, [], this.life.signal);
        this.patchRow(name, { hooksTrusted: t, trustOutdated: false });
        this.set({ notice: { text: "Hook trust revoked. Its hooks no longer run.", error: false } });
      } catch (e) {
        this.fail(e);
      }
    });
  }

  tickKind(kind: string, on: boolean): void {
    const sh = this.state.sheet;
    if (!sh || sh.kind !== "hooks" || !sh.kinds.includes(kind)) return;
    const set = new Set(sh.ticked);
    if (on) set.add(kind);
    else set.delete(kind);
    this.set({ sheet: { ...sh, ticked: sh.kinds.filter((k) => set.has(k)) } });
  }
  tickMcp(on: boolean): void {
    const sh = this.state.sheet;
    if (sh?.kind === "mcp") this.set({ sheet: { ...sh, ticked: on } });
  }
  get canConfirm(): boolean {
    const sh = this.state.sheet;
    if (!sh) return false;
    return sh.kind === "mcp" ? sh.ticked : sh.kinds.length > 0 && sh.kinds.every((k) => sh.ticked.includes(k));
  }

  /** Apply in the consent sheet; refused while anything is unticked; the sheet closes first so a second tap does nothing. */
  async confirm(): Promise<void> {
    const sh = this.state.sheet;
    if (!sh || !this.canConfirm) return;
    this.set({ sheet: null });
    if (sh.kind === "hooks") {
      await this.withBusy(sh.name, async () => {
        try {
          // Sends exactly the kinds that were shown and ticked; the core refuses when the plugin declares more now.
          const t = await this.api.trustHooks(sh.name, true, sh.kinds, this.life.signal);
          this.patchRow(sh.name, { hooksTrusted: t, trustOutdated: false });
          this.set({ notice: { text: "Hook trust granted for the kinds you saw.", error: false } });
        } catch (e) {
          if (e instanceof ExtApiError && e.status === 409) await this.load();
          this.fail(e);
        }
      });
      return;
    }
    await this.withBusy(sh.id, async () => {
      const s = this.life.signal;
      try {
        await this.api.consentMcp(sh.id, true, s);
        this.patchRow(sh.id, { consented: true });
        const now = await this.api.toggleMcp(sh.id, true, s);
        this.patchRow(sh.id, { enabled: now });
        this.set({ notice: { text: `${sh.label} is on.`, error: false } });
      } catch (e) {
        await this.load();
        this.fail(e);
      }
    });
  }

  async revokeMcpConsent(id: string): Promise<void> {
    await this.withBusy(id, async () => {
      try {
        await this.api.consentMcp(id, false, this.life.signal);
        await this.load(); // the core decides whether revoking also switches it off
        this.set({ notice: { text: "Consent revoked.", error: false } });
      } catch (e) {
        this.fail(e);
      }
    });
  }
}
