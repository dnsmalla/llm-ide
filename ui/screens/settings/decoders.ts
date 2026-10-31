// Typed decoders for every response Settings reads. They validate the shape at the
// boundary (a wrong or hostile answer becomes DecodeError, never a half-typed object) and
// keep only the fields the screen uses. Fixtures in schema/http/fixtures pin them (tests).

export class DecodeError extends Error {
  constructor(where: string, expected: string) {
    super(`bad response at ${where}: expected ${expected}`);
    this.name = "DecodeError";
  }
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);

function rec(v: unknown, at: string): Rec {
  if (!isRec(v)) throw new DecodeError(at, "object");
  return v;
}
function str(v: unknown, at: string): string {
  if (typeof v !== "string") throw new DecodeError(at, "string");
  return v;
}
function num(v: unknown, at: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new DecodeError(at, "number");
  return v;
}
function bool(v: unknown, at: string): boolean {
  if (typeof v !== "boolean") throw new DecodeError(at, "boolean");
  return v;
}
function arr(v: unknown, at: string): unknown[] {
  if (!Array.isArray(v)) throw new DecodeError(at, "array");
  return v;
}
const optStr = (v: unknown, at: string): string | undefined => (v == null ? undefined : str(v, at));
const optNum = (v: unknown, at: string): number | undefined => (v == null ? undefined : num(v, at));
const strList = (v: unknown, at: string): string[] => arr(v, at).map((x, i) => str(x, `${at}[${i}]`));

// ---- Providers -------------------------------------------------------------------------

export interface Connection {
  id: string;
  provider: string;
  catalogId: string;
  name: string;
  baseURL: string;
  allowPrivate: boolean;
  enabled: boolean;
  hasKey: boolean;
}
export interface CatalogProvider {
  id: string;
  name: string;
  baseURL: string;
  keyRequired: boolean;
  local: boolean;
  customBaseURL: boolean;
  allowPrivate: boolean;
  docsUrl: string;
  notes: string;
  connections: Connection[];
}
export interface FallbackEntry {
  provider: string;
  model?: string;
}
export interface ProviderSettings {
  toolsEnabled: boolean;
  fallbackEnabled: boolean;
  fallbackOrder: FallbackEntry[];
  toolOverrides: Record<string, boolean>;
  egressAutoApprove: boolean;
}
export interface Catalog {
  providers: CatalogProvider[];
  settings: ProviderSettings;
}

export function decodeConnection(v: unknown, at = "connection"): Connection {
  const r = rec(v, at);
  return {
    id: str(r.id, `${at}.id`),
    provider: str(r.provider, `${at}.provider`),
    catalogId: str(r.catalogId, `${at}.catalogId`),
    name: str(r.name, `${at}.name`),
    baseURL: str(r.baseURL, `${at}.baseURL`),
    allowPrivate: bool(r.allowPrivate, `${at}.allowPrivate`),
    enabled: bool(r.enabled, `${at}.enabled`),
    hasKey: bool(r.hasKey, `${at}.hasKey`),
  };
}

export function decodeProviderSettings(v: unknown, at = "settings"): ProviderSettings {
  const r = rec(v, at);
  const overrides: Record<string, boolean> = {};
  for (const [k, x] of Object.entries(rec(r.toolOverrides, `${at}.toolOverrides`))) overrides[k] = bool(x, `${at}.toolOverrides.${k}`);
  return {
    toolsEnabled: bool(r.toolsEnabled, `${at}.toolsEnabled`),
    fallbackEnabled: bool(r.fallbackEnabled, `${at}.fallbackEnabled`),
    fallbackOrder: arr(r.fallbackOrder, `${at}.fallbackOrder`).map((e, i) => {
      const x = rec(e, `${at}.fallbackOrder[${i}]`);
      const model = optStr(x.model, `${at}.fallbackOrder[${i}].model`);
      return model === undefined ? { provider: str(x.provider, "provider") } : { provider: str(x.provider, "provider"), model };
    }),
    toolOverrides: overrides,
    egressAutoApprove: bool(r.egressAutoApprove, `${at}.egressAutoApprove`),
  };
}

export function decodeCatalog(v: unknown): Catalog {
  const r = rec(v, "catalog");
  return {
    providers: arr(r.providers, "catalog.providers").map((p, i) => {
      const x = rec(p, `providers[${i}]`);
      return {
        id: str(x.id, "id"),
        name: str(x.name, "name"),
        baseURL: str(x.baseURL, "baseURL"),
        keyRequired: bool(x.keyRequired, "keyRequired"),
        local: bool(x.local, "local"),
        customBaseURL: bool(x.customBaseURL, "customBaseURL"),
        allowPrivate: bool(x.allowPrivate, "allowPrivate"),
        docsUrl: str(x.docsUrl, "docsUrl"),
        notes: str(x.notes, "notes"),
        connections: arr(x.connections, "connections").map((c, j) => decodeConnection(c, `providers[${i}].connections[${j}]`)),
      };
    }),
    settings: decodeProviderSettings(r.settings, "catalog.settings"),
  };
}

export function decodeConnectResult(v: unknown): Connection {
  const r = rec(v, "connect");
  if (r.ok !== true) throw new DecodeError("connect.ok", "true");
  return decodeConnection(r.connection, "connect.connection");
}

/** A Claude-compatible (Anthropic Messages) endpoint from GET /kb/providers/custom. No key field exists: only `hasKey`. */
export interface CustomEndpoint {
  id: string;
  /** Dispatch id, custom:ac-... (connections) or custom:<id> (synced). */
  provider: string;
  name: string;
  baseURL: string;
  allowPrivate: boolean;
  enabled: boolean;
  hasKey: boolean;
  /** `connection`: managed here. `synced`: the Mac app's custom provider with an Anthropic door, read-only. */
  source: "connection" | "synced";
}

/** Strict: any malformed row fails the whole list (a half-typed endpoint is never shown). Only these fields are kept. */
export function decodeCustomEndpoints(v: unknown): CustomEndpoint[] {
  const r = rec(v, "custom");
  return arr(r.providers, "custom.providers").map((p, i) => {
    const x = rec(p, `custom.providers[${i}]`);
    const source = str(x.source, `custom.providers[${i}].source`);
    if (source !== "connection" && source !== "synced") throw new DecodeError(`custom.providers[${i}].source`, "connection or synced");
    return {
      id: str(x.id, `custom.providers[${i}].id`),
      provider: str(x.provider, `custom.providers[${i}].provider`),
      name: str(x.name, `custom.providers[${i}].name`),
      baseURL: str(x.baseURL, `custom.providers[${i}].baseURL`),
      allowPrivate: bool(x.allowPrivate, `custom.providers[${i}].allowPrivate`),
      enabled: bool(x.enabled, `custom.providers[${i}].enabled`),
      hasKey: bool(x.hasKey, `custom.providers[${i}].hasKey`),
      source,
    };
  });
}

export interface TestResult {
  ok: boolean;
  /** The server's sentence about the check. Shown only through describeTestDetail (see providers-model). */
  detail: string;
  modelCount?: number;
}
export function decodeTestResult(v: unknown): TestResult {
  const r = rec(v, "test");
  const modelCount = optNum(r.modelCount, "test.modelCount");
  const out: TestResult = { ok: bool(r.ok, "test.ok"), detail: str(r.detail, "test.detail") };
  if (modelCount !== undefined) out.modelCount = modelCount;
  return out;
}

export type ToolsSource = "catalog" | "provider" | "inferred" | "pattern" | "override" | "unknown";
export interface ModelCapability {
  id: string;
  toolsSupported: boolean;
  toolsSource: ToolsSource;
  streaming: boolean;
  contextWindow: number | null;
}
export interface ModelList {
  models: ModelCapability[];
  source: "live" | "cache" | "static";
}
const TOOLS_SOURCES: readonly string[] = ["catalog", "provider", "inferred", "pattern", "override", "unknown"];
export function decodeModelList(v: unknown): ModelList {
  const r = rec(v, "models");
  const source = str(r.source, "models.source");
  if (source !== "live" && source !== "cache" && source !== "static") throw new DecodeError("models.source", "live|cache|static");
  return {
    source,
    models: arr(r.models, "models.models").map((m, i) => {
      const x = rec(m, `models[${i}]`);
      const ts = str(x.toolsSource, "toolsSource");
      return {
        id: str(x.id, "id"),
        toolsSupported: bool(x.toolsSupported, "toolsSupported"),
        toolsSource: (TOOLS_SOURCES.includes(ts) ? ts : "unknown") as ToolsSource,
        streaming: bool(x.streaming, "streaming"),
        contextWindow: x.contextWindow == null ? null : num(x.contextWindow, "contextWindow"),
      };
    }),
  };
}

export function decodeRemoved(v: unknown): boolean {
  const r = rec(v, "disconnect");
  return bool(r.removed, "disconnect.removed");
}

// ---- Model routing ---------------------------------------------------------------------

export interface TierChoice {
  provider: string;
  model: string;
}
export interface TierStatus {
  usable: boolean;
  agentCapable?: boolean;
  agentReason?: string;
  via?: string;
  reason?: string;
}
export interface RoutingTiers {
  tiers: Record<string, TierChoice>;
  features: Record<string, string>;
  status: Record<string, TierStatus>;
  featureStatus: Record<string, TierStatus>;
}
function decodeStatus(v: unknown, at: string): TierStatus {
  const x = rec(v, at);
  const out: TierStatus = { usable: bool(x.usable, `${at}.usable`) };
  if (x.agentCapable != null) out.agentCapable = bool(x.agentCapable, `${at}.agentCapable`);
  const agentReason = optStr(x.agentReason, `${at}.agentReason`);
  const via = optStr(x.via, `${at}.via`);
  const reason = optStr(x.reason, `${at}.reason`);
  if (agentReason !== undefined) out.agentReason = agentReason;
  if (via !== undefined) out.via = via;
  if (reason !== undefined) out.reason = reason;
  return out;
}
export function decodeRoutingTiers(v: unknown): RoutingTiers {
  const r = rec(v, "routing");
  const tiers: Record<string, TierChoice> = {};
  for (const [k, t] of Object.entries(rec(r.tiers, "routing.tiers"))) {
    const x = rec(t, `tiers.${k}`);
    tiers[k] = { provider: str(x.provider, "provider"), model: str(x.model, "model") };
  }
  const features: Record<string, string> = {};
  for (const [k, t] of Object.entries(rec(r.features, "routing.features"))) features[k] = str(t, `features.${k}`);
  const status: Record<string, TierStatus> = {};
  for (const [k, t] of Object.entries(rec(r.status, "routing.status"))) status[k] = decodeStatus(t, `status.${k}`);
  const featureStatus: Record<string, TierStatus> = {};
  for (const [k, t] of Object.entries(rec(r.featureStatus, "routing.featureStatus"))) featureStatus[k] = decodeStatus(t, `featureStatus.${k}`);
  return { tiers, features, status, featureStatus };
}
export interface RoutingSaveResult {
  dropped: { entry: string; reason: string }[];
}
export function decodeRoutingSave(v: unknown): RoutingSaveResult {
  const r = rec(v, "routing-save");
  if (r.success !== true) throw new DecodeError("routing-save.success", "true");
  return {
    dropped: arr(r.dropped ?? [], "dropped").map((d, i) => {
      const x = rec(d, `dropped[${i}]`);
      return { entry: str(x.entry, "entry"), reason: str(x.reason, "reason") };
    }),
  };
}

// ---- Agent history and storage ----------------------------------------------------------

export interface AgentHistorySettings {
  retentionDays: number;
  rollupKeepDays: number;
  min: number;
  max: number;
}
export function decodeAgentHistorySettings(v: unknown): AgentHistorySettings {
  const r = rec(v, "history-settings");
  return {
    retentionDays: num(r.retentionDays, "retentionDays"),
    rollupKeepDays: num(r.rollupKeepDays, "rollupKeepDays"),
    min: num(r.min, "min"),
    max: num(r.max, "max"),
  };
}

export interface StorageGroup {
  key: string;
  label: string;
  rows: number;
  bytes: number | null;
  bytesApprox: boolean;
  lastCleanedAt: string | null;
  retentionDays: number | null;
  actions: string[];
}
export interface StorageReport {
  generatedAt: string;
  groups: StorageGroup[];
  agentStoreState: string | null;
}
export function decodeStorageReport(v: unknown): StorageReport {
  const r = rec(v, "storage");
  const store = isRec(r.agentStore) ? r.agentStore : null;
  return {
    generatedAt: str(r.generatedAt, "generatedAt"),
    groups: arr(r.groups, "groups").map((g, i) => {
      const x = rec(g, `groups[${i}]`);
      return {
        key: str(x.key, "key"),
        label: str(x.label, "label"),
        rows: num(x.rows, "rows"),
        bytes: x.bytes == null ? null : num(x.bytes, "bytes"),
        bytesApprox: x.bytesApprox === true,
        lastCleanedAt: x.lastCleanedAt == null ? null : str(x.lastCleanedAt, "lastCleanedAt"),
        retentionDays: x.retentionDays == null ? null : num(x.retentionDays, "retentionDays"),
        actions: x.actions == null ? [] : strList(x.actions, "actions"),
      };
    }),
    agentStoreState: store && typeof store.state === "string" ? store.state : null,
  };
}

export type ClearScope = "raw" | "all";
export type ClearCounts = Record<string, number>;
export interface ClearResult {
  dryRun: boolean;
  scope: ClearScope;
  beforeDays: number | null;
  counts: ClearCounts;
  total: number;
  previewId?: string;
  expiresAt?: string;
}
export function decodeClearResult(v: unknown): ClearResult {
  const r = rec(v, "clear");
  const scope = str(r.scope, "scope");
  if (scope !== "raw" && scope !== "all") throw new DecodeError("clear.scope", "raw|all");
  const countsRaw = r.dryRun === true ? r.wouldDelete : r.deleted;
  const counts: ClearCounts = {};
  if (countsRaw != null) for (const [k, n] of Object.entries(rec(countsRaw, "counts"))) counts[k] = num(n, `counts.${k}`);
  const out: ClearResult = {
    dryRun: bool(r.dryRun, "dryRun"),
    scope,
    beforeDays: r.beforeDays == null ? null : num(r.beforeDays, "beforeDays"),
    counts,
    total: num(r.total, "total"),
  };
  const previewId = optStr(r.previewId, "previewId");
  const expiresAt = optStr(r.expiresAt, "expiresAt");
  if (previewId !== undefined) out.previewId = previewId;
  if (expiresAt !== undefined) out.expiresAt = expiresAt;
  return out;
}

export interface CompactResult {
  mode: string;
  pagesFreed: number;
  bytesBefore: number;
  bytesAfter: number;
}
export function decodeCompactResult(v: unknown): CompactResult {
  const r = rec(v, "compact");
  return {
    mode: str(r.mode, "mode"),
    pagesFreed: num(r.pagesFreed, "pagesFreed"),
    bytesBefore: num(r.bytesBefore, "bytesBefore"),
    bytesAfter: num(r.bytesAfter, "bytesAfter"),
  };
}

// ---- Extensions trust -------------------------------------------------------------------

export interface WorkspaceTrustItem {
  path: string;
  trusted: boolean;
  updatedAt: string;
}
export interface WorkspaceTrustList {
  enforced: boolean;
  items: WorkspaceTrustItem[];
}
function decodeTrustItem(v: unknown, at: string): WorkspaceTrustItem {
  const x = rec(v, at);
  return { path: str(x.path, `${at}.path`), trusted: bool(x.trusted, `${at}.trusted`), updatedAt: str(x.updatedAt, `${at}.updatedAt`) };
}
export function decodeWorkspaceTrustList(v: unknown): WorkspaceTrustList {
  const r = rec(v, "workspace-trust");
  return {
    enforced: bool(r.enforced, "enforced"),
    items: arr(r.items, "items").map((x, i) => decodeTrustItem(x, `items[${i}]`)),
  };
}
export function decodeWorkspaceTrustSet(v: unknown): WorkspaceTrustItem {
  const r = rec(v, "workspace-trust-set");
  return decodeTrustItem(r.item, "item");
}

export interface Allowlist {
  operator: string[];
  /** null: the operator set no ceiling. */
  ceiling: string[] | null;
  user: string[];
  ignored: string[];
  effective: string[];
}
export function decodeAllowlist(v: unknown): Allowlist {
  const r = rec(v, "allowlist");
  return {
    operator: strList(r.operator, "operator"),
    ceiling: r.ceiling == null ? null : strList(r.ceiling, "ceiling"),
    user: strList(r.user, "user"),
    ignored: strList(r.ignored ?? [], "ignored"),
    effective: strList(r.effective, "effective"),
  };
}

// ---- Account, health, secrets -----------------------------------------------------------

export interface Me {
  id: string;
  email: string;
  displayName: string;
  role: string;
}
export function decodeMe(v: unknown): Me {
  const r = rec(v, "me");
  return { id: str(r.id, "id"), email: str(r.email, "email"), displayName: str(r.displayName, "displayName"), role: str(r.role, "role") };
}

export interface Health {
  status: string;
  apiVersion: number;
  schemaVersion: number | null;
  /** null: every feature is on (LLMIDE_FEATURES unset). */
  features: string[] | null;
  checks: Record<string, boolean>;
}
export function decodeHealth(v: unknown): Health {
  const r = rec(v, "health");
  const checks: Record<string, boolean> = {};
  if (isRec(r.checks)) for (const [k, x] of Object.entries(r.checks)) if (typeof x === "boolean") checks[k] = x;
  return {
    status: str(r.status, "status"),
    apiVersion: num(r.apiVersion, "apiVersion"),
    schemaVersion: r.schemaVersion == null ? null : num(r.schemaVersion, "schemaVersion"),
    features: r.features == null ? null : strList(r.features, "features"),
    checks,
  };
}

/** Vault listing: key NAMES only (the server never returns a value). */
export function decodeSecretNames(v: unknown): string[] {
  const r = rec(v, "secrets");
  return arr(r.secrets, "secrets").map((s, i) => str(rec(s, `secrets[${i}]`).key, "key"));
}

export interface SdkStatus {
  running: string | null;
  restartNeeded: boolean;
}
export function decodeSdkStatus(v: unknown): SdkStatus {
  const r = rec(v, "agent-sdk");
  return { running: optStr(r.running, "running") ?? null, restartNeeded: r.restartNeeded === true };
}

// ---- Mirror-the-Mac groups: Claude Agent SDK, Tool permissions, General preferences -------------

export interface AgentSdkStatus {
  running: string | null;
  installed: string | null;
  latest: string | null;
  updateAvailable: boolean;
  restartNeeded: boolean;
  updating: boolean;
  /** False while remote access is on (an update runs npm on the host). */
  canUpdate: boolean;
  /** Why the registry could not be read (a short status, shown as text). */
  error: string | null;
}
export function decodeAgentSdk(v: unknown): AgentSdkStatus {
  const r = rec(v, "agent-sdk");
  return {
    running: optStr(r.running, "running") ?? null,
    installed: optStr(r.installed, "installed") ?? null,
    latest: optStr(r.latest, "latest") ?? null,
    updateAvailable: r.updateAvailable === true,
    restartNeeded: r.restartNeeded === true,
    updating: r.updating === true,
    canUpdate: r.canUpdate !== false,
    error: optStr(r.error, "error") ?? null,
  };
}

export interface AgentSdkUpdate {
  ok: boolean;
  from: string | null;
  to: string | null;
  rolledBack: boolean;
  restartNeeded: boolean;
  log: string | null;
}
export function decodeAgentSdkUpdate(v: unknown): AgentSdkUpdate {
  const r = rec(v, "agent-sdk update");
  return {
    ok: bool(r.ok, "ok"),
    from: optStr(r.from, "from") ?? null,
    to: optStr(r.to, "to") ?? null,
    rolledBack: r.rolledBack === true,
    restartNeeded: r.restartNeeded === true,
    log: optStr(r.log, "log") ?? null,
  };
}

export interface ToolRule {
  projectRoot: string;
  toolName: string;
  /** Empty = the whole tool. */
  pattern: string;
  grantedAt: string;
}
export interface LegacyGrant {
  toolName: string;
  grantedAt: string;
}
export interface ToolPermissions {
  rules: ToolRule[];
  /** Pre-project global grants: no longer honoured by the server, still listed so they can be removed. */
  legacy: LegacyGrant[];
}
export function decodeToolPermissions(v: unknown): ToolPermissions {
  const r = rec(v, "tool-approvals");
  return {
    // `rules` is absent on a server older than the project-scoped rules.
    rules: r.rules == null ? [] : arr(r.rules, "rules").map((x, i) => {
      const o = rec(x, `rules[${i}]`);
      return { projectRoot: str(o.projectRoot, "projectRoot"), toolName: str(o.toolName, "toolName"), pattern: typeof o.pattern === "string" ? o.pattern : "", grantedAt: str(o.grantedAt, "grantedAt") };
    }),
    legacy: r.approvals == null ? [] : arr(r.approvals, "approvals").map((x, i) => {
      const o = rec(x, `approvals[${i}]`);
      return { toolName: str(o.toolName, "toolName"), grantedAt: str(o.grantedAt, "grantedAt") };
    }),
  };
}

export interface UserPrefs {
  language: string | null;
  bilingual: boolean | null;
  /** Unset means on (the server's default). */
  nativePlugins: boolean | null;
}
export function decodeUserPrefs(v: unknown): UserPrefs {
  const p = rec(rec(v, "prefs").prefs, "prefs.prefs");
  return {
    language: optStr(p.language, "language") ?? null,
    bilingual: p.bilingual == null ? null : bool(p.bilingual, "bilingual"),
    nativePlugins: p.nativePlugins == null ? null : bool(p.nativePlugins, "nativePlugins"),
  };
}
