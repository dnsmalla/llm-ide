// The Library's older lists: Plugins (/auth/me/plugins), LLM Sources (/auth/me/llm-sources) and MCP Plugins
// (/auth/me/mcp-plugins). List, switch on/off, the two consent gates, read-only status (update checks, versions),
// read-only detail panes and the reload and per-item selection writes are here; add, remove, import and
// apply-update dialogs are parity rows (see the checklist). Same rules as the catalog screen: decoders at the boundary,
// untrusted text cleaned and capped, one request per row at a time, nothing is enabled without its consent.
import { cleanText, hasUnsafeChars } from "./sanitize.ts";
import { DecodeError } from "./decoders.ts";
import { ExtApiError, shellCode, errorText, toExtApiError, type ExtResponse } from "./errors.ts";
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
const MAX_ITEMS = 500;

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
  /** "claude" or "codex" for a vendor import, else null. */
  origin: string | null;
  sourceVersion?: string;
  commands: PluginCommand[];
  subagents: PluginSubagent[];
  unsupportedComponents: string[];
  pendingComponents: string[];
  /** Whether the Agent SDK can read this package (a .claude-plugin layout). Undefined from an older server (readable). */
  sdkReadable?: boolean;
  /** This user's "Let plugins load natively" preference. Undefined from an older server (on). */
  nativePluginsOn?: boolean;
  /** True when the agent engine loads this plugin itself (trusted, enabled, native loading on). */
  nativeDelivery: boolean;
  /** The executable kinds an earlier hook trust did not cover (empty when the trust is current or unknown). */
  trustOutdatedKinds: string[];
  /** Where a git, marketplace or zip install came from. Undefined for a plugin with no recorded provenance. */
  installSource?: InstallSource;
}
/** Provenance of an installed plugin (the server's PluginInstallSource, cleaned). */
export interface InstallSource {
  kind: string;
  url?: string;
  ref?: string;
  commit?: string;
  entry?: string;
  version?: string;
  fileName?: string;
}
function decodeInstallSource(v: unknown, at: string): InstallSource | undefined {
  if (v == null) return undefined;
  const r = rec(v, at);
  return {
    kind: r.kind == null ? "" : str(r.kind, `${at}.kind`, 20),
    url: optStr(r.url, `${at}.url`, 300),
    ref: optStr(r.ref, `${at}.ref`, 120),
    commit: optStr(r.commit, `${at}.commit`, 80),
    entry: optStr(r.entry, `${at}.entry`, 120),
    version: optStr(r.version, `${at}.version`, 60),
    fileName: optStr(r.fileName, `${at}.fileName`, 200),
  };
}
export interface PluginCommand {
  trigger: string;
  description: string;
}
export interface PluginSubagent {
  name: string;
  description: string;
}
const cleanObjects = <T>(v: unknown, at: string, cap: number, make: (r: Rec, at: string) => T): T[] => (v == null ? [] : list(v, at, cap).map((x, i) => make(rec(x, `${at}[${i}]`), `${at}[${i}]`)));
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
      origin: r.origin == null ? null : str(r.origin, `plugins[${i}].origin`, 20),
      sourceVersion: optStr(r.sourceVersion, `plugins[${i}].sourceVersion`, 60),
      commands: cleanObjects(r.commands, `plugins[${i}].commands`, 200, (c, at) => ({ trigger: str(c.trigger, `${at}.trigger`, 80), description: c.description == null ? "" : str(c.description, `${at}.description`, 300) })),
      subagents: cleanObjects(r.subagents, `plugins[${i}].subagents`, 200, (c, at) => ({ name: str(c.name, `${at}.name`, 120), description: c.description == null ? "" : str(c.description, `${at}.description`, 300) })),
      unsupportedComponents: strs(r.unsupportedComponents, `plugins[${i}].unsupportedComponents`, 20, 120),
      pendingComponents: strs(r.pendingComponents, `plugins[${i}].pendingComponents`, 20, 120),
      sdkReadable: optBool(r.sdkReadable),
      nativePluginsOn: optBool(r.nativePluginsOn),
      nativeDelivery: optBool(r.nativeDelivery) === true,
      trustOutdatedKinds: strs(r.trustOutdatedKinds, `plugins[${i}].trustOutdatedKinds`, 20, 30),
      installSource: decodeInstallSource(r.installSource, `plugins[${i}].installSource`),
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
  /** The git branch or tag a git source follows (absent for a local folder or the bundled kit). */
  ref?: string;
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
      ref: optStr(r.ref, `sources[${i}].ref`, 120),
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
  /** "v1.2.3", "unpinned" for a version-managed server with no pin, or undefined when it is not version-managed. */
  versionLabel?: string;
  /** The registry package the server runs (name only). */
  packageName?: string;
  /** Names of the environment variables the server is registered with (values are never sent to this client). */
  envKeys: string[];
  /** Names of the HTTP headers the server is registered with (the server redacts the values; this client keeps names only). */
  headerKeys: string[];
  /** True when the server declares a credential (a vault key). Its value is never sent to this client. */
  hasCredential: boolean;
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
      versionLabel: versionLabelOf(r.package, `mcp[${i}].package`),
      packageName: r.package == null ? undefined : optStr(rec(r.package, `mcp[${i}].package`).name, `mcp[${i}].package.name`, 120),
      envKeys: r.env == null ? [] : Object.keys(rec(r.env, `mcp[${i}].env`)).sort().slice(0, 40).map((k) => cleanText(k, 80)),
      headerKeys: r.headers == null ? [] : Object.keys(rec(r.headers, `mcp[${i}].headers`)).sort().slice(0, 40).map((k) => cleanText(k, 80)),
      hasCredential: typeof r.credential === "object" && r.credential !== null,
    };
  });
}
function versionLabelOf(v: unknown, at: string): string | undefined {
  if (v == null) return undefined;
  const pkg = rec(v, at);
  return typeof pkg.version === "string" && pkg.version !== "" ? `v${cleanText(pkg.version, 60)}` : "unpinned";
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

export interface ReloadResult {
  pluginDir: string;
  count: number;
  warnings: string[];
}
export function decodeReload(body: unknown): ReloadResult {
  const o = rec(body, "reload");
  return { pluginDir: optStr(o.pluginDir, "reload.pluginDir", 300) ?? "", count: count(o.count), warnings: strs(o.warnings, "reload.warnings", 20, 300) };
}

/** A read-only update report for a vendor-imported plugin (Claude or Codex). */
export interface LegacyUpdate {
  name: string;
  importedVersion?: string;
  claudeVersion?: string;
  latest?: string;
  tier?: string;
}
export function decodeLegacyUpdates(body: unknown): LegacyUpdate[] {
  const o = rec(body, "updates");
  return list(o.updates ?? [], "updates.updates", MAX_ITEMS).map((x, i) => {
    const r = rec(x, `updates[${i}]`);
    return {
      name: ident(r.name, `updates[${i}].name`),
      importedVersion: optStr(r.importedVersion, `updates[${i}].importedVersion`, 60),
      claudeVersion: optStr(r.claudeVersion, `updates[${i}].claudeVersion`, 60),
      latest: optStr(r.latest, `updates[${i}].latest`, 60),
      tier: optStr(r.tier, `updates[${i}].tier`, 40),
    };
  });
}

export interface McpVersion {
  id: string;
  current?: string;
  latest?: string;
  /** update-available | up-to-date | unpinned | unknown */
  status: string;
  reason?: string;
}
export function decodeMcpVersions(body: unknown): McpVersion[] {
  const o = rec(body, "mcp-updates");
  return list(o.servers ?? [], "mcp-updates.servers", MAX_LEGACY_ROWS).map((x, i) => {
    const r = rec(x, `servers[${i}]`);
    return {
      id: ident(r.id, `servers[${i}].id`),
      current: optStr(r.current, `servers[${i}].current`, 60),
      latest: optStr(r.latest, `servers[${i}].latest`, 60),
      status: str(r.status, `servers[${i}].status`, 30),
      reason: optStr(r.reason, `servers[${i}].reason`, 200),
    };
  });
}

/** Upstream status of one LLM source: update-available | up-to-date | local | diverged | unknown. */
export interface SourceUpdate {
  id: string;
  status: string;
  message?: string;
}
export function decodeSourceUpdates(body: unknown): SourceUpdate[] {
  const o = rec(body, "llm-updates");
  return list(o.sources ?? [], "llm-updates.sources", MAX_LEGACY_ROWS).map((x, i) => {
    const r = rec(x, `sources[${i}]`);
    return { id: ident(r.id, `sources[${i}].id`), status: str(r.status, `sources[${i}].status`, 30), message: optStr(r.message, `sources[${i}].message`, 300) };
  });
}

export interface DiscoveryItem {
  /** The exact name the server stores; sent back verbatim. */
  name: string;
  label: string;
  description: string;
  enabled: boolean;
  isNew: boolean;
}
export interface DiscoveryHook {
  event: string;
  command: string;
  matcher?: string;
}
export interface DiscoveryMcp {
  name: string;
  command: string;
  args: string[];
}
export interface Discovery {
  skills: DiscoveryItem[];
  agents: DiscoveryItem[];
  commands: DiscoveryItem[];
  templates: DiscoveryItem[];
  hooks: DiscoveryHook[];
  mcpServers: DiscoveryMcp[];
}
/** Items the server would refuse (a name it cannot store) are left out rather than shown as switchable. */
const discItems = (v: unknown, at: string): DiscoveryItem[] =>
  (v == null ? [] : list(v, at, MAX_ITEMS)).flatMap((x, i) => {
    const r = rec(x, `${at}[${i}]`);
    if (typeof r.name !== "string") throw new DecodeError(`${at}[${i}].name`, "string");
    if (r.name === "" || r.name.length > 120 || hasUnsafeChars(r.name)) return [];
    return [
      {
        name: r.name,
        label: cleanText(r.name, 120),
        description: r.description == null ? "" : str(r.description, `${at}[${i}].description`, 300),
        enabled: bool(r.enabled, `${at}[${i}].enabled`),
        isNew: optBool(r.isNew) === true,
      },
    ];
  });
export function decodeDiscovery(body: unknown): Discovery {
  const o = rec(body, "discovery");
  return {
    skills: discItems(o.skills, "discovery.skills"),
    agents: discItems(o.agents, "discovery.agents"),
    commands: discItems(o.commands, "discovery.commands"),
    templates: discItems(o.templates, "discovery.templates"),
    hooks: cleanObjects(o.hooks, "discovery.hooks", MAX_ITEMS, (h, at) => ({ event: str(h.event, `${at}.event`, 80), command: str(h.command, `${at}.command`, 300), matcher: optStr(h.matcher, `${at}.matcher`, 120) })),
    mcpServers: cleanObjects(o.mcpServers, "discovery.mcpServers", MAX_ITEMS, (m, at) => ({ name: str(m.name, `${at}.name`, 120), command: str(m.command, `${at}.command`, 300), args: strs(m.args, `${at}.args`, 20, 200) })),
  };
}
export function decodeItemsSaved(body: unknown): void {
  const o = rec(body, "items");
  if (o.ok !== true) throw new DecodeError("items.ok", "true");
}
export interface SourceUpdated {
  warnings: string[];
  added: number;
  removed: number;
}
export function decodeSourceUpdated(body: unknown): SourceUpdated {
  const o = rec(body, "update");
  if (o.ok !== true) throw new DecodeError("update.ok", "true");
  return {
    warnings: strs(o.warnings, "update.warnings", 20, 300),
    added: o.added == null ? 0 : list(o.added, "update.added", MAX_ITEMS).length,
    removed: o.removed == null ? 0 : list(o.removed, "update.removed", MAX_ITEMS).length,
  };
}

// ---- api --------------------------------------------------------------------------------------------
export interface ClaudePluginRow {
  name: string;
  version: string;
  skillCount: number;
  commandCount: number;
  alreadyImported: boolean;
  hasUpdate: boolean;
}

function decodeClaudePlugins(body: unknown): ClaudePluginRow[] {
  const o = rec(body, "claude plugins");
  return list(o.plugins ?? [], "claude.plugins", MAX_ITEMS).map((x, i) => {
    const r = rec(x, `claude.plugins[${i}]`);
    return {
      name: ident(r.name, `claude.plugins[${i}].name`),
      version: optStr(r.version, `claude.plugins[${i}].version`, 80) ?? "",
      skillCount: typeof r.skillCount === "number" && Number.isFinite(r.skillCount) && r.skillCount >= 0 ? Math.trunc(r.skillCount) : 0,
      commandCount: typeof r.commandCount === "number" && Number.isFinite(r.commandCount) && r.commandCount >= 0 ? Math.trunc(r.commandCount) : 0,
      alreadyImported: r.alreadyImported === true,
      hasUpdate: r.hasUpdate === true,
    };
  });
}

function decodeAdded(body: unknown): void {
  const o = rec(body, "added");
  if (o.plugin !== undefined && !rec(o.plugin, "added.plugin")) throw new DecodeError("added.plugin", "object");
}

function decodeRemoved(body: unknown): void {
  rec(body, "removed");
}

function decodeSourceAdded(body: unknown): void {
  const o = rec(body, "source");
  if (o.source !== undefined) rec(o.source, "source.source");
}

export interface LegacyApi {
  plugins(signal?: AbortSignal): Promise<PluginRow[]>;
  togglePlugin(name: string, enabled: boolean, signal?: AbortSignal): Promise<void>;
  trustHooks(name: string, trusted: boolean, kinds: readonly string[], signal?: AbortSignal): Promise<boolean>;
  llmSources(signal?: AbortSignal): Promise<LlmSourceRow[]>;
  toggleLlmSource(id: string, enabled: boolean, signal?: AbortSignal): Promise<void>;
  mcpPlugins(signal?: AbortSignal): Promise<McpRow[]>;
  /** Add a hand-written or catalog MCP server. The core validates and persists it switched off. */
  addMcp(input: { catalogId?: string; arg?: string; name?: string; transport?: "stdio" | "http" | "sse"; command?: string; args?: string[]; url?: string }, signal?: AbortSignal): Promise<void>;
  removeMcp(id: string, signal?: AbortSignal): Promise<void>;
  addLlmSource(input: { url?: string; path?: string; ref?: string; name?: string }, signal?: AbortSignal): Promise<void>;
  /** Claude Code plugins available to import (the Mac's "Installed in Claude" tab). */
  claudePlugins(signal?: AbortSignal): Promise<ClaudePluginRow[]>;
  claudeMarketplace(signal?: AbortSignal): Promise<ClaudePluginRow[]>;
  importClaude(name: string, source: "installed" | "marketplace", signal?: AbortSignal): Promise<void>;
  codexPlugins(signal?: AbortSignal): Promise<ClaudePluginRow[]>;
  /** Install a plugin from a public git URL (the server clones and packages it). */
  installPluginGit(url: string, ref?: string, signal?: AbortSignal): Promise<void>;
  importCodex(name: string, source: "installed" | "marketplace", signal?: AbortSignal): Promise<void>;
  removeLlmSource(id: string, signal?: AbortSignal): Promise<void>;
  consentMcp(id: string, consented: boolean, signal?: AbortSignal): Promise<void>;
  toggleMcp(id: string, enabled: boolean, signal?: AbortSignal): Promise<boolean>;
  reloadPlugins(signal?: AbortSignal): Promise<ReloadResult>;
  legacyUpdates(origin: "claude" | "codex", signal?: AbortSignal): Promise<LegacyUpdate[]>;
  mcpVersions(signal?: AbortSignal): Promise<McpVersion[]>;
  sourceUpdates(force: boolean, signal?: AbortSignal): Promise<SourceUpdate[]>;
  discovery(id: string, signal?: AbortSignal): Promise<Discovery>;
  setItems(req: { sourceId: string; kind: string; names: readonly string[]; enabled: boolean }, signal?: AbortSignal): Promise<void>;
  updateSource(id: string, signal?: AbortSignal): Promise<SourceUpdated>;
}

export function createLegacyApi(core: ExtCore): LegacyApi {
  async function call<T>(method: "GET" | "POST" | "DELETE", path: string, body: unknown, decode: (b: unknown) => T, signal?: AbortSignal): Promise<T> {
    let res: ExtResponse;
    try {
      res = await core.request(method, path, body, { signal });
    } catch (e) {
      throw new ExtApiError(0, signal?.aborted ? "ABORTED" : shellCode(e));
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
    addMcp: async (input, s) => { await call("POST", "/auth/me/mcp-plugins/add", input, decodeAdded, s); },
    removeMcp: async (id, s) => { await call("DELETE", "/auth/me/mcp-plugins/" + encodeURIComponent(id), undefined, decodeRemoved, s); },
    addLlmSource: async (input, s) => { await call("POST", "/auth/me/llm-sources/add", input, decodeSourceAdded, s); },
    claudePlugins: (s) => call("GET", "/auth/me/claude-plugins/installed", undefined, decodeClaudePlugins, s),
    claudeMarketplace: (s) => call("GET", "/auth/me/claude-plugins/marketplace", undefined, decodeClaudePlugins, s),
    importClaude: async (name, source, s) => { await call("POST", "/auth/me/claude-plugins/import", { name, source }, decodeSourceAdded, s); },
    codexPlugins: (s) => call("GET", "/auth/me/codex-plugins/installed", undefined, decodeClaudePlugins, s),
    installPluginGit: async (url, ref, s) => { await call("POST", "/auth/me/plugins/install-git", { url, ...(ref ? { ref } : {}) }, decodeAdded, s); },
    importCodex: async (name, source, s) => { await call("POST", "/auth/me/codex-plugins/import", { name, source }, decodeSourceAdded, s); },
    removeLlmSource: async (id, s) => { await call("DELETE", "/auth/me/llm-sources/" + encodeURIComponent(id), undefined, decodeRemoved, s); },
    consentMcp: async (id, consented, s) => void (await call("POST", "/auth/me/mcp-plugins/consent", { id, consented }, decodeConsented, s)),
    toggleMcp: async (id, enabled, s) => (await call("POST", "/auth/me/mcp-plugins/toggle", { id, enabled }, decodeToggled, s)).enabled,
    reloadPlugins: (s) => call("POST", "/auth/me/plugins/reload", {}, decodeReload, s),
    legacyUpdates: (origin, s) => call("GET", `/auth/me/${origin}-plugins/updates`, undefined, decodeLegacyUpdates, s),
    mcpVersions: (s) => call("GET", "/auth/me/mcp-plugins/updates", undefined, decodeMcpVersions, s),
    sourceUpdates: (force, s) => call("GET", `/auth/me/llm-sources/updates${force ? "?force=1" : ""}`, undefined, decodeSourceUpdates, s),
    discovery: (id, s) => call("GET", `/auth/me/llm-sources/${encodeURIComponent(id)}/discovery`, undefined, decodeDiscovery, s),
    setItems: async (req, s) => void (await call("POST", "/auth/me/llm-sources/items", { sourceId: req.sourceId, kind: req.kind, names: [...req.names], enabled: req.enabled }, decodeItemsSaved, s)),
    updateSource: (id, s) => call("POST", "/auth/me/llm-sources/update", { id }, decodeSourceUpdated, s),
  };
}

// ---- model ------------------------------------------------------------------------------------------
export type LegacyKind = "plugins" | "llm-sources" | "mcp-plugins";
export type LegacyRow = PluginRow | LlmSourceRow | McpRow;

export type LegacySheet =
  | { kind: "hooks"; name: string; label: string; kinds: string[]; notes: string[]; ticked: string[] }
  | { kind: "mcp"; id: string; label: string; runs: string; transport: string; ticked: boolean }
  /** Confirms an LLM source Update: the server resets a git source to its remote (or fast-forwards Central Skills). */
  | { kind: "source-update"; id: string; label: string; builtin: boolean; ref: string | null };

/** Read-only status from the core's caches, keyed by row id. A failed status read is `statusError`, never a fake "no update". */
export interface LegacyStatus {
  statusLoading: boolean;
  statusError: string | null;
  pluginUpdates: Readonly<Record<string, LegacyUpdate>>;
  mcpVersions: Readonly<Record<string, McpVersion>>;
  sourceUpdates: Readonly<Record<string, SourceUpdate>>;
}

export interface DiscoveryState {
  id: string;
  data: Discovery | null;
  error: string | null;
  loading: boolean;
}

export interface LegacyState extends LegacyStatus {
  kind: LegacyKind;
  rows: readonly LegacyRow[];
  loaded: boolean;
  loading: boolean;
  error: string | null;
  busy: readonly string[];
  notice: { text: string; error: boolean } | null;
  sheet: LegacySheet | null;
  /** The row whose detail pane is open (null: list only). */
  selected: string | null;
  discovery: DiscoveryState | null;
  /** The list's name filter and the rows ticked for a bulk switch. */
  filter: string;
  checked: readonly string[];
}

/** Rows whose id, name or description matches the filter (case-insensitive). Pure. */
export function filterRows(rows: readonly LegacyRow[], filter: string): readonly LegacyRow[] {
  const q = filter.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((r) => {
    const o = r as unknown as Record<string, unknown>;
    return [r.id, o.name, o.displayName, o.description, o.source].some((v) => typeof v === "string" && v.toLowerCase().includes(q));
  });
}

/** Status maps are keyed by server-supplied names: no prototype, so "constructor" or "__proto__" never hits. */
const byId = <T>(): Record<string, T> => Object.create(null) as Record<string, T>;

/** How long a clean status answer is reused (the Mac's PluginUpdateCenter.checkTTL). */
export const STATUS_TTL_MS = 60_000;
type StatusMaps = Pick<LegacyStatus, "pluginUpdates" | "mcpVersions" | "sourceUpdates">;
/** Per API client (one per Library), so a pane that remounts reuses the answer like the Mac's app-lifetime center. */
const statusCaches = new WeakMap<LegacyApi, Map<LegacyKind, { at: number; value: StatusMaps }>>();
function statusCacheFor(api: LegacyApi): Map<LegacyKind, { at: number; value: StatusMaps }> {
  let c = statusCaches.get(api);
  if (!c) statusCaches.set(api, (c = new Map()));
  return c;
}

/** Busy key for the header's reload (no row has this id). */
export const RELOAD_BUSY = "__reload";

type DiscoveryList = "skills" | "agents" | "commands" | "templates";
const DISCOVERY_KEY: Record<string, DiscoveryList> = { skill: "skills", agent: "agents", command: "commands", template: "templates" };

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
  private statusSeq = 0;
  private busySet = new Set<string>();
  private readonly api: LegacyApi;
  readonly kind: LegacyKind;

  constructor(api: LegacyApi, kind: LegacyKind) {
    this.api = api;
    this.kind = kind;
    this.state = {
      kind,
      rows: [],
      loaded: false,
      loading: false,
      error: null,
      busy: [],
      notice: null,
      sheet: null,
      selected: null,
      discovery: null,
      filter: "",
      checked: [],
      statusLoading: false,
      statusError: null,
      pluginUpdates: byId(),
      mcpVersions: byId(),
      sourceUpdates: byId(),
    };
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

  /** Reads the core's list (local data only), then the status (reused within its TTL unless `forceStatus`). */
  async load(forceStatus = false): Promise<void> {
    const mine = ++this.seq;
    this.set({ loading: true });
    const s = this.life.signal;
    try {
      const rows = this.kind === "plugins" ? await this.api.plugins(s) : this.kind === "llm-sources" ? await this.api.llmSources(s) : await this.api.mcpPlugins(s);
      if (mine !== this.seq) return;
      // A selected row that vanished keeps its pane, which then says it was not found.
      this.set({ rows, loaded: true, loading: false, error: null });
    } catch (e) {
      if (mine !== this.seq) return;
      if (e instanceof ExtApiError && e.code === "ABORTED") return;
      this.set({ loading: false, error: errorText(e) });
      return;
    }
    await this.loadStatus(forceStatus);
  }

  /**
   * The read-only status for this kind. Each read is independent: a failure only marks the status as unknown.
   * The Claude read runs `claude plugin list` on the core every time, so (like the Mac's PluginUpdateCenter.checkTTL)
   * a clean answer is reused for STATUS_TTL_MS across loads and remounts; `force` (reload, update) skips the reuse.
   */
  private async loadStatus(force = false): Promise<void> {
    const s = this.life.signal;
    const mine = ++this.statusSeq;
    const cache = statusCacheFor(this.api);
    const hit = cache.get(this.kind);
    if (!force && hit && Date.now() - hit.at < STATUS_TTL_MS) {
      this.set({ ...hit.value, statusError: null, statusLoading: false });
      return;
    }
    this.set({ statusLoading: true, statusError: null });
    const reads: Promise<unknown>[] =
      this.kind === "plugins"
        ? [this.api.legacyUpdates("claude", s), this.api.legacyUpdates("codex", s)]
        : this.kind === "mcp-plugins"
          ? [this.api.mcpVersions(s)]
          : [this.api.sourceUpdates(false, s)];
    // Each read stands alone: a failed Codex read keeps the Claude answers, and the failure is shown, never read as "no update".
    const settled = await Promise.allSettled(reads);
    const failure = settled.find((r): r is PromiseRejectedResult => r.status === "rejected")?.reason;
    if (this.life.signal.aborted) return;
    if (mine !== this.statusSeq) return; // a newer read owns the status
    const pluginUpdates = byId<LegacyUpdate>();
    const mcpVersions = byId<McpVersion>();
    const sourceUpdates = byId<SourceUpdate>();
    for (const r of settled) {
      if (r.status !== "fulfilled") continue;
      for (const item of r.value as (LegacyUpdate | McpVersion | SourceUpdate)[]) {
        if (this.kind === "plugins") {
          const u = item as LegacyUpdate;
          if (!pluginUpdates[u.name]) pluginUpdates[u.name] = u;
        } else if (this.kind === "mcp-plugins") {
          const v = item as McpVersion;
          mcpVersions[v.id] = v;
        } else {
          const u = item as SourceUpdate;
          sourceUpdates[u.id] = u;
        }
      }
    }
    if (failure instanceof ExtApiError && failure.code === "ABORTED") return;
    if (failure === undefined) cache.set(this.kind, { at: Date.now(), value: { pluginUpdates, mcpVersions, sourceUpdates } });
    else cache.delete(this.kind);
    this.set({ pluginUpdates, mcpVersions, sourceUpdates, statusError: failure === undefined ? null : errorText(failure), statusLoading: false });
  }

  /** Forces the upstream check of every LLM source (the core answers from its cache for anyone but an admin). */
  async checkSourceUpdates(): Promise<void> {
    if (this.kind !== "llm-sources") return;
    this.set({ statusLoading: true, statusError: null });
    try {
      const sourceUpdates = byId<SourceUpdate>();
      for (const u of await this.api.sourceUpdates(true, this.life.signal)) sourceUpdates[u.id] = u;
      this.statusSeq++; // supersedes any list-load read still in flight
      statusCacheFor(this.api).set(this.kind, { at: Date.now(), value: { pluginUpdates: byId(), mcpVersions: byId(), sourceUpdates } });
      this.set({ sourceUpdates });
    } catch (e) {
      if (!(e instanceof ExtApiError && e.code === "ABORTED")) this.set({ statusError: errorText(e) });
    } finally {
      this.set({ statusLoading: false });
    }
  }

  /** Opens (or closes, with null) a row's detail pane. An LLM source's contents are read from the core on open. */
  select(id: string | null): void {
    if (id !== null && !this.row(id)) return;
    this.set({ selected: id, discovery: null });
    if (id !== null && this.kind === "llm-sources") void this.loadDiscovery(id);
  }

  async loadDiscovery(id: string): Promise<void> {
    this.set({ discovery: { id, data: null, error: null, loading: true } });
    try {
      const data = await this.api.discovery(id, this.life.signal);
      if (this.state.selected === id) this.set({ discovery: { id, data, error: null, loading: false } });
    } catch (e) {
      if (e instanceof ExtApiError && e.code === "ABORTED") return;
      if (this.state.selected !== id) return;
      const gone = e instanceof ExtApiError && e.status === 404;
      this.set({ discovery: { id, data: null, error: gone ? "Source not found — it may have been removed." : errorText(e), loading: false } });
    }
  }

  /** Header "Reload from disk" (plugins): re-scans the plugin folder. New plugins come up switched off, with hooks untrusted. */
  async reloadPlugins(): Promise<void> {
    await this.withBusy(RELOAD_BUSY, async () => {
      try {
        const r = await this.api.reloadPlugins(this.life.signal);
        await this.load(true);
        const warn = r.warnings.length > 0 ? ` ${r.warnings.join(" ")}` : "";
        this.set({ notice: { text: `Reloaded ${r.count.toLocaleString()} ${r.count === 1 ? "plugin" : "plugins"} from disk.${warn}`, error: false } });
      } catch (e) {
        this.fail(e);
      }
    });
  }

  /** Switches items of one kind in an LLM source on or off. Only the names the discovery listed are sent. */
  async setItems(kind: string, names: readonly string[], enabled: boolean): Promise<void> {
    const d = this.state.discovery;
    const key = DISCOVERY_KEY[kind];
    if (!d?.data || !key || names.length === 0) return;
    const id = d.id;
    await this.withBusy(id, async () => {
      try {
        await this.api.setItems({ sourceId: id, kind, names, enabled }, this.life.signal);
        const picked = new Set(names);
        const data = this.state.discovery?.data;
        if (this.state.discovery?.id === id && data) {
          const next: Discovery = { ...data, [key]: data[key].map((it) => (picked.has(it.name) ? { ...it, enabled } : it)) };
          this.set({ discovery: { id, data: next, error: null, loading: false } });
        }
        this.set({ notice: { text: `${names.length} ${kind}${names.length === 1 ? "" : "s"} ${enabled ? "on" : "off"}.`, error: false } });
      } catch (e) {
        this.fail(e);
      }
    });
  }

  /** Re-pulls an already registered source. Its agents and hooks are listed only; they never run. */
  async updateSource(id: string): Promise<void> {
    await this.withBusy(id, async () => {
      try {
        const r = await this.api.updateSource(id, this.life.signal);
        await this.load(true);
        if (this.state.selected === id) await this.loadDiscovery(id);
        const warn = r.warnings.length > 0 ? ` ${r.warnings.join(" ")}` : "";
        this.set({ notice: { text: `Updated: ${r.added} added, ${r.removed} removed.${warn}`, error: false } });
      } catch (e) {
        this.fail(e);
      }
    });
  }

  /** Add an MCP server and reload the list. Returns true when the add succeeded. */
  async addMcp(input: { catalogId?: string; arg?: string; name?: string; transport?: "stdio" | "http" | "sse"; command?: string; args?: string[]; url?: string }): Promise<boolean> {
    try {
      await this.api.addMcp(input, this.life.signal);
      await this.load(true);
      this.set({ notice: { text: `Added ${input.name || input.catalogId || "MCP server"}. It is off until you consent and switch it on.`, error: false } });
      return true;
    } catch (e) {
      this.fail(e);
      return false;
    }
  }

  /** The Claude Code plugins available to import (read-only; the server scans the Claude install). */
  async claudePlugins(): Promise<ClaudePluginRow[]> {
    return this.api.claudePlugins(this.life.signal);
  }

  /** The Claude marketplace plugins available to import. */
  async claudeMarketplace(): Promise<ClaudePluginRow[]> {
    return this.api.claudeMarketplace(this.life.signal);
  }

  /** Install a plugin from a git URL and reload the list. */
  async installPluginGit(url: string, ref?: string): Promise<boolean> {
    try {
      await this.api.installPluginGit(url, ref, this.life.signal);
      await this.load(true);
      this.set({ notice: { text: `Installed plugin from ${url}. It is switched off.`, error: false } });
      return true;
    } catch (e) {
      this.fail(e);
      return false;
    }
  }

  /** Codex Code plugins available to import. */
  async codexPlugins(): Promise<ClaudePluginRow[]> {
    return this.api.codexPlugins(this.life.signal);
  }

  /** Import one Codex plugin and reload the plugin list. */
  async importCodex(name: string): Promise<boolean> {
    try {
      await this.api.importCodex(name, "installed", this.life.signal);
      await this.load(true);
      this.set({ notice: { text: `Imported Codex plugin ${name}.`, error: false } });
      return true;
    } catch (e) {
      this.fail(e);
      return false;
    }
  }

  /** Import one Claude Code plugin and reload the plugin list. */
  async importClaude(name: string, source: "installed" | "marketplace" = "installed"): Promise<boolean> {
    try {
      await this.api.importClaude(name, source, this.life.signal);
      await this.load(true);
      this.set({ notice: { text: `Imported Claude plugin ${name}.`, error: false } });
      return true;
    } catch (e) {
      this.fail(e);
      return false;
    }
  }

  /** Add a git or local LLM source and reload the list. Returns true on success. */
  async addLlmSource(input: { url?: string; path?: string; ref?: string; name?: string }): Promise<boolean> {
    try {
      await this.api.addLlmSource(input, this.life.signal);
      await this.load(true);
      this.set({ notice: { text: `Added ${input.name || input.url || input.path || "source"}.`, error: false } });
      return true;
    } catch (e) {
      this.fail(e);
      return false;
    }
  }

  /** Remove an LLM source registration. Its files are not touched. */
  async removeLlmSource(id: string): Promise<void> {
    await this.withBusy(id, async () => {
      try {
        await this.api.removeLlmSource(id, this.life.signal);
        if (this.state.selected === id) this.set({ selected: null });
        await this.load(true);
        this.set({ notice: { text: `Removed ${id}.`, error: false } });
      } catch (e) {
        this.fail(e);
      }
    });
  }

  /** Remove an MCP server from the registry. No files are touched. */
  async removeMcp(id: string): Promise<void> {
    await this.withBusy(id, async () => {
      try {
        await this.api.removeMcp(id, this.life.signal);
        if (this.state.selected === id) this.set({ selected: null });
        await this.load(true);
        this.set({ notice: { text: `Removed ${id}.`, error: false } });
      } catch (e) {
        this.fail(e);
      }
    });
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

  // ---- filter and multi-select ----------------------------------------------------------------
  setFilter(filter: string): void {
    this.set({ filter });
  }
  toggleChecked(id: string): void {
    const c = this.state.checked;
    this.set({ checked: c.includes(id) ? c.filter((x) => x !== id) : [...c, id] });
  }
  /** Ticks every row the filter shows, or clears them when all are already ticked. */
  toggleAllShown(): void {
    const shown = filterRows(this.state.rows, this.state.filter).map((r) => r.id);
    const all = shown.length > 0 && shown.every((id) => this.state.checked.includes(id));
    this.set({ checked: all ? this.state.checked.filter((id) => !shown.includes(id)) : [...new Set([...this.state.checked, ...shown])] });
  }
  clearChecked(): void {
    this.set({ checked: [] });
  }
  /**
   * Switches every ticked row on or off, one after another, through the same per-row toggle. An MCP server without
   * consent is never switched on in bulk: it is named, and its own switch asks for consent.
   */
  async bulkSwitch(on: boolean): Promise<void> {
    if (this.state.sheet) return;
    const rows = this.state.rows.filter((r) => this.state.checked.includes(r.id) && (r as { enabled: boolean }).enabled !== on);
    const needConsent = on && this.kind === "mcp-plugins" ? rows.filter((r) => !(r as McpRow).consented) : [];
    const plain = rows.filter((r) => !needConsent.includes(r));
    for (const r of plain) {
      if (this.life.signal.aborted) return;
      await this.setEnabled(r.id, on);
    }
    const changed = plain.filter((r) => (this.row(r.id) as { enabled?: boolean } | undefined)?.enabled === on).length;
    const verb = on ? "on" : "off";
    const label = (r: LegacyRow) => (r as { displayName?: string; name?: string }).displayName ?? (r as { name?: string }).name ?? r.id;
    this.set({
      checked: [],
      notice: needConsent.length
        ? { text: `Switched ${changed} ${verb}. These need your consent first, so switch each on by itself: ${needConsent.slice(0, 5).map(label).join(", ")}${needConsent.length > 5 ? ` and ${needConsent.length - 5} more` : ""}.`, error: false }
        : { text: rows.length === 0 ? `Everything selected was already ${verb}.` : `Switched ${changed} of ${rows.length} ${verb}.`, error: changed < rows.length },
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
    if (sh.kind === "source-update") return true;
    return sh.kind === "mcp" ? sh.ticked : sh.kinds.length > 0 && sh.kinds.every((k) => sh.ticked.includes(k));
  }

  /** Opens the Update confirmation for an LLM source (the Update button is the only way in; nothing runs before Confirm). */
  requestSourceUpdate(id: string): void {
    const s = this.row(id) as LlmSourceRow | undefined;
    if (!s || this.kind !== "llm-sources" || this.state.sheet || this.busySet.has(id)) return;
    this.set({ sheet: { kind: "source-update", id, label: s.name, builtin: s.builtin, ref: s.ref ?? null } });
  }

  /** Apply in the consent sheet; refused while anything is unticked; the sheet closes first so a second tap does nothing. */
  async confirm(): Promise<void> {
    const sh = this.state.sheet;
    if (!sh || !this.canConfirm) return;
    this.set({ sheet: null });
    if (sh.kind === "source-update") {
      await this.updateSource(sh.id);
      return;
    }
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
