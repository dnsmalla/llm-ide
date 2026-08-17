// llm_default_sources snapshot — materialize everything chat can actually
// use into one browsable folder:
//
//   <sourcesDir>/llm_default_sources/
//   ├── skills/<skill-name>/…              ← copied (recursively) from each
//   │                                        ENABLED source (skills/ + runtime/ families).
//   │                                        BUILTIN_ID (the central skills repo) is
//   │                                        filtered to CORE_BUILTIN_SKILLS — a curated
//   │                                        "fundamental" subset, not the whole repo;
//   │                                        every other enabled source ships in full.
//   ├── agents/<name>.md                    ← subagent definition files copied from a
//   │                                        source's discovery-only agents/ family (may
//   │                                        not be the plugin-subagent SHAPE — for the
//   │                                        REAL agent tiers/subagents chat runs, call
//   │                                        GET /kb/agent/catalog, the live source of
//   │                                        truth; this folder doesn't duplicate it)
//   ├── hooks/hooks.json                    ← hooks catalogued from enabled sources —
//   │                                        DISCOVERY ONLY, never executed. Standard
//   │                                        Claude-Code hook-manifest SHAPE (not a custom
//   │                                        wrapper) so this folder's own hookCount reads
//   │                                        correctly through the same generic per-source
//   │                                        reader every other source goes through
//   ├── commands/commands.json              ← Claude Code's OWN built-in slash commands —
//   │                                        static reference list, independent of any
//   │                                        enabled source (see claude-code-commands.mjs)
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
import { listSources, listDiscoveryHooks, defaultSourcesDir, defaultSourcesLocation, BUILTIN_ID, DEFAULT_SOURCES_ID } from '../llm-sources/registry.mjs';
import { listEnabled } from '../llm-sources/state.mjs';
import { effectiveMcpServers } from '../mcp/mcp-config.mjs';
import { CLAUDE_CODE_COMMANDS } from './claude-code-commands.mjs';

const LIBRARY_FAMILIES = ['skills', 'runtime']; // mirrors registry.mjs
const SNAPSHOT_DIR_NAME = 'llm_default_sources'; // legacy app-support folder name
// Must match SLUG_RE in llm-sources/registry.mjs — defensive: a hand-edited
// legacy registry could contain an id that escapes the snapshot folder.
const SAFE_SOURCE_ID = /^[a-z][a-z0-9-]{1,40}$/;

// Curated "fundamental" subset of the central skills repo (BUILTIN_ID) — the
// repo also carries a Gurobi/optimization-consulting vertical (gurobi-params,
// math-olympiad, excel-io, etc., tagged family: domain in registry.yaml) that
// has nothing to do with a coding-assistant IDE. Applied ONLY to BUILTIN_ID:
// a user who explicitly adds their own third-party source gets it in full,
// unfiltered — this allowlist is about curating what THIS product ships by
// default, not a general content policy. Update deliberately, not via a
// broad "everything except X" filter, so drift in the upstream repo can't
// silently balloon the default set back out.
const CORE_BUILTIN_SKILLS = new Set([
  'writing-plans', 'executing-plans', 'assist-plan',
  'code-review', 'receiving-code-review', 'requesting-code-review',
  'documentation',
  'systematic-debugging', 'test-driven-development',
  'add-feature', 'add-code',
  'brainstorming',
  'verification-before-completion',
  'using-git-worktrees', 'finishing-a-development-branch',
]);

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
  const counts = { sources: 0, skills: 0, agents: 0, hooks: 0, mcpServers: 0, commands: CLAUDE_CODE_COMMANDS.length };
  const skipped = [];
  // Standard Claude-Code hook-manifest shape ({event: [{matcher, hooks:
  // [{type, command}]}]}) — NOT a custom {sources: {...}} wrapper. This
  // folder is ITSELF the always-on `default-sources` source (see the flat-
  // layout note above), so its own hooks.json must be parseable by the SAME
  // generic listDiscoveryHooks/countDiscoveryHooks every other source's
  // hooks.json goes through (used by the Library UI's per-source hookCount +
  // hooks list). A custom top-level shape here would make "Default Sources"
  // permanently show 0 hooks no matter what's cataloged behind it — the
  // exact bug this replaces. Provenance is kept per-hook via `_source`
  // (an extra field the generic reader safely ignores, since it only reads
  // `.command` off each hooks[] entry).
  const hookManifest = {};
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
    // default-sources IS this snapshot folder (defaultSourcesLocation() ===
    // defaultSnapshotDir()) — it must never be read as an INPUT, only ever
    // produced as output. Since the flat-layout fix made this folder
    // actually readable as a source, skipping this is required: otherwise
    // every refresh would copy the PREVIOUS refresh's contents back into the
    // new one (and, because default-sources is seeded first and dedup keeps
    // the first source's copy, stale/uncurated entries could win over a
    // freshly-curated builtin and never go away).
    if (src.id === DEFAULT_SOURCES_ID) continue;
    if (!src.location || !existsSync(src.location)) continue;
    counts.sources += 1;

    // First family wins on a same-name skill within this source (skills/
    // before runtime/); cross-source duplicates are dropped by the shared
    // seenSkillNames above. Dropped copies are recorded, never silent.
    for (const { fam, dir: skillDir } of listSkillDirs(src.location)) {
      const name = basename(skillDir);
      if (src.id === BUILTIN_ID && !CORE_BUILTIN_SKILLS.has(name)) {
        skipped.push({ source: src.id, skill: name, reason: 'outside the curated fundamental-skills set for this product' });
        continue;
      }
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

    for (const { event, matcher, command } of listDiscoveryHooks(src.location)) {
      hookManifest[event] = hookManifest[event] || [];
      hookManifest[event].push({ matcher, hooks: [{ type: 'command', command, _source: src.id }] });
      counts.hooks += 1;
    }
  }

  mkdirSync(join(staging, 'hooks'), { recursive: true });
  writeFileSync(join(staging, 'hooks', 'hooks.json'), JSON.stringify({
    // `_note` sits alongside real event-name keys deliberately: the generic
    // reader does `Object.entries(manifest)` and skips any value that isn't
    // an Array (see registry.mjs's listDiscoveryHooks), so a string note key
    // is silently ignored by the same parser that reads the event keys.
    _note: 'Hooks catalogued from enabled sources — DISCOVERY ONLY. LLM-IDE never executes these commands. Each hook entry carries its originating source id as `_source`.',
    ...hookManifest,
  }, null, 2));

  // Claude Code's own built-in slash commands (/clear, /compact, /help, …) —
  // a REFERENCE catalog, not discovered from any registered llm-source: these
  // are intrinsic to the `claude` CLI itself, independent of enabled sources
  // or userId, so this file is identical on every refresh. Static list lives
  // in claude-code-commands.mjs (source: code.claude.com/docs/en/commands.md)
  // — update it there when Claude Code's own command set changes.
  mkdirSync(join(staging, 'commands'), { recursive: true });
  writeFileSync(join(staging, 'commands', 'commands.json'), JSON.stringify({
    _note: "Claude Code's own built-in slash commands — a static reference catalog, not sourced from any registered llm-source and never executed by this server.",
    commands: CLAUDE_CODE_COMMANDS,
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
    description: 'Effective chat configuration. skills/: copied from ENABLED sources (BUILTIN_ID curated to a fundamental subset). agents/<name>.md: discovery-only copies from a source\'s agents/ family (for the REAL agent tiers/subagents chat runs, use GET /kb/agent/catalog instead — this folder does not duplicate it). hooks/: discovery catalog, standard hook-manifest shape (never executed). commands/commands.json: Claude Code\'s own built-in slash commands, reference only. .mcp.json: enabled+consented MCP plugins actually passed to the CLI. Single global folder — the last user to trigger a refresh wins (this userId).',
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
