# Remote Project MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a browser open, edit and save a file in a project hosted on a remote LLM-IDE core, with safe project-root confinement and optimistic conflict detection.

**Architecture:** Add two Host API commands (`files.stat`, `files.write`) to the existing pinned-WSS gateway. The host keeps ownership of the files and the agent. The web client adds a minimal workspace screen that lists, opens, edits and saves one text file.

**Tech Stack:** Node 22, existing `extension/routes/host-api` gateway, generated command schema, React 18 + Vite web client, `node:test`.

**Spec:** `docs/superpowers/specs/2026-11-14-remote-project-mvp.md`

## Global Constraints

- Host API frame limit is 1 MiB; text writes are at most 262,144 bytes.
- `projectId` pattern is `^[A-Za-z0-9_-]{1,128}$`.
- Paths are project-relative POSIX paths; absolute paths and `..` are refused.
- Writes are atomic and return the SHA-256 of the bytes written.
- Do not add a second project-root resolver; reuse `projectFile` / `scopedProjectRoot`.
- Do not send file contents to any log or audit row.
- Phase 1 adds no git, terminal or Loop commands.

---

### Task 1: Command schema and generated types

**Files:**
- Modify: `schema/host-api/v1/commands.json`
- Regenerate: `extension/routes/host-api/commands.generated.mjs`
- Regenerate: `web/src/host-api/types.generated.ts`
- Test: `extension/tests/host-api-contract.test.mjs`

**Interfaces:**
- Produces: commands `files.stat` and `files.write` in `commands.json` with the request/result shapes from the spec.

- [ ] **Step 1: Add the failing contract assertion**

In `extension/tests/host-api-contract.test.mjs`, add:

```js
test('workspace write commands are in the contract', async () => {
  const { HOST_API_COMMANDS } = await import('../routes/host-api/commands.generated.mjs');
  assert.ok(HOST_API_COMMANDS['files.stat']);
  assert.ok(HOST_API_COMMANDS['files.write']);
  assert.equal(HOST_API_COMMANDS['files.write'].capability, 'read');
  assert.equal(HOST_API_COMMANDS['files.write'].idempotent, false);
});
```

- [ ] **Step 2: Run it and confirm failure**

Run: `cd extension && node --test tests/host-api-contract.test.mjs`
Expected: FAIL because `files.write` is undefined.

- [ ] **Step 3: Add the commands to the schema**

Add to `schema/host-api/v1/commands.json`:

```json
"files.stat": {
  "capability": "read",
  "direction": "client_to_host",
  "idempotent": true,
  "request": {
    "type": "object",
    "additionalProperties": false,
    "required": ["projectId", "path"],
    "properties": {
      "projectId": { "type": "string", "pattern": "^[A-Za-z0-9_-]{1,128}$" },
      "path": { "type": "string", "maxLength": 4096 }
    }
  },
  "result": {
    "type": "object",
    "additionalProperties": false,
    "required": ["hash", "size", "mtimeMs"],
    "properties": {
      "hash": { "type": "string", "pattern": "^[a-f0-9]{64}$" },
      "size": { "type": "integer", "minimum": 0 },
      "mtimeMs": { "type": "number", "minimum": 0 }
    }
  }
},
"files.write": {
  "capability": "read",
  "direction": "client_to_host",
  "idempotent": false,
  "request": {
    "type": "object",
    "additionalProperties": false,
    "required": ["projectId", "path", "text"],
    "properties": {
      "projectId": { "type": "string", "pattern": "^[A-Za-z0-9_-]{1,128}$" },
      "path": { "type": "string", "maxLength": 4096 },
      "text": { "type": "string", "maxLength": 262144 },
      "expectedHash": { "type": ["string", "null"], "pattern": "^[a-f0-9]{64}$" },
      "create": { "type": "boolean" }
    }
  },
  "result": {
    "type": "object",
    "additionalProperties": false,
    "required": ["hash", "size"],
    "properties": {
      "hash": { "type": "string", "pattern": "^[a-f0-9]{64}$" },
      "size": { "type": "integer", "minimum": 0 }
    }
  }
}
```

- [ ] **Step 4: Regenerate**

Run: `node scripts/generate-host-api.mjs` from the repository root.

- [ ] **Step 5: Run the contract test**

Run: `cd extension && node --test tests/host-api-contract.test.mjs`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add schema/host-api/v1/commands.json extension/routes/host-api/commands.generated.mjs web/src/host-api/types.generated.ts extension/tests/host-api-contract.test.mjs
git commit -m "feat(host-api): add files.stat and files.write commands"
```

---

### Task 2: Host write helper with confinement

**Files:**
- Create: `extension/routes/host-api/workspace-write.mjs`
- Test: `extension/tests/host-api-workspace-write.test.mjs`

**Interfaces:**
- Consumes: `scopedProjectRoot(userId, projectId, scope)` and `isDeniedPath(abs)` from `gateway.mjs`.
- Produces: `hashText(text)`, `writeProjectFile({ root, path: rel, text, expectedHash, create }) -> { hash, size }`.

- [ ] **Step 1: Write the failing tests**

Create `extension/tests/host-api-workspace-write.test.mjs` with a temp project:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeProjectFile, hashText } from '../routes/host-api/workspace-write.mjs';

function project() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'llmide-write-')));
  fs.mkdirSync(path.join(root, 'src'));
  return root;
}

test('creates a new file and returns its hash', () => {
  const root = project();
  const out = writeProjectFile({ root, path: 'src/a.txt', text: 'one\n', create: true });
  assert.equal(fs.readFileSync(path.join(root, 'src/a.txt'), 'utf8'), 'one\n');
  assert.equal(out.hash, hashText('one\n'));
});

test('refuses a stale hash', () => {
  const root = project();
  const first = writeProjectFile({ root, path: 'a.txt', text: 'one', create: true });
  assert.throws(() => writeProjectFile({ root, path: 'a.txt', text: 'two', expectedHash: '0'.repeat(64) }), /changed/);
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'one');
  assert.equal(first.size, 3);
});

test('refuses a path outside the root and a symlink out', () => {
  const root = project();
  assert.throws(() => writeProjectFile({ root, path: '../x', text: 'x', create: true }), /outside|valid/);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'llmide-out-'));
  fs.symlinkSync(outside, path.join(root, 'link'));
  assert.throws(() => writeProjectFile({ root, path: 'link/x.txt', text: 'x', create: true }), /outside|symbolic/);
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `cd extension && node --test tests/host-api-workspace-write.test.mjs`
Expected: FAIL with module not found.

- [ ] **Step 3: Implement the helper**

```js
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const MAX_TEXT = 262_144;
export const hashText = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

function safeRel(rel) {
  if (typeof rel !== 'string' || rel.length > 4096 || path.isAbsolute(rel)) throw Object.assign(new Error('The path is not valid.'), { code: 'invalid' });
  const parts = rel.replaceAll('\\', '/').split('/');
  if (parts.some((p) => p === '..' || p === '')) throw Object.assign(new Error('The path is not valid.'), { code: 'invalid' });
  return parts.join(path.sep);
}

export function writeProjectFile({ root, path: rel, text, expectedHash, create = false }) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_TEXT || text.includes('\0')) throw Object.assign(new Error('The text is too large or not text.'), { code: 'invalid' });
  const realRoot = fs.realpathSync(root);
  const target = path.resolve(realRoot, safeRel(rel));
  // Find the nearest existing ancestor before creating anything, so a symlinked parent cannot create folders outside.
  let ancestor = path.dirname(target);
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  const realAncestor = fs.realpathSync(ancestor);
  if (realAncestor !== realRoot && !realAncestor.startsWith(realRoot + path.sep)) throw Object.assign(new Error('That path is outside the project.'), { code: 'denied' });
  if (!fs.existsSync(path.dirname(target))) {
    if (!create) throw Object.assign(new Error('That folder does not exist.'), { code: 'not_found' });
    fs.mkdirSync(path.dirname(target), { recursive: true });
  }
  const parent = fs.realpathSync(path.dirname(target));
  if (parent !== realRoot && !parent.startsWith(realRoot + path.sep)) throw Object.assign(new Error('That path is outside the project.'), { code: 'denied' });
  let current = null;
  try {
    if (fs.lstatSync(target).isSymbolicLink()) throw Object.assign(new Error('That path is a symbolic link.'), { code: 'denied' });
    current = hashText(fs.readFileSync(target, 'utf8'));
  } catch (e) { if (e.code === 'denied') throw e; /* missing */ }
  if (expectedHash === null) {
    if (current !== null) throw Object.assign(new Error('The file already exists.'), { code: 'conflict' });
  } else if (expectedHash && current !== expectedHash) {
    throw Object.assign(new Error('The file changed since you opened it.'), { code: 'conflict' });
  }
  const tmp = `${target}.llmide-${process.pid}-${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, target);
  return { hash: hashText(text), size: Buffer.byteLength(text, 'utf8') };
}
```

- [ ] **Step 4: Run the tests**

Run: `cd extension && node --test tests/host-api-workspace-write.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add extension/routes/host-api/workspace-write.mjs extension/tests/host-api-workspace-write.test.mjs
git commit -m "feat(host-api): add confined project file writer"
```

---

### Task 3: Gateway integration, permission and rate limit

**Files:**
- Modify: `extension/routes/host-api/gateway.mjs`
- Modify: `extension/routes/host-api/rate.mjs`
- Modify: `extension/routes/host-api/projects.mjs`
- Test: `extension/tests/host-api-workspace-write.test.mjs`
- Test: `extension/tests/host-api-scopes.test.mjs`

**Interfaces:**
- Consumes: `writeProjectFile`, `hashText` from Task 2.
- Produces: `files.stat` and `files.write` handled on the wire; `files.write` requires `self.write`.

- [ ] **Step 1: Add failing authority assertions**

In `extension/tests/host-api-scopes.test.mjs`:

```js
test('files.write is a project write and files.stat is a read', async () => {
  const { COMMAND_CLASS } = await import('../routes/host-api/gateway.mjs');
  const { PROJECT_FRAME_CLASS } = await import('../routes/host-api/projects.mjs');
  assert.equal(COMMAND_CLASS['files.write'], 'self.write');
  assert.equal(COMMAND_CLASS['files.stat'], 'self.read');
  assert.equal(PROJECT_FRAME_CLASS['files.write'], 'self.write');
  assert.equal(PROJECT_FRAME_CLASS['files.stat'], 'self.read');
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `cd extension && node --test tests/host-api-scopes.test.mjs`
Expected: FAIL with undefined mappings.

- [ ] **Step 3: Add the mappings and a write bucket**

In `gateway.mjs` `COMMAND_CLASS`:

```js
'files.stat': 'self.read',
'files.write': 'self.write',
```

In `projects.mjs` `PROJECT_FRAME_CLASS`:

```js
'files.stat': 'self.read',
'files.write': 'self.write',
```

In `rate.mjs` add:

```js
writeCapacity: 10, writePerSecond: 0.5, // per device; each write can replace up to 256 KiB
```

and a `writes` map plus:

```js
write: (deviceId, now) => take(writes, deviceId, limits.writeCapacity, limits.writePerSecond, now),
```

- [ ] **Step 4: Add the two gateway cases**

In `gateway.mjs`, after `files.read`:

```js
case 'files.stat': {
  if (readRefused(s, entry, id)) return;
  try {
    const { real, st } = projectFile(userId, p.projectId, p.path);
    const hash = hashText(fs.readFileSync(real, 'utf8'));
    return respond(s, id, command, { hash, size: st.size, mtimeMs: st.mtimeMs });
  } catch (e) { return fail(s, id, e.code === 'not_found' ? 'not_found' : e.code === 'invalid' ? 'invalid_payload' : 'denied', String(e.message || e)); }
}
case 'files.write': {
  const wait = rate.write(entry.state.deviceId, deps.now());
  if (wait != null) { rateRefused(s, entry, id, wait); return; }
  try {
    const root = scopedProjectRoot(userId, p.projectId);
    const out = writeProjectFile({ root, path: p.path, text: p.text, expectedHash: p.expectedHash, create: p.create === true });
    audit('file_write', { peer: entry.peer, userId, deviceId: entry.state.deviceId, detail: `${p.projectId}:${p.path}:${out.size}` });
    return respond(s, id, command, out);
  } catch (e) {
    const code = e.code === 'conflict' ? 'conflict' : e.code === 'not_found' ? 'not_found' : e.code === 'invalid' ? 'invalid_payload' : 'denied';
    return fail(s, id, code, String(e.message || e));
  }
}
```

Add the imports:

```js
import { hashText, writeProjectFile } from './workspace-write.mjs';
```

- [ ] **Step 5: Run the tests**

Run: `cd extension && node --test tests/host-api-workspace-write.test.mjs tests/host-api-scopes.test.mjs tests/host-api-contract.test.mjs`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add extension/routes/host-api/gateway.mjs extension/routes/host-api/rate.mjs extension/routes/host-api/projects.mjs extension/tests/host-api-workspace-write.test.mjs extension/tests/host-api-scopes.test.mjs
git commit -m "feat(host-api): handle files.stat and files.write"
```

---

### Task 4: Web API client

**Files:**
- Create: `web/src/workspace/api.ts`
- Create: `web/src/workspace/model.ts`
- Test: `web/src/workspace/model.test.mjs`

**Interfaces:**
- Produces: `statFile(link, projectId, path)`, `writeFile(link, projectId, path, text, expectedHash, create)`, `dirtyOf(buffer, saved)`, `conflictText(error)`.

- [ ] **Step 1: Write the failing model tests**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirtyOf, conflictText } from './model.ts';

test('dirty is false when the buffer matches the saved text', () => {
  assert.equal(dirtyOf('a', 'a'), false);
  assert.equal(dirtyOf('a', 'b'), true);
});

test('a conflict explains how to recover', () => {
  assert.match(conflictText('changed'), /reload/i);
});
```

- [ ] **Step 2: Run to fail**

Run: `cd web && node --test src/workspace/model.test.mjs`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement the model and session methods**

```ts
export const dirtyOf = (buffer: string, saved: string): boolean => buffer !== saved;
export const conflictText = (reason: string): string =>
  `The file changed on the host (${reason}). Reload it before saving again.`;
```

`api.ts`:

```ts
import type { HostLink } from "../host-api/connection.ts";

export const statFile = (link: HostLink, projectId: string, path: string) =>
  link.send("files.stat", { projectId, path }).done;

export const writeFile = (link: HostLink, projectId: string, path: string, text: string, expectedHash: string | null, create: boolean) =>
  link.send("files.write", { projectId, path, text, expectedHash, create }).done;
```

- [ ] **Step 4: Run the model test**

Run: `cd web && node --test src/workspace/model.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/workspace/api.ts web/src/workspace/model.ts web/src/workspace/model.test.mjs
git commit -m "feat(web): add file stat/write client"
```

---

### Task 5: Web workspace screen

**Files:**
- Create: `web/src/workspace/Workspace.tsx`
- Create: `web/src/workspace/workspace.css`
- Modify: `web/src/App.tsx`
- Test: `web/src/workspace/workspace.test.mjs` (pure helpers only)

**Interfaces:**
- Consumes: `files.list`, `files.read`, `files.stat`, `files.write`, the selected project.
- Produces: a Workspace tab with a file list, textarea and Save.

- [ ] **Step 1: Add a failing helper test**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { saveAllowed } from './model.ts';

test('Save is enabled only for a dirty buffer', () => {
  assert.equal(saveAllowed({ dirty: false, saving: false }), false);
  assert.equal(saveAllowed({ dirty: true, saving: false }), true);
});
```

- [ ] **Step 2: Run to fail**

Run: `cd web && node --test src/workspace/workspace.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Implement the screen**

The screen:

- lists `files.list` entries and descends into directories
- calls `files.read` plus `files.stat` on open
- keeps `{ path, saved, buffer, hash }`
- calls `files.write` with `expectedHash: hash, create: false`
- on `conflict`, shows `conflictText` and a Reload button
- on success, sets `saved = buffer`, `hash = result.hash`
- renders a plain textarea; no CodeMirror dependency in Phase 1

Add `saveAllowed`:

```tsx
export function saveAllowed(s: { dirty: boolean; saving: boolean }): boolean {
  return s.dirty && !s.saving;
}
```

- [ ] **Step 4: Integrate the tab**

In `web/src/App.tsx`, add a **Workspace** tab that appears only when a project is selected and the connection has the `read` capability.

- [ ] **Step 5: Run the web tests and typecheck**

Run: `cd web && node --test src/workspace/*.test.mjs && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/src/workspace web/src/App.tsx
git commit -m "feat(web): add a remote workspace editor"
```

---

### Task 6: Remote host runbook and acceptance

**Files:**
- Create: `docs/how-to/remote-project-host.md`
- Modify: `docs/superpowers/specs/2026-11-14-remote-project-mvp.md` only if behavior changed

- [ ] **Step 1: Write the runbook**

Include exact commands:

```bash
# on the server
git clone <repo> /srv/projects/app
cd /srv/projects/app
mkdir -p system
printf '{"name":"app"}\n' > system/project.json

# core with its own data directory
export LLMIDE_DATA_DIR=/var/lib/llmide
node /opt/llmide/extension/server.mjs

# register the project (desktop/admin route)
curl -X POST http://127.0.0.1:3456/kb/projects/register \
  -H 'content-type: application/json' \
  -d '{"name":"app","root":"/srv/projects/app"}'
```

Then pair web with the host's Host API and test:

1. open a text file
2. change one line
3. Save
4. confirm on the server with `git diff`
5. change the file on the server, then Save from web → conflict
6. change a path to `../x` → refused

- [ ] **Step 2: Run the acceptance checklist**

Record the command output for each item in the spec under a new `## Verification` section.

- [ ] **Step 3: Commit**

```bash
git add docs/how-to/remote-project-host.md docs/superpowers/specs/2026-11-14-remote-project-mvp.md
git commit -m "docs: remote project host runbook"
```

---

## Phase 2 / 3 (separate plans, not this one)

- git status/diff/commit UI
- terminal exec with approvals
- desktop remote client
- Loop runner on the host
- iPhone review/approve
- team roles and audit UI

Do not start those in this plan.
