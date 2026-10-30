// What each extension consumer loads for a user, reduced to stable data. The
// baseline test compares this with a committed golden file (flag off), and the
// P2 tests compare it again with LLMIDE_EXT_ACTIVE_SET on, so "no change for
// unchanged data" is proved against the same bytes.
//
// Imports are dynamic so a test can call createWorld() first.

const rel = (world, v) => world.normalize(v);

/**
 * @param {ReturnType<import('./extensions-world.mjs').createWorld>} world
 * @param {string} userId
 */
export async function snapshotConsumers(world, userId) {
  const registry = await import('../../llm_agent/skills/registry.mjs');
  const index = await import('../../llm_agent/skills/index.mjs');
  const engine = await import('../../llm_agent/sdk/engine.mjs');
  index._resetSkillLibraryCache?.();

  const d = registry.buildUserPluginDelivery(userId, { nativeEnabled: true, cwd: world.root });
  const set = registry.buildPerUserSkillSet(userId);
  const pluginSkills = {};
  for (const [name, s] of set.skills) if (s.pluginName) pluginSkills[name] = s.pluginName;
  const commands = {};
  for (const [trigger, c] of set.commands) commands[trigger] = c.pluginName;
  const subagents = {};
  for (const [name, s] of set.subagents) subagents[name] = s.pluginName;

  const library = index.listSkillLibrary(userId).skills.map((s) => s.id);
  const slash = registry.listAllSkills().plugins
    .map((g) => ({ plugin: g.pluginName, skills: g.skills.map((s) => s.name).sort() }))
    .sort((a, b) => a.plugin.localeCompare(b.plugin));

  const noRestrict = () => false;
  const execute = engine.buildUserMcpServers(userId, 'execute', { restrictsToolsFn: noRestrict, readSecret: () => '' });
  const plan = engine.buildUserMcpServers(userId, 'plan', { restrictsToolsFn: () => true, readSecret: () => '' });

  return rel(world, {
    pluginDelivery: {
      sdkPlugins: [...d.sdkPlugins].sort((a, b) => a.path.localeCompare(b.path)),
      native: [...d.native].sort(), translated: [...d.translated].sort(),
      hookEvents: Object.keys(d.hooks || {}).sort(),
    },
    skillSet: { pluginSkills, commands, subagents },
    library: [...library].sort(),
    slashCatalogPlugins: slash,
    mcp: { execute, plan },
  });
}
