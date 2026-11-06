// Opt-in live checks against the real APIs. Never run in CI; each test skips unless its variable is set.
//   LLMIDE_SP7_GITLAB_TOKEN  a gitlab.com OAuth or personal token with read_api + read_repository
//   LLMIDE_SP7_BOX_TOKEN     a Box access token (root_readonly), e.g. a developer token from the Box console
// Run: cd web && LLMIDE_SP7_GITLAB_TOKEN=... npm run test:live
// Node has no CORS, so this checks API shapes and limits only; web/MANUAL-CHECK.md step 5 checks CORS in a browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGitLabClient } from '../../src/sources/gitlab.ts';
import { createBoxClient } from '../../src/sources/box.ts';

const auth = (t) => ({ token: async () => t, refresh: async () => null });
const GL = process.env.LLMIDE_SP7_GITLAB_TOKEN, BOX = process.env.LLMIDE_SP7_BOX_TOKEN;

test('gitlab.com: projects, tree, open one file, search', { skip: !GL && 'set LLMIDE_SP7_GITLAB_TOKEN' }, async () => {
  const c = createGitLabClient(auth(GL));
  const projects = await c.list(null, null);
  const p = projects.entries.find((e) => e.project?.ref);
  assert.ok(p, 'the token sees at least one non-empty project');
  const tree = await c.list(p, null);
  assert.ok(tree.entries.length > 0);
  const f = tree.entries.find((e) => e.kind === 'file');
  if (f) { const o = await c.open(f); assert.ok(o.text !== null || o.bytes !== null || o.reason !== null); }
  await c.search(f?.name.split('.')[0] || 'readme', p);
});

test('Box: root folder, open one file, search', { skip: !BOX && 'set LLMIDE_SP7_BOX_TOKEN' }, async () => {
  const c = createBoxClient(auth(BOX));
  const root = await c.list(null, null);
  const f = root.entries.find((e) => e.kind === 'file');
  if (f) { const o = await c.open(f); assert.ok(o.text !== null || o.bytes !== null || o.reason !== null); }
  await c.search(f?.name.split('.')[0] || 'a', null);
});
