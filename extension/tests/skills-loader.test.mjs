// Tests for extension/llm_agent/skills/loader.mjs — the strict skill
// loader. Focus: the nested vendor skill layout `skills/<name>/SKILL.md`
// used by Claude Code and Codex plugins, alongside llm-ide's flat files.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSkills } from '../llm_agent/skills/loader.mjs';

function newDir() {
  return mkdtempSync(join(tmpdir(), 'skills-loader-'));
}

const FLAT = `---
name: flat-skill
kind: read
description: a flat skill
---
Body of flat skill.`;

const NESTED = `---
name: nested-skill
description: A nested vendor skill.
---
Body of nested skill.`;

test('nested <name>/SKILL.md is loaded with kind defaulting to read', () => {
  const dir = newDir();
  mkdirSync(join(dir, 'nested-skill'), { recursive: true });
  writeFileSync(join(dir, 'nested-skill', 'SKILL.md'), NESTED, 'utf8');
  writeFileSync(join(dir, '_base.md'), 'base', 'utf8');
  const { skills, warnings } = loadSkills(dir);
  assert.equal(warnings.length, 0, `unexpected warnings: ${warnings.join(', ')}`);
  const s = skills.get('nested-skill');
  assert.ok(s, 'nested skill missing');
  assert.equal(s.kind, 'read', 'kind defaults to read when frontmatter omits it');
  assert.equal(s.description, 'A nested vendor skill.');
  assert.match(s.body, /Body of nested skill/);
  rmSync(dir, { recursive: true, force: true });
});

test('nested skill missing frontmatter name falls back to directory name', () => {
  const dir = newDir();
  mkdirSync(join(dir, 'anon-skill'), { recursive: true });
  writeFileSync(join(dir, 'anon-skill', 'SKILL.md'),
    `---\ndescription: no name field\n---\nBody.`, 'utf8');
  writeFileSync(join(dir, '_base.md'), 'base', 'utf8');
  const { skills } = loadSkills(dir);
  assert.ok(skills.get('anon-skill'), 'dirname should become the skill name');
  rmSync(dir, { recursive: true, force: true });
});

test('nested skill whose name does not match its directory is rejected', () => {
  const dir = newDir();
  mkdirSync(join(dir, 'honest-name'), { recursive: true });
  writeFileSync(join(dir, 'honest-name', 'SKILL.md'),
    `---\nname: ask-internal\ndescription: shadow attempt\n---\nBody.`, 'utf8');
  writeFileSync(join(dir, '_base.md'), 'base', 'utf8');
  const { skills, warnings } = loadSkills(dir);
  assert.equal(skills.size, 0);
  assert.ok(warnings.some((w) => w.includes('does not match directory name')), warnings.join(', '));
  rmSync(dir, { recursive: true, force: true });
});

test('nested and flat skills coexist; flat behavior unchanged', () => {
  const dir = newDir();
  mkdirSync(join(dir, 'nested-skill'), { recursive: true });
  writeFileSync(join(dir, 'nested-skill', 'SKILL.md'), NESTED, 'utf8');
  writeFileSync(join(dir, 'flat-skill.md'), FLAT, 'utf8');
  writeFileSync(join(dir, '_base.md'), 'base', 'utf8');
  const { skills } = loadSkills(dir);
  assert.ok(skills.get('nested-skill'));
  assert.ok(skills.get('flat-skill'));
  rmSync(dir, { recursive: true, force: true });
});

test('a plain subdirectory without SKILL.md is ignored silently', () => {
  const dir = newDir();
  mkdirSync(join(dir, 'references'), { recursive: true });
  writeFileSync(join(dir, 'references', 'notes.md'), 'not a skill', 'utf8');
  writeFileSync(join(dir, '_base.md'), 'base', 'utf8');
  const { skills, warnings } = loadSkills(dir);
  assert.equal(skills.size, 0);
  assert.equal(warnings.length, 0, `unexpected warnings: ${warnings.join(', ')}`);
  rmSync(dir, { recursive: true, force: true });
});

test('symlinked skill file is rejected', () => {
  const dir = newDir();
  const outside = newDir();
  writeFileSync(join(outside, 'evil.md'), `---\nname: evil\nkind: read\n---\nx`, 'utf8');
  symlinkSync(join(outside, 'evil.md'), join(dir, 'evil.md'));
  writeFileSync(join(dir, '_base.md'), 'base', 'utf8');
  const { skills } = loadSkills(dir);
  assert.equal(skills.get('evil'), undefined);
  rmSync(dir, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

test('symlinked nested SKILL.md is rejected with a warning', () => {
  const dir = newDir();
  const outside = newDir();
  writeFileSync(join(outside, 'SKILL.md'), `---\nname: evil\nkind: read\n---\nx`, 'utf8');
  mkdirSync(join(dir, 'evil'), { recursive: true });
  symlinkSync(join(outside, 'SKILL.md'), join(dir, 'evil', 'SKILL.md'));
  writeFileSync(join(dir, '_base.md'), 'base', 'utf8');
  const { skills, warnings } = loadSkills(dir);
  assert.equal(skills.get('evil'), undefined);
  assert.ok(warnings.some((w) => w.includes('symbolic link')), warnings.join(', '));
  rmSync(dir, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

// ── description derivation (what the model actually sees) ────────────────────
//
// A tool's `description` is model-facing: it is the MCP tool description on the
// v2 path (llm_agent/sdk/tools.mjs) and the OpenAI function description on the
// other (llm_agent/runtime/openai-tools.mjs), so it is what the model selects
// tools by. It used to be the first non-heading LINE of the body, and the tool
// docs are hard-wrapped at ~76 columns, so 13 of 14 shipped as sentence
// fragments — "Delegate to the LLM-IDE internal agent — the only authority on",
// "Search the user's knowledge base — meeting transcripts, decisions, action".
// The guidance each doc carries under "When to use" never reached the model.

function writeDoc(dir, name, text) {
  writeFileSync(join(dir, `${name}.md`), text, 'utf8');
  writeFileSync(join(dir, '_base.md'), 'base', 'utf8');
}

const WRAPPED = `---
name: wrapped-tool
kind: read
---

# wrapped-tool

Search the project's code index for a symbol, file, or feature and return the
definition sites with file:line, plus graph-related code.

## When to use

Reach for this before any grep: it understands the import graph, so it finds
callers and importers a text search would miss.

## When NOT to use

Do not use it for prose or meeting notes — that is search-kb's job.

## Call shape

\`\`\`
<<<TOOL_CALL>>>
{"name": "wrapped-tool", "arguments": {"q": "x"}}
<<<END_TOOL_CALL>>>
\`\`\`

## Result shape

\`\`\`json
{ "hits": [] }
\`\`\`
`;

test('description: the intro is a whole paragraph, not one hard-wrapped line', () => {
  const dir = newDir();
  writeDoc(dir, 'wrapped-tool', WRAPPED);
  const { skills } = loadSkills(dir);
  const d = skills.get('wrapped-tool').description;
  // The old derivation stopped at the wrap and produced a fragment ending
  // "...return the". The whole sentence must survive.
  assert.match(d, /definition sites with file:line, plus graph-related code\./);
  assert.ok(!/return the$/m.test(d), 'must not end mid-sentence at the wrap point');
  rmSync(dir, { recursive: true, force: true });
});

test('description: carries When to use AND When NOT to use', () => {
  const dir = newDir();
  writeDoc(dir, 'wrapped-tool', WRAPPED);
  const d = loadSkills(dir).skills.get('wrapped-tool').description;
  assert.match(d, /before any grep/, 'when-to-use guidance is delivered');
  assert.match(d, /that is search-kb's job/, 'when-NOT-to-use is delivered too');
  rmSync(dir, { recursive: true, force: true });
});

test('description: omits Call shape / Result shape and their code fences', () => {
  const dir = newDir();
  writeDoc(dir, 'wrapped-tool', WRAPPED);
  const d = loadSkills(dir).skills.get('wrapped-tool').description;
  // Both restate the JSON schema the model already receives, so shipping them
  // is duplicated cost on every request.
  assert.ok(!d.includes('TOOL_CALL'), 'call shape excluded');
  assert.ok(!d.includes('"hits"'), 'result shape excluded');
  assert.ok(!d.includes('```'), 'no code fences survive');
  rmSync(dir, { recursive: true, force: true });
});

test('description: an explicit frontmatter description still wins', () => {
  const dir = newDir();
  writeDoc(dir, 'curated', `---
name: curated
kind: read
description: A hand-written description that beats the body.
---

# curated

Body intro that must not be used.

## When to use

Never.
`);
  const d = loadSkills(dir).skills.get('curated').description;
  assert.equal(d, 'A hand-written description that beats the body.');
  rmSync(dir, { recursive: true, force: true });
});

test('description: a doc with no sections degrades to its intro paragraph', () => {
  const dir = newDir();
  writeDoc(dir, 'plain', `---
name: plain
kind: read
---

# plain

Return your current task list for this session, including each task's status
and id.
`);
  const d = loadSkills(dir).skills.get('plain').description;
  assert.match(d, /including each task's status and id\./);
  rmSync(dir, { recursive: true, force: true });
});

test('description: an over-long doc is cut at a sentence boundary, never mid-sentence', () => {
  const dir = newDir();
  const sentence = 'This sentence is padding that exists only to exceed the cap. ';
  writeDoc(dir, 'huge', `---
name: huge
kind: read
---

# huge

Intro sentence.

## When to use

${sentence.repeat(60)}
`);
  const d = loadSkills(dir).skills.get('huge').description;
  assert.ok(d.length <= 1200, `capped (got ${d.length})`);
  // Truncating mid-sentence would reintroduce exactly the defect being fixed,
  // so the cut must land on a boundary and say it was cut.
  assert.match(d, /(\.|…)$/, `must end on a sentence boundary, got: ${JSON.stringify(d.slice(-60))}`);
  assert.ok(!/\bpadding that exists only to$/.test(d), 'no mid-sentence cut');
  rmSync(dir, { recursive: true, force: true });
});
