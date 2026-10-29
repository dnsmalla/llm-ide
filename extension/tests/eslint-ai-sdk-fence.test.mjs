// The Vercel AI SDK may be imported only inside providers/adapter/. A fixture
// "file" (linted from text, never written) that imports it anywhere else must
// fail lint; inside the adapter folder it must pass.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ESLint } from 'eslint';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const eslint = new ESLint({ cwd: root });
const lint = async (code, rel) => (await eslint.lintText(code, { filePath: path.join(root, rel) }))[0].messages
  .filter((m) => m.ruleId === 'no-restricted-imports');

const AI = "import { streamText } from 'ai';\nexport const x = streamText;\n";
const PROVIDER = "import { createOpenAICompatible } from '@ai-sdk/openai-compatible';\nexport const y = createOpenAICompatible;\n";

test('imports of the AI SDK outside providers/adapter fail lint, in every layer', async () => {
  for (const rel of ['providers/x.mjs', 'llm_agent/x.mjs', 'llm_agent/adapter/x.mjs', 'routes/x.mjs', 'server/x.mjs', 'kb/x.mjs', 'core/x.mjs', 'agents/x.mjs', 'server.mjs', 'scripts/x.mjs']) {
    assert.ok((await lint(AI, rel)).length > 0, `ai in ${rel}`);
    assert.ok((await lint(PROVIDER, rel)).length > 0, `@ai-sdk in ${rel}`);
  }
});

test('the same imports are accepted inside providers/adapter', async () => {
  assert.equal((await lint(AI, 'providers/adapter/x.mjs')).length, 0);
  assert.equal((await lint(PROVIDER, 'providers/adapter/x.mjs')).length, 0);
});

test('the adapter folder still may not import upward layers', async () => {
  assert.ok((await lint("import { x } from '../../routes/router.mjs';\nexport { x };\n", 'providers/adapter/x.mjs')).length > 0);
});
