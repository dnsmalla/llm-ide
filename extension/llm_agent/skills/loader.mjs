// Loads every Markdown skill file under a directory at server boot,
// parses YAML frontmatter, validates the basic shape, and exposes a
// cached map keyed by skill name.  Invalid skills are dropped with a
// warning instead of crashing the server, so a typo in one file doesn't
// take down /code-assist.

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';

const VALID_KINDS = new Set(['read', 'write']);
const VALID_SCHEMA_TYPES = new Set(['string', 'number', 'boolean', 'string[]']);
const VALID_CONFIRMATIONS = new Set(['editable-sheet', 'gitop-sheet']);

// Per-file content cap — prevents a single oversized skill from
// exhausting the Claude context window.  Core skills are small and
// will never approach this; the limit mainly guards plugin skills.
const MAX_SKILL_BYTES = 32_768;   // 32 KB

// Strip prompt-injection fence markers before parsing so a plugin
// can't break the <<<BEGIN>>>…<<<END>>> contract used by AI routes.
function stripInjectionFences(text) {
  return text.replace(/<<<BEGIN>>>/gi, '').replace(/<<<END>>>/gi, '');
}

function parseSkillFile(path) {
  let raw = readFileSync(path, 'utf8');
  if (Buffer.byteLength(raw, 'utf8') > MAX_SKILL_BYTES) {
    return { error: `skill file exceeds ${MAX_SKILL_BYTES} byte limit (${Buffer.byteLength(raw, 'utf8')} bytes)` };
  }
  raw = stripInjectionFences(raw);
  // Match the YAML frontmatter block. We look for the CLOSING `---` on its
  // own line (^---$) so that `---` embedded inside a YAML string value
  // (e.g. description: "foo --- bar") doesn't prematurely close the block.
  // The regex reads: start-of-file `---\n`, then capture YAML lines until
  // we hit a line that is ONLY `---`, then capture the rest as body.
  const match = raw.match(/^---\n([\s\S]*?)\n^---\s*\n([\s\S]*)$/m);
  if (!match) {
    return { error: 'missing frontmatter' };
  }
  let fm;
  try {
    fm = yaml.load(match[1]);
  } catch (err) {
    return { error: `invalid yaml: ${err.message}` };
  }
  if (!fm || typeof fm !== 'object') {
    return { error: 'frontmatter is empty or not an object' };
  }
  return { frontmatter: fm, body: match[2] };
}

function validateSchema(schema) {
  if (schema === undefined || schema === null) return { schema: {} };
  if (typeof schema !== 'object' || Array.isArray(schema)) {
    return { error: 'schema must be an object' };
  }
  const out = {};
  for (const [name, def] of Object.entries(schema)) {
    if (!def || typeof def !== 'object') {
      return { error: `argument '${name}' definition must be an object` };
    }
    if (!VALID_SCHEMA_TYPES.has(def.type)) {
      return { error: `argument '${name}' has unsupported type '${def.type}'` };
    }
    // enum is matched against validated string args, so its elements must be
    // strings — a YAML `enum: [1, 2]` (parsed as numbers) would silently never
    // match any input and permanently reject a valid op.
    if (def.enum !== undefined &&
        (!Array.isArray(def.enum) || !def.enum.every((e) => typeof e === 'string'))) {
      return { error: `argument '${name}' enum must be an array of strings` };
    }
    out[name] = {
      type: def.type,
      required: def.required === true,
      maxLength: typeof def.maxLength === 'number' ? def.maxLength : null,
      description: typeof def.description === 'string' ? def.description : null,
      enum: Array.isArray(def.enum) && def.enum.length > 0 ? def.enum : undefined,
    };
  }
  return { schema: out };
}

export function loadSkills(dir) {
  const warnings = [];
  const skills = new Map();
  let base = '';

  if (!existsSync(dir)) {
    return { skills, base, warnings: [`skills directory not found: ${dir}`] };
  }

  const entries = readdirSync(dir).filter((f) => f.endsWith('.md'));
  if (!entries.includes('_base.md')) {
    warnings.push("_base.md is missing from skills directory; system prompt will lack base instructions");
  }

  for (const entry of entries) {
    const path = join(dir, entry);
    if (entry === '_base.md') {
      const raw = readFileSync(path, 'utf8');
      if (Buffer.byteLength(raw, 'utf8') > MAX_SKILL_BYTES) {
        // _base.md carries the fence protocol contract. Truncating it at
        // a byte boundary can cut the contract mid-sentence and produce
        // subtly malformed tool calls — worse than having no contract at
        // all (which fails loudly as "no tool calls possible"). Reject.
        warnings.push(`_base.md exceeds ${MAX_SKILL_BYTES} byte limit — REJECTED; system prompt will lack base instructions`);
      } else {
        base = raw.trim();
      }
      continue;
    }
    const parsed = parseSkillFile(path);
    if (parsed.error) {
      warnings.push(`${entry}: ${parsed.error}`);
      continue;
    }
    const fm = parsed.frontmatter;
    // Explicit required-field checks first, so a skill missing `name`
    // or `kind` gets a "missing required field" error instead of a
    // confusing "'undefined' does not match filename".
    if (typeof fm.name !== 'string' || !fm.name) {
      warnings.push(`${entry}: frontmatter missing required field 'name'`);
      continue;
    }
    if (typeof fm.kind !== 'string' || !fm.kind) {
      warnings.push(`${entry}: frontmatter missing required field 'kind' ('read' or 'write')`);
      continue;
    }
    const expectedName = entry.replace(/\.md$/, '');
    if (fm.name !== expectedName) {
      warnings.push(`${entry}: name '${fm.name}' does not match filename`);
      continue;
    }
    if (!VALID_KINDS.has(fm.kind)) {
      warnings.push(`${entry}: kind '${fm.kind}' is not 'read' or 'write'`);
      continue;
    }
    if (fm.kind === 'write' && !VALID_CONFIRMATIONS.has(fm.confirmation)) {
      warnings.push(`${entry}: write skills must have confirmation: editable-sheet or gitop-sheet`);
      continue;
    }
    const schemaResult = validateSchema(fm.schema);
    if (schemaResult.error) {
      warnings.push(`${entry}: ${schemaResult.error}`);
      continue;
    }
    // Optional `description` frontmatter field — a 1-2 sentence
    // human-readable summary shown in the Library → Skills catalog.
    // Falls back to the first non-heading line of the body.
    const bodyDescription = extractBodyDescription(parsed.body);
    const description = typeof fm.description === 'string' && fm.description.trim()
      ? fm.description.trim()
      : bodyDescription;

    skills.set(fm.name, {
      name: fm.name,
      kind: fm.kind,
      confirmation: fm.confirmation || null,
      description,
      schema: schemaResult.schema,
      body: parsed.body.trim(),
    });
  }

  return { skills, base, warnings };
}

/// Extract the first non-heading, non-empty prose line from a skill body.
/// Used as a fallback description when the frontmatter has no `description`.
function extractBodyDescription(body) {
  if (typeof body !== 'string') return '';
  for (const line of body.split('\n')) {
    const t = line.trim();
    if (t && !t.startsWith('#') && !t.startsWith('```') && !t.startsWith('<<<')) {
      return t.slice(0, 140);
    }
  }
  return '';
}
