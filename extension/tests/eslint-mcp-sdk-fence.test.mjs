// The MCP SDK may be imported only by the two MCP clients we own:
// connectors/mcp-client.mjs and providers/adapter/. A fixture "file" (linted
// from text, never written) that imports it anywhere else must fail lint.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ESLint } from 'eslint';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const eslint = new ESLint({ cwd: root });
const lint = async (code, rel) => (await eslint.lintText(code, { filePath: path.join(root, rel) }))[0].messages
  .filter((m) => m.ruleId === 'no-restricted-imports');

const CLIENT = "import { Client } from '@modelcontextprotocol/sdk/client/index.js';\nexport const x = Client;\n";
const TRANSPORT = "import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';\nexport const y = StdioClientTransport;\n";
const BARE = "import { Server } from '@modelcontextprotocol/sdk';\nexport const z = Server;\n";

test('imports of the MCP SDK outside the two MCP clients fail lint, in every layer', async () => {
  for (const rel of ['providers/x.mjs', 'llm_agent/x.mjs', 'llm_agent/adapter/x.mjs', 'llm_agent/extensions/x.mjs', 'routes/x.mjs', 'server/x.mjs',
    'kb/x.mjs', 'core/x.mjs', 'agents/x.mjs', 'mcp/x.mjs', 'plugins/x.mjs', 'connectors/x.mjs', 'connectors/other.mjs', 'server.mjs', 'scripts/x.mjs']) {
    for (const code of [CLIENT, TRANSPORT, BARE]) assert.ok((await lint(code, rel)).length > 0, `mcp sdk in ${rel}`);
  }
});

test('the same imports are accepted in providers/adapter and in connectors/mcp-client.mjs', async () => {
  for (const rel of ['providers/adapter/x.mjs', 'providers/adapter/mcp-client.mjs', 'connectors/mcp-client.mjs']) {
    for (const code of [CLIENT, TRANSPORT]) assert.equal((await lint(code, rel)).length, 0, rel);
  }
});

test('those two places still may not import upward layers', async () => {
  const up = "import { x } from '../routes/router.mjs';\nexport { x };\n";
  assert.ok((await lint(up, 'connectors/mcp-client.mjs')).length > 0);
  assert.ok((await lint("import { x } from '../../routes/router.mjs';\nexport { x };\n", 'providers/adapter/x.mjs')).length > 0);
});
