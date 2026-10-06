// Update orchestrator for Claude-imported plugins (spec:
// docs/superpowers/specs/2026-10-06-plugin-update-claude-codex-design.md).
//
// Detection has two tiers: `reimport` (Claude Code's install differs from the
// version llm-ide copied — exact and offline) and `upstream` (the marketplace
// catalog proves a newer release, after a refresh cached for 30 minutes).
// An update re-decides the tier at click time: Tier 1 is an offline re-import
// of Claude's install; otherwise it runs Claude Code's own `plugin update`
// and re-imports the new installPath. Either way the copy is swapped in whole
// and hook/MCP trust is reset when the executable components changed.
//
// All `claude plugin …` knowledge stays in the linker (providers/). The route
// supplies `reload`, `isTurnActive` and `clearMcpConsents`, because plugins/
// may not import llm_agent/, routes/ or mcp/ (layer rule).
import { join } from 'node:path';
import {
  runClaudePluginCli, marketplaceUpdateArgs, listArgs, updateArgs, parseList, parseUpdateResult,
} from '../providers/claude-plugin-cli.mjs';
import { versionsDiffer, upstreamTier, pickInstalledEntry } from './plugin-version.mjs';
import {
  importPlugin, readImportStamp, checkForUpdates, listImportedNames, claudePluginsRoot, scanInstalled,
} from './claude-adapter.mjs';
import { importWithTrustCheck } from './import-trust.mjs';
import { clearHooksTrustForPlugin } from './state.mjs';
import { defaultPluginDir } from './loader.mjs';
import { PLUGIN_NAME_RE } from './vendor-import-shared.mjs';

const MARKETPLACE_TTL_MS = 30 * 60 * 1000;

// Server-wide state: one marketplace refresh per TTL, one update at a time.
let cache = null; // { at: number } — when the marketplace catalog was last refreshed
let busy = false;

/** Test-only: forget the marketplace refresh and the update lock. */
export function _resetForTests() {
  cache = null;
  busy = false;
}

/**
 * Add the pre-v60 row fields so an older Mac app (non-optional String
 * `importedVersion`/`sourceVersion`/`source`) still decodes the response.
 * @param {{importedVersion: string|null, claudeVersion: string|null, latest: string|null}} row
 */
export function withLegacyFields(row) {
  return {
    ...row,
    importedVersion: row.importedVersion ?? '',
    sourceVersion: row.claudeVersion ?? row.latest ?? '',
    source: 'installed',
  };
}

/** True while an update is running (the route uses it to refuse reloads). */
export function isPluginUpdating() {
  return busy;
}

function resolveDeps(deps = {}) {
  return {
    run: deps.run || ((args) => runClaudePluginCli(args)),
    now: deps.now || Date.now,
    claudeRoot: deps.claudeRoot || claudePluginsRoot(),
    mnDir: deps.llmidePluginDir || defaultPluginDir(),
    clearTrust: deps.clearTrust || clearHooksTrustForPlugin,
    reload: deps.reload,
    isTurnActive: deps.isTurnActive,
    clearMcpConsents: deps.clearMcpConsents,
  };
}

const isEnoent = (err) => err?.code === 'ENOENT';
const namePart = (id) => (id.lastIndexOf('@') > 0 ? id.slice(0, id.lastIndexOf('@')) : id);

/** Claude-imported plugins in llm-ide's dir: [{ name, stamp, sourcePlugin }]. */
function claudeImports(mnDir) {
  const out = [];
  for (const name of [...listImportedNames(mnDir)].sort()) {
    const stamp = readImportStamp(name, mnDir);
    if (!stamp) continue;
    out.push({ name, stamp, sourcePlugin: stamp.sourcePlugin || name.replace(/^claude-/, '') });
  }
  return out;
}

/**
 * Claude's installed entry for an import. Several marketplaces can carry the
 * same plugin name; the stamp does not record which one the copy came from,
 * so the first listed id wins.
 */
function findEntry(list, imp) {
  const candidate = list.installed.find((e) => namePart(e.id) === imp.sourcePlugin);
  if (!candidate) return null;
  const entry = pickInstalledEntry(list.installed, candidate.id, imp.stamp.sourceScope || undefined);
  return entry ? { pluginId: candidate.id, entry } : null;
}

const catalogLatest = (available) => {
  if (!available) return null;
  if (typeof available.version === 'string' && available.version) return available.version;
  const sha = available.source && typeof available.source === 'object' ? available.source.sha : null;
  return typeof sha === 'string' && sha ? sha : null;
};

/** Tier 1: Claude's install differs from the copy (or the copy predates stamps). */
const claudeIsAhead = (entry, stamp) => !stamp.sourceVersion || versionsDiffer(entry.version, stamp.sourceVersion);

/** One update row, or null when neither tier applies. */
function updateRow(list, imp) {
  const found = findEntry(list, imp);
  if (!found) return null;
  const { pluginId, entry } = found;
  const available = list.available.find((a) => a.pluginId === pluginId);
  const upstream = upstreamTier({ installedVersion: entry.version, available });
  const reimport = claudeIsAhead(entry, imp.stamp);
  const tier = reimport ? 'reimport' : upstream;
  if (!tier) return null;
  return {
    name: imp.name,
    pluginId,
    importedVersion: imp.stamp.sourceVersion,
    claudeVersion: entry.version ?? null,
    latest: upstream ? catalogLatest(available) : (entry.version ?? null),
    tier,
  };
}

/** No usable CLI: the local scan, mapped to the same row shape. */
function fallbackCheck(d) {
  const updates = checkForUpdates({ claudeRoot: d.claudeRoot, llmidePluginDir: d.mnDir }).map((u) => ({
    name: u.name,
    pluginId: null,
    importedVersion: u.importedVersion,
    claudeVersion: u.sourceVersion,
    latest: u.sourceVersion,
    tier: 'upstream',
  }));
  return { cli: false, checkedAt: new Date(d.now()).toISOString(), updates };
}

/** Refresh the marketplace catalogs when forced or stale. Failure is not fatal. */
async function refreshMarketplaces(d, force) {
  if (!force && cache && d.now() - cache.at <= MARKETPLACE_TTL_MS) return;
  try {
    await d.run(marketplaceUpdateArgs());
  } catch (err) {
    if (isEnoent(err)) throw err;
    // A failed refresh still leaves Tier 1 exact; keep going.
  }
  cache = { at: d.now() };
}

/**
 * Which Claude-imported plugins have an update.
 * @param {{force?: boolean, deps?: object}} [opts]
 * @returns {Promise<{cli: boolean, checkedAt: string, updates: Array<{name: string, pluginId: string|null,
 *   importedVersion: string|null, claudeVersion: string|null, latest: string|null, tier: 'reimport'|'upstream'}>}>}
 *   `cli:false` means the claude CLI was unusable and the local scan answered.
 */
export async function checkClaudeUpdates({ force = false, deps } = {}) {
  const d = resolveDeps(deps);
  let list;
  try {
    await refreshMarketplaces(d, force);
    list = parseList((await d.run(listArgs())).stdout);
  } catch {
    // ENOENT (no CLI) and unparsable output both mean the CLI cannot answer.
    return fallbackCheck(d);
  }
  const updates = claudeImports(d.mnDir).map((imp) => updateRow(list, imp)).filter(Boolean);
  return { cli: true, checkedAt: new Date(cache?.at ?? d.now()).toISOString(), updates };
}

const cliFailed = (detail) => ({ status: 502, body: { code: 'CLI_FAILED', detail } });

/** `claude plugin list`, or a 502 result when it cannot be read. */
async function listOrFail(d) {
  try {
    return { list: parseList((await d.run(listArgs())).stdout) };
  } catch (err) {
    return { failure: cliFailed(isEnoent(err) ? 'claude CLI not found' : String(err?.message || err)) };
  }
}

/** Run Claude Code's own update. Returns { stop } (a final result) or { claudeUpdated }. */
async function runCliUpdate(d, pluginId, scope, acceptCommand) {
  let out;
  try {
    out = await d.run(updateArgs(pluginId, { scope, acceptCommand }));
  } catch (err) {
    return { stop: cliFailed(isEnoent(err) ? 'claude CLI not found' : String(err?.message || err)) };
  }
  const parsed = parseUpdateResult(out.stdout, out.exitCode);
  if (parsed.status === 'needs-confirmation') {
    return { stop: { status: 409, body: { code: 'NEEDS_CONFIRMATION', command: parsed.command, sha256: parsed.sha256 } } };
  }
  if (parsed.status === 'failed') return { stop: cliFailed(parsed.detail || `exit ${out.exitCode}`) };
  return { claudeUpdated: parsed.status === 'updated' };
}

/**
 * Copy Claude's install at `entry` into llm-ide (copy-then-swap), reset trust
 * when the executable parts changed, and reload. `claudeUpdated` only reports
 * whether Claude Code's own install moved in this request.
 */
async function reimportEntry(d, imp, entry, claudeUpdated) {
  const res = importWithTrustCheck({
    dir: join(d.mnDir, imp.name),
    doImport: () => importPlugin({
      source: 'installed', name: imp.sourcePlugin, installPath: entry.installPath,
      sourceVersion: entry.version, scope: entry.scope ?? null, claudeRoot: d.claudeRoot, llmidePluginDir: d.mnDir,
    }),
    clearTrust: d.clearTrust,
    clearMcpConsents: d.clearMcpConsents,
  });
  if (!res.ok) {
    return { status: 200, body: { ok: false, code: 'REIMPORT_FAILED', claudeUpdated, detail: res.error || 'import failed' } };
  }
  await d.reload();
  return { status: 200, body: { ok: true, from: imp.stamp.sourceVersion, to: entry.version ?? null, trustReset: res.trustReset, claudeUpdated } };
}

/** Claude's installed_plugins.json entry for an import, read without the CLI. */
function scannedEntry(d, imp) {
  const p = scanInstalled(d.claudeRoot).find((e) => e.name === imp.sourcePlugin);
  return p ? { version: p.version, installPath: p.installPath, scope: p.scope ?? null } : null;
}

async function runUpdate(d, imp, acceptCommand) {
  let list;
  try {
    list = parseList((await d.run(listArgs())).stdout);
  } catch (err) {
    if (!isEnoent(err)) return cliFailed(String(err?.message || err));
    // No CLI: Claude's own index still proves a Tier 1 gap, and closing it
    // needs no CLI — only a copy of what Claude already installed.
    const entry = scannedEntry(d, imp);
    if (entry && claudeIsAhead(entry, imp.stamp)) return reimportEntry(d, imp, entry, false);
    return cliFailed('claude CLI not found');
  }
  const found = findEntry(list, imp);
  if (!found) return { status: 404, body: { code: 'NOT_FOUND', detail: 'not installed in Claude Code' } };
  // Tier 1 is decided now, not from the badge the client saw: Claude Code is
  // already ahead, so its install is copied offline without touching Claude.
  if (claudeIsAhead(found.entry, imp.stamp)) return reimportEntry(d, imp, found.entry, false);

  const cli = await runCliUpdate(d, found.pluginId, found.entry.scope, acceptCommand);
  if (cli.stop) return cli.stop;
  cache = null; // Claude's install changed; the next check must re-read the catalog too.

  const after = await listOrFail(d);
  const reimportFailed = (detail) => ({ status: 200, body: { ok: false, code: 'REIMPORT_FAILED', claudeUpdated: cli.claudeUpdated, detail } });
  if (after.failure) return reimportFailed(after.failure.body.detail);
  const now = findEntry(after.list, imp);
  if (!now) return reimportFailed('plugin no longer installed in Claude Code');
  return reimportEntry(d, imp, now.entry, cli.claudeUpdated);
}

/**
 * Update one Claude-imported plugin. When Claude Code's install is already
 * ahead of llm-ide's copy (Tier 1) the copy is refreshed offline; otherwise
 * Claude Code's install is updated first, then llm-ide's copy. Nothing in
 * llm-ide changes unless the CLI update succeeded, and a failed re-import
 * keeps the old copy. A 200 body carries `claudeUpdated` (did Claude Code's
 * own install change in this request).
 *
 * Pre: `deps.reload`, `deps.isTurnActive` and `deps.clearMcpConsents` are
 * functions (throws otherwise). `acceptCommand` is the sha256 the user saw.
 * @param {{name: string, acceptCommand?: string, deps: object}} opts
 * @returns {Promise<{status: 200|404|409|502, body: object}>}
 */
export async function updateClaudePlugin({ name, acceptCommand, deps } = {}) {
  const d = resolveDeps(deps);
  for (const key of ['reload', 'isTurnActive', 'clearMcpConsents']) {
    if (typeof d[key] !== 'function') throw new Error(`updateClaudePlugin: deps.${key} is required`);
  }
  if (typeof name !== 'string' || !PLUGIN_NAME_RE.test(name)) return { status: 404, body: { code: 'NOT_FOUND' } };
  const stamp = readImportStamp(name, d.mnDir);
  if (!stamp) return { status: 404, body: { code: 'NOT_FOUND' } };
  if (d.isTurnActive()) return { status: 409, body: { code: 'BUSY' } };
  if (busy) return { status: 409, body: { code: 'UPDATE_IN_PROGRESS' } };
  busy = true;
  try {
    const imp = { name, stamp, sourcePlugin: stamp.sourcePlugin || name.replace(/^claude-/, '') };
    return await runUpdate(d, imp, typeof acceptCommand === 'string' && acceptCommand ? acceptCommand : undefined);
  } finally {
    busy = false;
  }
}
