import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTomlLite } from '../core/toml-lite.mjs';

test('parses flat key=value pairs at the root', () => {
  const parsed = parseTomlLite('model = "gpt-5.4"\npersonality = "pragmatic"\n');
  assert.equal(parsed.model, 'gpt-5.4');
  assert.equal(parsed.personality, 'pragmatic');
});

test('parses dotted section headers into nested objects', () => {
  const parsed = parseTomlLite(`
[marketplaces.openai-bundled]
source_type = "local"
source = "/Users/x/.codex/.tmp/bundled-marketplaces/openai-bundled"
`);
  assert.equal(parsed.marketplaces['openai-bundled'].source_type, 'local');
  assert.equal(parsed.marketplaces['openai-bundled'].source, '/Users/x/.codex/.tmp/bundled-marketplaces/openai-bundled');
});

test('quoted section segments are treated as opaque (dots/slashes inside do not split)', () => {
  const parsed = parseTomlLite(`
[plugins."documents@openai-primary-runtime"]
enabled = true

[projects."/Users/x/Desktop/auto_sys/edurut/apps/ios"]
trust_level = "untrusted"
`);
  assert.equal(parsed.plugins['documents@openai-primary-runtime'].enabled, true);
  assert.equal(parsed.projects['/Users/x/Desktop/auto_sys/edurut/apps/ios'].trust_level, 'untrusted');
});

test('parses booleans, arrays of strings, and inline tables', () => {
  const parsed = parseTomlLite(`
[mcp_servers.slack]
command = "npx"
args = ["-y", "@slack/mcp"]
env = { TOKEN = "secret", REGION = "us" }
enabled = false
`);
  const s = parsed.mcp_servers.slack;
  assert.equal(s.command, 'npx');
  assert.deepEqual(s.args, ['-y', '@slack/mcp']);
  assert.deepEqual(s.env, { TOKEN: 'secret', REGION: 'us' });
  assert.equal(s.enabled, false);
});

test('comments are stripped, including a comment after a quoted value', () => {
  const parsed = parseTomlLite('name = "value" # a trailing comment\n# a full-line comment\ncount = "3"\n');
  assert.equal(parsed.name, 'value');
  assert.equal(parsed.count, '3');
});

test('a # inside a quoted string is not treated as a comment', () => {
  const parsed = parseTomlLite('description = "Use the #hashtag skill"\n');
  assert.equal(parsed.description, 'Use the #hashtag skill');
});

test('unsupported/malformed lines are skipped, not thrown', () => {
  const parsed = parseTomlLite('not a valid line at all\n[[array_of_tables]]\nname = "x"\n');
  assert.equal(parsed.name, 'x'); // [[..]] isn't a supported header, falls through to root
});

test('empty input parses to an empty object', () => {
  assert.deepEqual(parseTomlLite(''), {});
  assert.deepEqual(parseTomlLite('   \n\n  '), {});
});

test('later sections do not clobber earlier siblings under the same parent', () => {
  const parsed = parseTomlLite(`
[plugins."a@mp"]
enabled = true

[plugins."b@mp"]
enabled = false
`);
  assert.equal(parsed.plugins['a@mp'].enabled, true);
  assert.equal(parsed.plugins['b@mp'].enabled, false);
});
