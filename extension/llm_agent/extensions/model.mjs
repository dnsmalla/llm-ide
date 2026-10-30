// The catalog's item model (plan section 5.1). Pure: no I/O, no registries.
//
// One item model for four kinds, so one switch means the same thing for each:
//
//   skill        one SKILL.md
//   plugin       a Claude/Codex/own-format package (skills, commands, agents,
//                hooks, a declared MCP server list)
//   mcp          one MCP server record
//   llm-source   a bundle repo of skills/agents/commands/templates
//
// Identity is `<kind>:<publisher>/<name>`. Where bytes came from is `source`
// (the shape plugins/source-store.mjs already records and validates: a 40-hex
// commit is the pin, a ref is only a hint). Trust says who published it.
// Nothing here decides what loads; that is the active set's job.

import { validateSource } from '../../plugins/source-store.mjs';

export const KINDS = Object.freeze(['skill', 'plugin', 'mcp', 'llm-source']);
export const TRUST_LEVELS = Object.freeze(['official', 'verified', 'community', 'unknown', 'local']);
export const MEMBER_TYPES = Object.freeze(['skill', 'command', 'agent', 'template', 'hook', 'mcp', 'lsp', 'bin']);
// Components that run code or open connections. A new one never arrives on by
// itself (plan D5) and its trust is per kind.
export const EXECUTABLE_MEMBER_TYPES = Object.freeze(['hook', 'mcp', 'lsp', 'bin']);

const SEG = '[a-z0-9][a-z0-9._-]{0,63}';
export const ITEM_ID_RE = new RegExp(`^(skill|plugin|mcp|llm-source):(${SEG})/(${SEG})$`);
// Member ids are `<type>:<name>`; names follow the LLM-source rule (anything
// printable): a third-party skill may be called "Code Reviewer".
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

const slug = (value, fallback) => {
  const s = String(value ?? '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-._]+|[-._]+$/g, '').slice(0, 64);
  return new RegExp(`^${SEG}$`).test(s) ? s : fallback;
};

export function itemId(kind, publisher, name) {
  if (!KINDS.includes(kind)) throw new Error(`unknown kind '${kind}'`);
  return `${kind}:${slug(publisher, 'local')}/${slug(name, 'unnamed')}`;
}

export function parseItemId(id) {
  const m = typeof id === 'string' ? ITEM_ID_RE.exec(id) : null;
  return m ? { kind: m[1], publisher: m[2], name: m[3] } : null;
}

export function memberId(type, name) {
  if (!MEMBER_TYPES.includes(type)) throw new Error(`unknown member type '${type}'`);
  if (typeof name !== 'string' || !name || name.length > 120 || CONTROL_RE.test(name)) throw new Error('invalid member name');
  return `${type}:${name}`;
}

export function parseMemberId(id) {
  if (typeof id !== 'string') return null;
  const i = id.indexOf(':');
  if (i < 1) return null;
  const type = id.slice(0, i);
  const name = id.slice(i + 1);
  if (!MEMBER_TYPES.includes(type) || !name || name.length > 120 || CONTROL_RE.test(name)) return null;
  return { type, name };
}

/**
 * Who published an item and how far to trust that, from its recorded source.
 *   official  github.com/anthropics/*  (the namespace Claude Code reserves)
 *   unknown   any other recorded git/marketplace source: it is a stranger's
 *             until a later phase can verify it
 *   local     no recorded source: the user's own files or our own kit
 * `verified` and `community` need a catalog we index (P4); nothing here can
 * earn them, so an imported item is never reported as more trusted than it is.
 */
export function publisherFromSource(source) {
  const url = source && typeof source === 'object' ? source.url : null;
  if (typeof url !== 'string' || !url) return { id: 'local', trust: 'local' };
  let host = '';
  let owner = '';
  try {
    const u = new URL(url);
    host = u.hostname.toLowerCase();
    owner = u.pathname.split('/').filter(Boolean)[0] || '';
  } catch {
    const m = /^git@([^:]+):([^/]+)\//.exec(url);
    if (m) { host = m[1].toLowerCase(); owner = m[2]; }
  }
  const id = slug(owner, 'unknown');
  if (host === 'github.com' && owner.toLowerCase() === 'anthropics') return { id, trust: 'official' };
  return { id, trust: 'unknown' };
}

/**
 * A normalised item, or `{ error }`. `source` is validated by the same
 * function that guards plugin provenance (https, public host, no credentials,
 * 40-hex commit); an item with none is `{ kind: 'local' }`.
 */
export function normalizeItem(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'item must be an object' };
  const parsed = parseItemId(raw.id);
  if (!parsed) return { error: 'invalid item id' };
  if (raw.kind !== undefined && raw.kind !== parsed.kind) return { error: 'kind does not match the id' };
  let source = { kind: 'local' };
  if (raw.source && typeof raw.source === 'object' && raw.source.kind !== 'local') {
    const v = validateSource(raw.source);
    if (!v.ok) return { error: `source: ${v.error}` };
    source = v.source;
  }
  const trust = TRUST_LEVELS.includes(raw.publisher?.trust) ? raw.publisher.trust : publisherFromSource(source).trust;
  const members = [];
  const seen = new Set();
  for (const m of Array.isArray(raw.members) ? raw.members : []) {
    const type = m?.type;
    const name = m?.name;
    let id;
    try { id = memberId(type, name); } catch { continue; }
    if (seen.has(id)) continue;
    seen.add(id);
    members.push({ memberId: id, type, name, executable: EXECUTABLE_MEMBER_TYPES.includes(type) });
  }
  const disabledMembers = [...new Set((Array.isArray(raw.state?.disabledMembers) ? raw.state.disabledMembers : [])
    .filter((s) => typeof s === 'string' && parseMemberId(s)))].sort();
  return {
    item: {
      id: raw.id,
      kind: parsed.kind,
      name: parsed.name,
      source,
      version: typeof raw.version === 'string' ? raw.version.slice(0, 64) : null,
      publisher: { id: parsed.publisher, trust },
      members,
      declared: { executableKinds: [...new Set((Array.isArray(raw.declared?.executableKinds) ? raw.declared.executableKinds : [])
        .filter((k) => typeof k === 'string'))].sort() },
      state: {
        enabled: raw.state?.enabled === true,
        disabledMembers,
        consents: raw.state?.consents && typeof raw.state.consents === 'object' ? raw.state.consents : {},
      },
    },
  };
}

/** Is a member on? Members are on unless unchecked (the LLM-source rule: new members arrive on). */
export function isMemberEnabled(item, id) {
  return !item.state.disabledMembers.includes(id);
}
