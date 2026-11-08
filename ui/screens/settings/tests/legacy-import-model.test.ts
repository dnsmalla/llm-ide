import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canOfferImport, decodeLegacyImportReport, decodeLegacyImportStatus, formatBytes, legacyImportSummary,
} from "../legacy-import-model.ts";

const side = (over: Record<string, unknown> = {}) => ({
  path: "/Users/a/Library/Application Support/llm-ide/system/data.db",
  exists: true, valid: true, empty: false, sizeBytes: 411_078_656, tableCount: 3, totalRows: 120,
  migration: 69, tables: { users: 1, meetings: 119 }, reason: "ok",
  agentDb: { exists: true, valid: true, sizeBytes: 630_784, tableCount: 2, migration: 12 },
  secretsFile: true,
  ...over,
});
const status = (over: Record<string, unknown> = {}) => ({
  formatVersion: 1, status: "ready", reason: null, action: "import", needsForce: false,
  hasVaultSecrets: true, legacy: side(), target: side({ exists: false, valid: false, empty: true, sizeBytes: 0, tableCount: 0, totalRows: 0, migration: null, tables: {}, reason: "missing", agentDb: { exists: false, valid: false, sizeBytes: 0, tableCount: 0, migration: null }, secretsFile: false }),
  marker: null, notes: [], durationMs: 12,
  ...over,
});

test("decodes a ready status and keeps the counts the card shows", () => {
  const s = decodeLegacyImportStatus(status());
  assert.ok(s);
  assert.equal(s.action, "import");
  assert.equal(s.legacy.totalRows, 120);
  assert.equal(s.legacy.tables.meetings, 119);
  assert.equal(s.target.empty, true);
  assert.equal(s.legacy.agentDb.migration, 12);
  assert.equal(legacyImportSummary(s).title, "Ready to import");
  assert.equal(canOfferImport(s), true);
});

test("rejects a non-report and tolerates missing optional fields", () => {
  assert.equal(decodeLegacyImportStatus({ status: "ready" }), null);
  assert.equal(decodeLegacyImportStatus("nope"), null);
  const s = decodeLegacyImportStatus({ status: "unavailable", legacy: {}, target: {}, notes: [1, "ok"] });
  assert.ok(s);
  assert.equal(s.reason, null);
  assert.equal(s.legacy.exists, false);
  assert.deepEqual(s.notes, ["ok"]);
});

test("an already-imported status is a no-op and offers no button", () => {
  const s = decodeLegacyImportStatus(status({
    status: "already-imported", action: "noop", reason: "already-imported",
    marker: { status: "completed", importedAt: "2026-11-08T00:00:00.000Z", backups: ["backups/pre-import-1.db"], replaced: true, totalRows: 120 },
  }));
  assert.ok(s);
  const summary = legacyImportSummary(s);
  assert.equal(summary.title, "Already imported");
  assert.match(summary.detail, /2026-11-08/);
  assert.equal(canOfferImport(s), false);
});

test("a non-empty destination asks for force and never offers a plain import", () => {
  const s = decodeLegacyImportStatus(status({ status: "needs-confirmation", action: "force", needsForce: true, reason: "destination-not-empty", target: side({ empty: false, sizeBytes: 1_134_592 }) }));
  assert.ok(s);
  const summary = legacyImportSummary(s);
  assert.equal(summary.tone, "warning");
  assert.match(summary.detail, /backup/);
  assert.equal(canOfferImport(s), true);
});

test("completed reports show verified rows, backup and keychain backup", () => {
  const r = decodeLegacyImportReport({
    ...status({ status: "completed", action: "force", needsForce: false }),
    ran: true, importedAt: "2026-11-08T01:02:03.000Z", replaced: true,
    backup: "backups/pre-import-1.db", backups: ["backups/pre-import-1.db"],
    tables: { users: 1, meetings: 119 }, totalRows: 120, migration: 69, secretsImported: true,
    keychainBackup: "/Users/a/Library/Application Support/llm-ide-desktop/core/backups/pre-import-1.dev-secrets.json",
    rolledBack: null,
  });
  assert.ok(r);
  const summary = legacyImportSummary(r);
  assert.equal(summary.title, "Imported and verified");
  assert.match(summary.detail, /120 rows/);
  assert.match(summary.detail, /pre-import-1\.db/);
  assert.equal(canOfferImport(r), false);
  assert.equal(r.keychainBackup?.endsWith("dev-secrets.json"), true);
});

test("refusals name the reason and change nothing", () => {
  const s = decodeLegacyImportStatus(status({ status: "refused", action: "refuse", reason: "target-in-use" }));
  assert.ok(s);
  const summary = legacyImportSummary(s);
  assert.equal(summary.tone, "danger");
  assert.match(summary.detail, /running core/);
  assert.equal(canOfferImport(s), false);
});

test("bytes are shown in MB with one decimal", () => {
  assert.equal(formatBytes(411_078_656), "392 MB");
  assert.equal(formatBytes(1_500_000), "1.4 MB");
  assert.equal(formatBytes(0), "0 MB");
});
