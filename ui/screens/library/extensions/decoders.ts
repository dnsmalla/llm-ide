// Typed decoders for every Extensions response the screen reads. A wrong or hostile answer becomes a
// DecodeError (never a half-typed object); the fields kept are the ones the screen uses; every free-text
// field is run through `cleanText` and every list is size-capped (a catalog or a diff can be huge).
// Ids and commits are validated strictly instead of being cleaned: they go back to the server verbatim.
import { cleanText, hasUnsafeChars, isCommit } from "./sanitize.ts";

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
function arr(v: unknown, at: string, cap: number): unknown[] {
  if (!Array.isArray(v)) throw new DecodeError(at, "array");
  return v.length > cap ? v.slice(0, cap) : v;
}
function bool(v: unknown, at: string): boolean {
  if (typeof v !== "boolean") throw new DecodeError(at, "boolean");
  return v;
}
function int(v: unknown, at: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new DecodeError(at, "number");
  return Math.max(0, Math.trunc(v));
}
const optInt = (v: unknown, at: string): number | undefined => (v == null ? undefined : int(v, at));
function text(v: unknown, at: string, max = 300): string {
  if (typeof v !== "string") throw new DecodeError(at, "string");
  return cleanText(v, max);
}
const optText = (v: unknown, at: string, max = 300): string | undefined => (v == null ? undefined : text(v, at, max));
/** An identifier that is sent back to the server unchanged: any control or bidi character refuses the answer. */
function ident(v: unknown, at: string, max = 240): string {
  if (typeof v !== "string" || v === "" || v.length > max || hasUnsafeChars(v)) throw new DecodeError(at, "identifier");
  return v;
}
function commit(v: unknown, at: string): string {
  if (!isCommit(v)) throw new DecodeError(at, "40-hex commit");
  return v;
}
const strList = (v: unknown, at: string, cap = 100, max = 120): string[] => arr(v, at, cap).map((x, i) => text(x, `${at}[${i}]`, max));
const idList = (v: unknown, at: string, cap = 1000): string[] => arr(v, at, cap).map((x, i) => ident(x, `${at}[${i}]`));

// ---- limits ---------------------------------------------------------------------------------------
export const MAX_ITEMS = 5000;
export const MAX_FINDINGS = 200;
export const MAX_MEMBERS = 1000;
export const MAX_DIFF_LIST = 200;
export const MAX_CATALOG_PAGE = 100;

// ---- items ----------------------------------------------------------------------------------------
export const ITEM_KINDS = ["skill", "plugin", "mcp", "llm-source"] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

export interface Finding {
  severity: string;
  rule: string;
  file: string;
  line?: number;
  detail: string;
  excerpt?: string;
}
export interface Member {
  memberId: string;
  type: string;
  name: string;
  executable: boolean;
}
export interface Permission {
  type: string;
  executable: boolean;
  text: string;
}
export interface InstalledItem {
  id: string;
  /** One of ITEM_KINDS, or an unknown kind kept as text (listed last). */
  kind: string;
  name: string;
  description: string;
  version: string | null;
  publisherId: string;
  trust: string;
  sourceUrl: string;
  ref?: string;
  subpath?: string;
  pinnedCommit: string;
  installedAt: string;
  updatedAt?: string;
  members: Member[];
  executableKinds: string[];
  permissions: Permission[];
  scan: { count: number; byRule: Record<string, number>; findings: Finding[] };
  update?: { latest: string; checkedAt: string };
  previous?: { pinnedCommit: string; version: string | null; installedAt: string | null };
  enabled: boolean;
  disabledMembers: string[];
}

export function decodeFinding(v: unknown, at: string): Finding {
  const o = rec(v, at);
  return {
    severity: text(o.severity, `${at}.severity`, 20),
    rule: text(o.rule, `${at}.rule`, 60),
    file: text(o.file, `${at}.file`, 240),
    line: optInt(o.line, `${at}.line`),
    detail: text(o.detail, `${at}.detail`, 200),
    excerpt: optText(o.excerpt, `${at}.excerpt`, 120),
  };
}

function decodeMember(v: unknown, at: string): Member {
  const o = rec(v, at);
  return { memberId: ident(o.memberId, `${at}.memberId`), type: text(o.type, `${at}.type`, 40), name: text(o.name, `${at}.name`, 120), executable: bool(o.executable, `${at}.executable`) };
}

export function decodeItem(v: unknown, at = "item"): InstalledItem {
  const o = rec(v, at);
  const publisher = rec(o.publisher, `${at}.publisher`);
  const source = rec(o.source, `${at}.source`);
  const declared = rec(o.declared, `${at}.declared`);
  const scan = rec(o.scan, `${at}.scan`);
  const state = rec(o.state, `${at}.state`);
  const byRule: Record<string, number> = {};
  if (isRec(scan.byRule)) for (const [k, n] of Object.entries(scan.byRule).slice(0, 40)) if (typeof n === "number" && Number.isFinite(n)) byRule[cleanText(k, 60)] = Math.max(0, Math.trunc(n));
  let update: InstalledItem["update"];
  if (o.update != null) {
    const u = rec(o.update, `${at}.update`);
    update = { latest: commit(u.latest, `${at}.update.latest`), checkedAt: text(u.checkedAt, `${at}.update.checkedAt`, 40) };
  }
  let previous: InstalledItem["previous"];
  if (o.previous != null) {
    const p = rec(o.previous, `${at}.previous`);
    previous = {
      pinnedCommit: commit(p.pinnedCommit, `${at}.previous.pinnedCommit`),
      version: p.version == null ? null : text(p.version, `${at}.previous.version`, 60),
      installedAt: p.installedAt == null ? null : text(p.installedAt, `${at}.previous.installedAt`, 40),
    };
  }
  return {
    id: ident(o.id, `${at}.id`),
    kind: text(o.kind, `${at}.kind`, 30),
    name: text(o.name, `${at}.name`, 120),
    description: o.description == null ? "" : text(o.description, `${at}.description`, 300),
    version: o.version == null ? null : text(o.version, `${at}.version`, 60),
    publisherId: text(publisher.id, `${at}.publisher.id`, 120),
    trust: text(publisher.trust, `${at}.publisher.trust`, 30),
    sourceUrl: text(source.url, `${at}.source.url`, 300),
    ref: optText(source.ref, `${at}.source.ref`, 120),
    subpath: optText(o.subpath, `${at}.subpath`, 240),
    pinnedCommit: commit(o.pinnedCommit, `${at}.pinnedCommit`),
    installedAt: text(o.installedAt, `${at}.installedAt`, 40),
    updatedAt: optText(o.updatedAt, `${at}.updatedAt`, 40),
    members: arr(o.members, `${at}.members`, MAX_MEMBERS).map((m, i) => decodeMember(m, `${at}.members[${i}]`)),
    executableKinds: strList(declared.executableKinds, `${at}.declared.executableKinds`, 20, 30),
    permissions: arr(o.permissions, `${at}.permissions`, 50).map((p, i) => {
      const r = rec(p, `${at}.permissions[${i}]`);
      return { type: text(r.type, `${at}.permissions[${i}].type`, 40), executable: bool(r.executable, `${at}.permissions[${i}].executable`), text: text(r.text, `${at}.permissions[${i}].text`, 300) };
    }),
    scan: {
      count: int(scan.count, `${at}.scan.count`),
      byRule,
      findings: scan.findings == null ? [] : arr(scan.findings, `${at}.scan.findings`, MAX_FINDINGS).map((f, i) => decodeFinding(f, `${at}.scan.findings[${i}]`)),
    },
    update,
    previous,
    enabled: bool(state.enabled, `${at}.state.enabled`),
    disabledMembers: idList(state.disabledMembers, `${at}.state.disabledMembers`),
  };
}

export interface InstalledList {
  corrupt: boolean;
  items: InstalledItem[];
}
export function decodeInstalled(body: unknown): InstalledList {
  const o = rec(body, "installed");
  return { corrupt: bool(o.corrupt, "installed.corrupt"), items: arr(o.items, "installed.items", MAX_ITEMS).map((x, i) => decodeItem(x, `installed.items[${i}]`)) };
}

export interface ItemResult {
  item: InstalledItem;
  ok: boolean;
  alreadyInstalled?: boolean;
}
/** install, toggle, uninstall-less answers: `{ ok, item, alreadyInstalled? }`. */
export function decodeItemResult(body: unknown): ItemResult {
  const o = rec(body, "result");
  return { ok: bool(o.ok, "result.ok"), item: decodeItem(o.item, "result.item"), alreadyInstalled: o.alreadyInstalled === true ? true : undefined };
}
export function decodeOk(body: unknown): void {
  if (bool(rec(body, "result").ok, "result.ok") !== true) throw new DecodeError("result.ok", "true");
}

// ---- updates --------------------------------------------------------------------------------------
export interface UpdateSummary {
  from: string;
  to: string;
  enabled: boolean;
  wasEnabled: boolean;
  reason?: string;
  kinds: string[];
}
function decodeSummary(v: unknown, at: string): UpdateSummary {
  const o = rec(v, at);
  return { from: commit(o.from, `${at}.from`), to: commit(o.to, `${at}.to`), enabled: bool(o.enabled, `${at}.enabled`), wasEnabled: bool(o.wasEnabled, `${at}.wasEnabled`), reason: optText(o.reason, `${at}.reason`, 60), kinds: strList(o.kinds, `${at}.kinds`, 20, 30) };
}
export interface UpdateApplied {
  item: InstalledItem;
  summary: UpdateSummary;
}
export function decodeUpdateApplied(body: unknown): UpdateApplied {
  const o = rec(body, "update");
  return { item: decodeItem(o.item, "update.item"), summary: decodeSummary(o.update, "update.update") };
}
export function decodeRollback(body: unknown): UpdateApplied {
  const o = rec(body, "rollback");
  return { item: decodeItem(o.item, "rollback.item"), summary: decodeSummary(o.rollback, "rollback.rollback") };
}

export interface RepairResult {
  repaired: boolean;
  status: string;
  was?: string;
  item: InstalledItem;
}
export function decodeRepair(body: unknown): RepairResult {
  const o = rec(body, "repair");
  return { repaired: bool(o.repaired, "repair.repaired"), status: text(o.status, "repair.status", 40), was: optText(o.was, "repair.was", 40), item: decodeItem(o.item, "repair.item") };
}

export interface UpdatesList {
  corrupt: boolean;
  items: { id: string; name: string; kind: string; current: string; latest: string; checkedAt: string | null; ref?: string; hasPrevious: boolean }[];
}
export function decodeUpdates(body: unknown): UpdatesList {
  const o = rec(body, "updates");
  return {
    corrupt: bool(o.corrupt, "updates.corrupt"),
    items: arr(o.items, "updates.items", MAX_ITEMS).map((x, i) => {
      const r = rec(x, `updates.items[${i}]`);
      return {
        id: ident(r.id, `updates.items[${i}].id`),
        name: text(r.name, `updates.items[${i}].name`, 120),
        kind: text(r.kind, `updates.items[${i}].kind`, 30),
        current: commit(r.current, `updates.items[${i}].current`),
        latest: commit(r.latest, `updates.items[${i}].latest`),
        checkedAt: r.checkedAt == null ? null : text(r.checkedAt, `updates.items[${i}].checkedAt`, 40),
        ref: optText(r.ref, `updates.items[${i}].ref`, 120),
        hasPrevious: bool(r.hasPrevious, `updates.items[${i}].hasPrevious`),
      };
    }),
  };
}

export interface CheckResult {
  checkedAt: string;
  results: { id: string; current: string; latest?: string; updateAvailable: boolean; error?: string }[];
}
export function decodeCheck(body: unknown): CheckResult {
  const o = rec(body, "check");
  return {
    checkedAt: text(o.checkedAt, "check.checkedAt", 40),
    results: arr(o.results, "check.results", MAX_ITEMS).map((x, i) => {
      const r = rec(x, `check.results[${i}]`);
      return { id: ident(r.id, `check.results[${i}].id`), current: commit(r.current, `check.results[${i}].current`), latest: r.latest == null ? undefined : commit(r.latest, `check.results[${i}].latest`), updateAvailable: bool(r.updateAvailable, `check.results[${i}].updateAvailable`), error: optText(r.error, `check.results[${i}].error`, 60) };
    }),
  };
}

export interface FileChange {
  path: string;
  size?: number;
  before?: number;
  after?: number;
}
export interface UpdatePreview {
  id: string;
  from: string;
  to: string;
  versionFrom: string | null;
  versionTo: string | null;
  files: { counts: { added: number; removed: number; changed: number }; added: FileChange[]; removed: FileChange[]; changed: FileChange[]; truncated: boolean };
  scan: { beforeCount: number; afterCount: number; newFindings: Finding[]; resolvedCount: number };
  newKinds: string[];
  newMembers: { memberId: string; type: string; name: string }[];
  members: { added: string[]; removed: string[] };
  consent: { required: boolean; kinds: string[] };
  wasEnabled: boolean;
  staysEnabledWithoutConsent: boolean;
  flags: string[];
}
function fileList(v: unknown, at: string, kind: "size" | "change"): FileChange[] {
  if (v == null) return [];
  return arr(v, at, MAX_DIFF_LIST).map((x, i) => {
    const r = rec(x, `${at}[${i}]`);
    return kind === "size" ? { path: text(r.path, `${at}[${i}].path`, 240), size: int(r.size, `${at}[${i}].size`) } : { path: text(r.path, `${at}[${i}].path`, 240), before: int(r.before, `${at}[${i}].before`), after: int(r.after, `${at}[${i}].after`) };
  });
}
export function decodePreview(body: unknown): UpdatePreview {
  const o = rec(body, "preview");
  const files = rec(o.files, "preview.files");
  const counts = rec(files.counts, "preview.files.counts");
  const scan = rec(o.scan, "preview.scan");
  const exe = rec(o.executable, "preview.executable");
  const members = rec(o.members, "preview.members");
  const consent = rec(o.consent, "preview.consent");
  const version = rec(o.version, "preview.version");
  return {
    id: ident(o.id, "preview.id"),
    from: commit(o.from, "preview.from"),
    to: commit(o.to, "preview.to"),
    versionFrom: version.from == null ? null : text(version.from, "preview.version.from", 60),
    versionTo: version.to == null ? null : text(version.to, "preview.version.to", 60),
    files: {
      counts: { added: int(counts.added, "counts.added"), removed: int(counts.removed, "counts.removed"), changed: int(counts.changed, "counts.changed") },
      added: fileList(files.added, "preview.files.added", "size"),
      removed: fileList(files.removed, "preview.files.removed", "size"),
      changed: fileList(files.changed, "preview.files.changed", "change"),
      truncated: bool(files.truncated, "preview.files.truncated"),
    },
    scan: {
      beforeCount: int(rec(scan.before, "preview.scan.before").count, "preview.scan.before.count"),
      afterCount: int(rec(scan.after, "preview.scan.after").count, "preview.scan.after.count"),
      newFindings: arr(scan.newFindings, "preview.scan.newFindings", MAX_FINDINGS).map((f, i) => decodeFinding(f, `preview.scan.newFindings[${i}]`)),
      resolvedCount: int(scan.resolvedCount, "preview.scan.resolvedCount"),
    },
    newKinds: strList(exe.newKinds, "preview.executable.newKinds", 20, 30),
    newMembers: arr(exe.newMembers, "preview.executable.newMembers", MAX_MEMBERS).map((m, i) => {
      const r = rec(m, `newMembers[${i}]`);
      return { memberId: ident(r.memberId, `newMembers[${i}].memberId`), type: text(r.type, `newMembers[${i}].type`, 40), name: text(r.name, `newMembers[${i}].name`, 120) };
    }),
    members: { added: idList(members.added, "preview.members.added"), removed: members.removed == null ? [] : idList(members.removed, "preview.members.removed") },
    consent: { required: bool(consent.required, "preview.consent.required"), kinds: strList(consent.kinds, "preview.consent.kinds", 20, 30) },
    wasEnabled: bool(o.wasEnabled, "preview.wasEnabled"),
    staysEnabledWithoutConsent: bool(o.staysEnabledWithoutConsent, "preview.staysEnabledWithoutConsent"),
    flags: strList(o.flags, "preview.flags", 20, 60),
  };
}

// ---- catalog --------------------------------------------------------------------------------------
export interface CatalogEntry {
  indexId: string;
  kind: string;
  name: string;
  description: string;
  publisher: string;
  version?: string;
  sourceUrl?: string;
  sourcePath?: string;
  remote: boolean;
  installable: boolean;
  reason?: string;
  installed: boolean;
}
export interface CatalogSource {
  id: string;
  title: string;
  kind: string;
  status: string;
  count: number;
  fetchedAt: string | null;
  error?: string;
}
export interface CatalogPage {
  query: string;
  total: number;
  offset: number;
  results: CatalogEntry[];
  sources: CatalogSource[];
}
export function decodeCatalog(body: unknown): CatalogPage {
  const o = rec(body, "catalog");
  return {
    query: text(o.query, "catalog.query", 200),
    total: int(o.total, "catalog.total"),
    offset: int(o.offset, "catalog.offset"),
    results: arr(o.results, "catalog.results", MAX_CATALOG_PAGE).map((x, i) => {
      const r = rec(x, `catalog.results[${i}]`);
      const src = rec(r.source, `catalog.results[${i}].source`);
      return {
        indexId: ident(r.indexId, `catalog.results[${i}].indexId`),
        kind: text(r.kind, `catalog.results[${i}].kind`, 30),
        name: text(r.name, `catalog.results[${i}].name`, 120),
        description: text(r.description, `catalog.results[${i}].description`, 300),
        publisher: text(r.publisher, `catalog.results[${i}].publisher`, 120),
        version: optText(r.version, `catalog.results[${i}].version`, 60),
        sourceUrl: optText(src.url, `catalog.results[${i}].source.url`, 300),
        // A path goes back to the server verbatim, so it is validated, not cleaned.
        sourcePath: src.path == null ? undefined : ident(src.path, `catalog.results[${i}].source.path`, 240),
        remote: r.remote === true,
        installable: bool(r.installable, `catalog.results[${i}].installable`),
        reason: optText(r.reason, `catalog.results[${i}].reason`, 80),
        installed: bool(r.installed, `catalog.results[${i}].installed`),
      };
    }),
    sources: arr(o.sources, "catalog.sources", 20).map((x, i) => {
      const r = rec(x, `catalog.sources[${i}]`);
      return {
        id: ident(r.id, `catalog.sources[${i}].id`),
        title: text(r.title, `catalog.sources[${i}].title`, 120),
        kind: text(r.kind, `catalog.sources[${i}].kind`, 40),
        status: text(r.status, `catalog.sources[${i}].status`, 20),
        count: int(r.count, `catalog.sources[${i}].count`),
        fetchedAt: r.fetchedAt == null ? null : text(r.fetchedAt, `catalog.sources[${i}].fetchedAt`, 40),
        error: optText(r.error, `catalog.sources[${i}].error`, 60),
      };
    }),
  };
}

export interface RefreshResult {
  results: { id: string; status: string; count?: number; error?: string }[];
}
export function decodeRefresh(body: unknown): RefreshResult {
  const o = rec(body, "refresh");
  return {
    results: arr(o.results, "refresh.results", 20).map((x, i) => {
      const r = rec(x, `refresh.results[${i}]`);
      return { id: text(r.id, `refresh.results[${i}].id`, 120), status: text(r.status, `refresh.results[${i}].status`, 30), count: optInt(r.count, `refresh.results[${i}].count`), error: optText(r.error, `refresh.results[${i}].error`, 60) };
    }),
  };
}

// ---- active set -----------------------------------------------------------------------------------
export interface ActiveSummary {
  failClosed: boolean;
  items: number;
  skills: number;
  sdkPlugins: number;
  mcpServers: number;
  excluded: { kind: string; name: string; reason: string }[];
  warnings: string[];
}
/** Counts and short names only: the server never sends configs or paths here, and the screen shows no more than that. */
export function decodeActive(body: unknown): ActiveSummary {
  const o = rec(body, "active");
  return {
    failClosed: bool(o.failClosed, "active.failClosed"),
    items: arr(o.items, "active.items", MAX_ITEMS).length,
    skills: arr(o.skills, "active.skills", MAX_ITEMS).length,
    sdkPlugins: int(o.sdkPlugins, "active.sdkPlugins"),
    mcpServers: arr(o.mcpServers, "active.mcpServers", MAX_ITEMS).length,
    excluded: o.excluded == null ? [] : arr(o.excluded, "active.excluded", 50).map((x, i) => {
      const r = rec(x, `active.excluded[${i}]`);
      return { kind: text(r.kind, "excluded.kind", 30), name: text(r.name, "excluded.name", 120), reason: text(r.reason, "excluded.reason", 120) };
    }),
    warnings: strList(o.warnings, "active.warnings", 50, 200),
  };
}
