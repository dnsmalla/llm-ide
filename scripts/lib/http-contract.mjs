// Loads the HTTP contract: every group file in schema/http/*.schema.json, plus the
// agent-v2 event schema that SSE responses reference through x-events.
// Shared by gen-api-types.mjs and gen-openapi.mjs so both read the same documents.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const EVENT_SCHEMAS = ['schema/agent-v2/agent-v2.schema.json', 'schema/os/os-events.schema.json'];

// Returns a Map: document id -> { id, rel, json, event? }. Group documents come
// first (sorted by file name), event documents after them.
export function loadContractDocs(root) {
  const schemaDir = join(root, 'schema/http');
  const docs = new Map();
  const groupFiles = readdirSync(schemaDir)
    .filter((f) => f.endsWith('.schema.json'))
    .sort();
  for (const f of groupFiles) {
    const id = f.replace(/\.schema\.json$/, '');
    const rel = `schema/http/${f}`;
    docs.set(id, { id, rel, json: JSON.parse(readFileSync(join(schemaDir, f), 'utf8')) });
  }
  for (const rel of EVENT_SCHEMAS) {
    const id = rel.split('/').pop().replace(/\.schema\.json$/, '');
    docs.set(id, { id, rel, json: JSON.parse(readFileSync(join(root, rel), 'utf8')), event: true });
  }
  return docs;
}
