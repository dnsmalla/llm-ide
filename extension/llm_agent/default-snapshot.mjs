// llm_default_sources snapshot — materialize everything chat can actually
// use into one browsable folder:
//
//   <sourcesDir>/llm_default_sources/
//   ├── skills/<skill-name>/…              ← copied (recursively) from each
//   │                                        ENABLED source (skills/ + runtime/ families)
//   ├── agents/<name>.md                    ← subagent definition files
//   ├── hooks/hooks.json                    ← hooks catalogued from enabled
//   │                                        sources — DISCOVERY ONLY, never executed
//   ├── .mcp.json                           ← the EFFECTIVE chat MCP servers
//   │                                        (enabled+consented MCP plugins), exact
//   │                                        shape the claude CLI receives
//   └── _meta.json                          ← generatedAt, userId, counts, skipped[]
//
// FLAT layout, not namespaced by source id: this folder is ITSELF registered
// as the always-on `default-sources` llm-source (see registry.mjs
// seedBuiltinOnce + state.mjs listEnabled's fallback for a user with no
// state at all), and every reader of a source's skills/agents (skill-library.mjs,
// registry.mjs's countDiscoverySkills/listDiscoveryAgents) expects the SAME
// one-level shape every other source uses (`<location>/skills/<name>/SKILL.md`,
// `<location>/agents/<name>.md`). A per-source subfolder here would be
// structurally invisible to those readers — which is exactly what happened
// before this comment was written: a brand-new user (enabled only in
// default-sources) saw zero skills. Provenance (which source a copy came
// from) still lives in _meta.json.skipped and the per-refresh log, just not
// in the directory shape. Cross-source name collisions are deduped below
// (first enabled source wins) so flattening never overwrites a different
// skill/agent silently.
//
// Lives in llm_agent/ (not llm-sources/) deliberately: it needs BOTH the
// llm-sources registry and the MCP plugin state — sibling L3 modules that may
// not import each other per the ESLint module-boundary table, while llm_agent
// may import both. Conceptually it snapshots the chat orchestrator's world.
//
// Refreshed on: source enable/disable toggle, source REMOVE, MCP plugin
// consent/enable change, server start, and POST /auth/me/llm-sources/
// refresh-default. Rebuild = staging dir + rename, so the folder is never
// half-written and entries from sources that were disabled since the last
// refresh disappear.
//
// DESIGN DECISIONS (from review):
// - Single global folder, NOT per-user. The snapshot is a browsability
//   artifact for a local-first, realistically single-active-user install;
//   the last user to trigger a refresh wins and _meta.json records which
//   userId that was. (Per-user tenancy lives in the DB, not on this disk
//   folder.)
// - Symlinks inside copied skills are PRESERVED (cpSync default), never
//   dereferenced: dereferencing would copy whatever an attacker's symlink
//   points at (e.g. ~/.ssh contents) into the snapshot. A preserved symlink
//   is inert metadata.
// - The copy is synchronous but BOUNDED (per-skill bytes/files + total
//   bytes) — this repo treats event-loop stalls as a regression class
//   (see the async-git note atop llm-sources/registry.mjs), so an oversized
//   third-party source is skipped and recorded in _meta.json.skipped rather
//   than copied wholesale.
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { listSources, listDiscoveryHooks, defaultSourcesDir, defaultSourcesLocation } from '../llm-sources/registry.mjs';
import { listEnabled } from '../llm-sources/state.mjs';
import { effectiveMcpServers } from '../mcp/mcp-config.mjs';

const LIBRARY_FAMILIES = ['skills', 'runtime']; // mirrors registry.mjs
const SNAPSHOT_DIR_NAME = 'llm_default_sources'; // legacy app-support folder name
// Must match SLUG_RE in llm-sources/registry.mjs — defensive: a hand-edited
// legacy registry could contain an id that escapes the snapshot folder.
const SAFE_SOURCE_ID = /^[a-z][a-z0-9-]{1,40}$/;

const DEFAULT_LIMITS = Object.freeze({
  maxSkillBytes: 10 * 1024 * 1024,   // per skill folder
  maxSkillFiles: 1000,               // per skill folder
  maxTotalBytes: 200 * 1024 * 1024,  // per refresh, across all skills
});

// The snapshot is a COMMITTED repo folder (versioned in git), not an
// app-support artifact — see the header.
export function defaultSnapshotDir() {
  return defaultSourcesLocation();
}

// Bounded recursive measurement of a skill dir. lstat semantics (symlinks
// count as the link itself, not their target) so the measurement matches a
// preserve-symlink cpSync. Aborts as soon as a budget is exceeded — the walk
// itself must not become the stall.
function measureSkillDir(dir, { maxBytes, maxFiles }) {
  let bytes = 0, files = 0;
  const walk = (d) => {
    if (bytes > maxBytes || files > maxFiles) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      const st = lstatSync(p);
      if (st.isDirectory()) { walk(p); }
      else { files += 1; bytes += st.size; }
      if (bytes > maxBytes || files > maxFiles) return;
    }
  };
  try { walk(dir); } catch { return { bytes: Infinity, files: Infinity, over: 'size' }; }
  if (bytes > maxBytes) return { bytes, files, over: 'size' };
  if (files > maxFiles) return { bytes, files, over: 'files' };
  return { bytes, files, over: null };
}

// Skill folders = any <fam>/<name>/ with a SKILL.md, same rule the registry
// and the chat skill-library use.
function listSkillDirs(loc) {
  const out = [];
  for (const fam of LIBRARY_FAMILIES) {
    const d = join(loc, fam);
    if (!existsSync(d)) continue;
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.isDirectory() && existsSync(join(d, e.name, 'SKILL.md'))) out.push({ fam, dir: join(d, e.name) });
    }
  }
  return out;
}

// agents/*.md — one file per subagent definition (Claude Code convention).
function listAgentFiles(loc) {
  const d = join(loc, 'agents');
  if (!existsSync(d)) return [];
  try {
    return readdirSync(d, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.md'))
      .map((e) => join(d, e.name));
  } catch { return []; }
}

export function refreshDefaultSnapshot(userId, limits = {}) {
  const { maxSkillBytes, maxSkillFiles, maxTotalBytes } = { ...DEFAULT_LIMITS, ...limits };
  const dest = defaultSnapshotDir();
  const staging = join(dirname(dest), `.tmp-${SNAPSHOT_DIR_NAME}`);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });

  const enabled = listEnabled(userId);
  const counts = { sources: 0, skills: 0, agents: 0, hooks: 0, mcpServers: 0 };
  const skipped = [];
  const hooksBySource = {};
  let totalBytes = 0;
  // Dedup across ALL enabled sources, not just within one: the first source
  // in registry order wins (default-sources is seeded first, then builtin,
  // then user-added). Chat must never see duplicate skills. Both sets are
  // required now that the layout is flat (no per-source subfolder to keep
  // same-named entries apart) — an agent needs the same guard skills already had.
  const seenSkillNames = new Set();
  const seenAgentNames = new Set();

  for (const src of listSources()) {
    if (!enabled.has(src.id)) continue;
    if (!SAFE_SOURCE_ID.test(src.id)) continue; // defensive: never escape the folder
    if (!src.location || !existsSync(src.location)) continue;
    counts.sources += 1;

    // First family wins on a same-name skill within this source (skills/
    // before runtime/); cross-source duplicates are dropped by the shared
    // seenSkillNames above. Dropped copies are recorded, never silent.
    for (const { fam, dir: skillDir } of listSkillDirs(src.location)) {
      const name = basename(skillDir);
      if (seenSkillNames.has(name)) {
        skipped.push({ source: src.id, skill: name, reason: `${fam}-family duplicate — earlier family kept` });
        continue;
      }
      seenSkillNames.add(name);

      if (totalBytes >= maxTotalBytes) {
        skipped.push({ source: src.id, skill: name, reason: 'total size budget exceeded' });
        continue;
      }
      const m = measureSkillDir(skillDir, { maxBytes: maxSkillBytes, maxFiles: maxSkillFiles });
      if (m.over) {
        skipped.push({ source: src.id, skill: name, reason: `skill ${m.over} budget exceeded (${m.over === 'size' ? `${m.bytes}B` : `${m.files} files`})` });
        continue;
      }
      totalBytes += m.bytes;

      const target = join(staging, 'skills', name);
      mkdirSync(dirname(target), { recursive: true });
      cpSync(skillDir, target, { recursive: true }); // symlinks preserved — see header
      counts.skills += 1;
    }

    for (const agentFile of listAgentFiles(src.location)) {
      const agentName = basename(agentFile);
      if (seenAgentNames.has(agentName)) {
        skipped.push({ source: src.id, agent: agentName, reason: 'cross-source duplicate — earlier source kept' });
        continue;
      }
      seenAgentNames.add(agentName);

      const target = join(staging, 'agents', agentName);
      mkdirSync(dirname(target), { recursive: true });
      cpSync(agentFile, target);
      counts.agents += 1;
    }

    const hooks = listDiscoveryHooks(src.location);
    if (hooks.length) hooksBySource[src.id] = hooks;
    counts.hooks += hooks.length;
  }

  mkdirSync(join(staging, 'hooks'), { recursive: true });
  writeFileSync(join(staging, 'hooks', 'hooks.json'), JSON.stringify({
    _note: 'Hooks catalogued from enabled sources — DISCOVERY ONLY. LLM-IDE never executes these commands.',
    sources: hooksBySource,
  }, null, 2));

  // Source .mcp.json manifests are deliberately NOT merged here: they are
  // catalogued-only and never spawned. The effective servers chat runs with
  // come exclusively from enabled+consented MCP plugins.
  const mcpServers = effectiveMcpServers(userId);
  counts.mcpServers = Object.keys(mcpServers).length;
  writeFileSync(join(staging, '.mcp.json'), JSON.stringify({ mcpServers }, null, 2));

  writeFileSync(join(staging, '_meta.json'), JSON.stringify({
    generatedAt: new Date().toISOString(),
    userId,
    description: 'Effective chat configuration. skills/ + agents/: copied from ENABLED sources. hooks/: discovery catalog (never executed). .mcp.json: enabled+consented MCP plugins actually passed to the CLI. Single global folder — the last user to trigger a refresh wins (this userId).',
    counts,
    skipped,
  }, null, 2));

  // Build fully in staging, then swap in — the live folder is never
  // half-written and stale entries from a previous refresh disappear.
  rmSync(dest, { recursive: true, force: true });
  renameSync(staging, dest);

  // Retire the pre-repo app-support location so exactly one copy exists.
  rmSync(join(defaultSourcesDir(), SNAPSHOT_DIR_NAME), { recursive: true, force: true });

  return { ok: true, dir: dest, counts, skipped };
}

// Fire-and-forget rebuild for request handlers: let the HTTP response go out
// first, then rebuild off the response path. Still synchronous when it runs
// (bounded — see DEFAULT_LIMITS), and never throws into the caller.
export function scheduleSnapshotRefresh(userId) {
  setImmediate(() => {
    try { refreshDefaultSnapshot(userId); } catch { /* best-effort by contract */ }
  });
}
