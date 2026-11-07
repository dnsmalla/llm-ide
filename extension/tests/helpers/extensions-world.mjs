// A synthetic "extensions world" shared by the extensions-catalog tests
// (baseline, importer, active set, consumers, adapter). Everything is
// fabricated in a temp dir: plugins on disk, a fake central kit, MCP registry
// rows and per-user state. No real user data, no network.
//
// Call `createWorld()` BEFORE importing anything from ../plugins, ../mcp,
// ../llm-sources or ../llm_agent: the plugin registry scans its directory when
// llm_agent/skills/registry.mjs is first imported, and every state file path is
// derived from LLMIDE_PLUGIN_DIR.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
}

function skillMd(name, description = `${name} description`) {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\nbody of ${name}\n`;
}

/**
 * Plugins (all names lowercase):
 *   alpha   Claude format, skills sk-one + sk-two, command cmd-a, agent helper, a stdio .mcp.json server `srv`
 *   hooky   Claude format with one command hook (needs a trust grant to be delivered)
 *   owned   own format, one flat skill, one command
 *   codexy  Codex layout (never native) with a command hook
 */
export function createWorld({ tag = 'ext-world' } = {}) {
  process.env.LLMIDE_JWT_SECRET = 'a'.repeat(48);
  process.env.LLMIDE_VAULT_KEY = 'b'.repeat(48);
  process.env.NODE_ENV = 'test';
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${tag}-`));
  const pluginDir = path.join(root, 'plugins');
  const kit = path.join(root, 'kit');
  process.env.LLMIDE_PLUGIN_DIR = pluginDir;
  process.env.SKILLS_REPO = kit;
  process.env.LLMIDE_DB_PATH = path.join(root, 'data.db');
  delete process.env.LLMIDE_EXT_ACTIVE_SET;
  delete process.env.LLMIDE_EXT_ADAPTER;
  fs.mkdirSync(pluginDir, { recursive: true });

  const claude = (name, extra = {}) => {
    write(path.join(pluginDir, name, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name, version: '1.0.0', description: `${name} plugin`, ...extra }));
  };

  // alpha
  claude('alpha');
  write(path.join(pluginDir, 'alpha', 'skills', 'sk-one', 'SKILL.md'), skillMd('sk-one'));
  write(path.join(pluginDir, 'alpha', 'skills', 'sk-two', 'SKILL.md'), skillMd('sk-two'));
  write(path.join(pluginDir, 'alpha', 'commands', 'cmd-a.md'), '---\ndescription: run a\n---\nDo A with {{_rest}}\n');
  write(path.join(pluginDir, 'alpha', 'agents', 'helper.md'), '---\ndescription: a helper\n---\nYou are a helper.\n');
  write(path.join(pluginDir, 'alpha', '.mcp.json'),
    JSON.stringify({ mcpServers: { srv: { command: 'node', args: ['alpha-srv.js'] } } }));

  // hooky
  claude('hooky');
  write(path.join(pluginDir, 'hooky', 'hooks', 'hooks.json'), JSON.stringify({
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'exit 0' }] }] },
  }));
  write(path.join(pluginDir, 'hooky', 'skills', 'hk-skill', 'SKILL.md'), skillMd('hk-skill'));

  // owned (own format)
  write(path.join(pluginDir, 'owned', 'plugin.json'), JSON.stringify({ name: 'owned', version: '1.0.0' }));
  write(path.join(pluginDir, 'owned', 'skills', 'owned-skill.md'),
    '---\nname: owned-skill\nkind: read\ndescription: an own-format skill\n---\n\nBody.\n');
  write(path.join(pluginDir, 'owned', 'commands', 'own-cmd.md'), '---\ndescription: own command\n---\nOwn {{_rest}}\n');

  // codexy
  write(path.join(pluginDir, 'codexy', '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'codexy', version: '1.0.0' }));
  write(path.join(pluginDir, 'codexy', 'hooks', 'hooks.json'), JSON.stringify({
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'exit 0' }] }] },
  }));

  // A fake central kit (the builtin LLM source): three library skills.
  write(path.join(kit, 'registry.yaml'), 'registryVersion: "3.0.0"\n');
  write(path.join(kit, 'skills', 'alpha', 'SKILL.md'), skillMd('alpha'));
  write(path.join(kit, 'skills', 'beta', 'SKILL.md'), skillMd('beta'));
  write(path.join(kit, 'runtime', 'gamma', 'SKILL.md'), skillMd('gamma'));

  // A second (user-added) LLM source with one skill.
  const extra = path.join(root, 'extra-source');
  write(path.join(extra, 'skills', 'delta', 'SKILL.md'), skillMd('delta'));
  write(path.join(extra, 'registry.yaml'), 'registryVersion: "3.0.0"\n');

  const normalize = (value) => JSON.parse(JSON.stringify(value).split(root).join('<ROOT>'));
  return { root, pluginDir, kit, extra, normalize, file: (...p) => path.join(root, ...p) };
}

/** MCP registry rows used by the world. */
export function mcpRows() {
  return [
    { id: 'linear', name: 'linear', command: 'npx', args: ['-y', 'linear-mcp'], source: 'manual', builtin: false },
    { id: 'sentry', name: 'sentry', transport: 'http', url: 'https://mcp.example.com/sse', source: 'manual', builtin: false },
    { id: 'unused', name: 'unused', command: 'npx', args: ['-y', 'unused'], source: 'manual', builtin: false },
  ];
}
