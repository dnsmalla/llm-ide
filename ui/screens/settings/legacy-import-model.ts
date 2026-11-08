// Read-only model for Settings → Server & Backend → "Old Mac app data".
//
// The report comes from the desktop host (`legacy_import_status` / `legacy_import_run`), which
// returns the JSON report of `extension/kb/legacy-import.mjs`. Decoding is tolerant on optional
// fields (the helper grows notes and counts over time) but requires the envelope, so a host from
// before this feature shows nothing rather than a half-typed object.

import type { LegacyImportReport, LegacyImportSide, LegacyImportStatus } from "./host.ts";

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);

const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const num = (v: unknown, fallback = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const optNum = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const bool = (v: unknown, fallback = false): boolean => (typeof v === "boolean" ? v : fallback);
const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const map = (v: unknown): Record<string, number> | null => {
  if (!isRec(v)) return null;
  const out: Record<string, number> = {};
  for (const [k, n] of Object.entries(v)) if (typeof n === "number" && Number.isFinite(n)) out[k] = n;
  return out;
};

function side(v: unknown): LegacyImportSide {
  const r = isRec(v) ? v : {};
  const agent = isRec(r.agentDb) ? r.agentDb : {};
  return {
    path: typeof r.path === "string" ? r.path : null,
    exists: bool(r.exists),
    valid: bool(r.valid),
    empty: bool(r.empty, true),
    sizeBytes: num(r.sizeBytes),
    tableCount: num(r.tableCount),
    totalRows: num(r.totalRows),
    migration: optNum(r.migration),
    tables: map(r.tables) ?? {},
    reason: str(r.reason, "unknown"),
    agentDb: {
      exists: bool(agent.exists),
      valid: bool(agent.valid, true),
      sizeBytes: num(agent.sizeBytes),
      tableCount: num(agent.tableCount),
      migration: optNum(agent.migration),
    },
    secretsFile: bool(r.secretsFile),
  };
}

/** Decode a host report; null when it is not a report at all (an older host). */
export function decodeLegacyImportStatus(v: unknown): LegacyImportStatus | null {
  if (!isRec(v) || typeof v.status !== "string" || !isRec(v.legacy) || !isRec(v.target)) return null;
  return {
    formatVersion: num(v.formatVersion, 1),
    status: str(v.status, "unavailable"),
    reason: typeof v.reason === "string" ? v.reason : null,
    action: str(v.action, "none"),
    needsForce: bool(v.needsForce),
    hasVaultSecrets: bool(v.hasVaultSecrets),
    legacy: side(v.legacy),
    target: side(v.target),
    marker: isRec(v.marker) ? {
      status: str(v.marker.status),
      importedAt: typeof v.marker.importedAt === "string" ? v.marker.importedAt : null,
      backups: list(v.marker.backups),
      replaced: bool(v.marker.replaced),
      totalRows: optNum(v.marker.totalRows),
      tables: map(v.marker.tables),
    } : null,
    notes: list(v.notes),
    durationMs: num(v.durationMs),
  };
}

/** Decode the result of `run_legacy_import` (the status fields plus what was written). */
export function decodeLegacyImportReport(v: unknown): LegacyImportReport | null {
  const base = decodeLegacyImportStatus(v);
  if (!base || !isRec(v)) return null;
  return {
    ...base,
    ran: bool(v.ran),
    importedAt: typeof v.importedAt === "string" ? v.importedAt : null,
    replaced: bool(v.replaced),
    backup: typeof v.backup === "string" ? v.backup : null,
    backups: list(v.backups),
    tables: map(v.tables) ?? base.legacy.tables,
    totalRows: optNum(v.totalRows),
    migration: optNum(v.migration) ?? base.legacy.migration,
    agentMigration: optNum(v.agentMigration),
    secretsImported: bool(v.secretsImported),
    keychainBackup: typeof v.keychainBackup === "string" ? v.keychainBackup : null,
    rolledBack: typeof v.rolledBack === "boolean" ? v.rolledBack : null,
  };
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  if (bytes < 1024 ** 2) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${Math.round((bytes / 1024 ** 2) * 10) / 10} MB`;
}

export type LegacyImportTone = "ok" | "warning" | "danger" | "muted";

export interface LegacyImportSummary {
  tone: LegacyImportTone;
  title: string;
  detail: string;
}

const REASONS: Record<string, string> = {
  "no-legacy-dir": "This computer has no old Mac app data folder.",
  "no-legacy-data": "No old Mac app data folder was found at the expected location.",
  "no-target-dir": "The desktop data folder could not be resolved.",
  integrity: "The old data.db failed SQLite's integrity check.",
  unreadable: "The old data.db could not be read.",
  empty: "The old data.db is empty.",
  "no-schema-migrations": "The old data.db has no applied schema migrations, so it is not the app database.",
  "marker-unreadable": "The previous import marker cannot be read; inspect the desktop data folder by hand.",
  "marker-without-valid-db": "An import marker exists but the desktop data.db is missing or unreadable. Restore it from its backup.",
  interrupted: "An earlier import stopped mid-way. Inspect the desktop data folder; nothing was changed.",
  "destination-not-empty": "The desktop data folder already holds data. Replacing it needs explicit confirmation and writes a backup first.",
  "target-in-use": "The desktop data.db is open by another process (a running core). Stop it and try again.",
  "legacy-in-use": "The old data.db is open by another process. Quit the old app and try again.",
  "legacy-vault-key-missing": "The old app has vault-encrypted secrets but no vault key, so they could not be decrypted.",
  "no-space": "Not enough free disk space for the verified copy.",
  busy: "Another import is already running.",
  cancelled: "The import was cancelled; nothing was changed.",
};

/** One line for the Settings card. Never says "imported" unless the helper verified it. */
export function legacyImportSummary(r: LegacyImportStatus | LegacyImportReport): LegacyImportSummary {
  const marker = r.marker;
  const finish = (tone: LegacyImportTone, title: string, detail: string): LegacyImportSummary => ({ tone, title, detail });
  switch (r.status) {
    case "completed": {
      const rows = (r as LegacyImportReport).totalRows ?? r.legacy.totalRows;
      const tables = (r as LegacyImportReport).tables ?? r.legacy.tables;
      const n = tables ? Object.keys(tables).length : r.legacy.tableCount;
      const backup = (r as LegacyImportReport).backup;
      return finish("ok", "Imported and verified", `${rows} rows in ${n} tables, schema v${(r as LegacyImportReport).migration ?? r.legacy.migration ?? "?"}${backup ? `; the previous desktop data is in ${backup}` : ""}.`);
    }
    case "already-imported":
    case "noop":
      return finish("ok", "Already imported", `${marker?.importedAt ? `Imported ${marker.importedAt}. ` : ""}This runs once; nothing was changed.${marker?.backups?.length ? ` Backups: ${marker.backups.join(", ")}.` : ""}`);
    case "ready":
      return finish("warning", "Ready to import", `${formatBytes(r.legacy.sizeBytes)}, ${r.legacy.totalRows} rows, schema v${r.legacy.migration ?? "?"}${r.legacy.agentDb.exists ? `; agent history ${formatBytes(r.legacy.agentDb.sizeBytes)}` : ""}. The desktop data folder is empty.`);
    case "needs-confirmation":
      return finish("warning", "Would replace the desktop data", `The old data is ${formatBytes(r.legacy.sizeBytes)} (${r.legacy.totalRows} rows); the desktop folder already has ${formatBytes(r.target.sizeBytes)}. Replacing it needs confirmation and writes a verified backup first.`);
    case "unavailable":
      return finish("muted", "No old Mac app data", REASONS[r.reason ?? ""] ?? "Nothing to import on this computer.");
    case "invalid-legacy":
      return finish("danger", "The old data cannot be imported", REASONS[r.reason ?? ""] ?? `The old data.db is unusable (${r.legacy.reason}).`);
    case "interrupted":
      return finish("danger", "An earlier import was interrupted", REASONS[r.reason ?? ""] ?? REASONS.interrupted);
    case "refused":
      return finish("danger", "Not imported", REASONS[r.reason ?? ""] ?? "The import was refused; nothing was changed.");
    case "failed":
      return finish("danger", "Import failed", `${REASONS[r.reason ?? ""] ?? (r.reason ?? "The import failed")}${r.action === "force" || r.needsForce ? " The desktop data was left as it was." : ""}`);
    case "cancelled":
      return finish("muted", "Import cancelled", REASONS.cancelled);
    default:
      return finish("muted", "Old Mac app data", r.reason ? (REASONS[r.reason] ?? r.reason) : "No status yet.");
  }
}

/** True when the card should offer the explicit action. */
export function canOfferImport(r: LegacyImportStatus | LegacyImportReport | null): boolean {
  if (!r) return false;
  if (r.status === "completed" || r.status === "already-imported" || r.status === "noop") return false;
  return r.action === "import" || r.action === "force";
}
