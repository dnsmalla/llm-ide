# Remote Git read Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or executing-plans.

**Goal:** Add read-only git status/diff to the remote web workspace.

**Architecture:** Add two Host API read commands backed by a shell-free `git` helper. The web Workspace gets a Changes pane.

**Tech Stack:** Node 22, Host API v1, React 18 web, `node:test`.

**Spec:** `docs/superpowers/specs/2026-11-15-remote-git-read.md`

## Global Constraints

- No shell interpolation; `execFileSync('git', args)` only.
- Diff cap 262,144 bytes.
- `path` project-relative, no `..`, after `--`.
- Both commands `self.read`; no writes.
- Generated files must pass `node scripts/generate-host-api.mjs --check`.

---

### Task 1: Git helper

**Files:**
- Create: `extension/routes/host-api/git-read.mjs`
- Test: `extension/tests/host-api-git-read.test.mjs`

**Interfaces:**
- Produces: `gitStatus(root)`, `gitDiff(root, { path, staged })`.

- [ ] **Step 1: Write failing tests**

Create a temp repo, `git init`, config user, commit a file, then:

```js
assert.equal(gitStatus(root).clean, true);
fs.writeFileSync(path.join(root, 'a.txt'), 'two\n');
const s = gitStatus(root);
assert.equal(s.clean, false);
assert.equal(s.entries.find((e) => e.path === 'a.txt').status, ' M'.trim());
assert.match(gitDiff(root, { path: 'a.txt' }).patch, /\+two/);
assert.throws(() => gitDiff(root, { path: '../outside' }), /path/);
```

- [ ] **Step 2: Run to fail**

`cd extension && node --test tests/host-api-git-read.test.mjs`

- [ ] **Step 3: Implement**

Use `execFileSync('git', ['--no-optional-locks', '-C', root, ...], { encoding: 'utf8', timeout: 5000, maxBuffer: 1 << 20 })`.

Status:

```js
git(['status', '--porcelain=v1', '-z'])
```

Parse NUL records: `XY path`, rename records have a second path.

Branch: `rev-parse --abbrev-ref HEAD`. Ahead/behind: `rev-list --left-right --count @{u}...HEAD`, catch no-upstream as 0/0.

Diff:

```js
git(['--no-ext-diff', '--no-color', '--no-optional-locks', 'diff', ...(staged ? ['--cached'] : []), '--unified=3', '--', rel])
```

- [ ] **Step 4: Run tests**

`cd extension && node --test tests/host-api-git-read.test.mjs` → PASS.

- [ ] **Step 5: Commit**

```bash
git add extension/routes/host-api/git-read.mjs extension/tests/host-api-git-read.test.mjs
git commit -m "feat(host-api): add read-only git status and diff"
```

---

### Task 2: Commands, permission, gateway

**Files:**
- Modify: `schema/host-api/v1/commands.json`, README, four fixtures, counts
- Regenerate five outputs
- Modify: `extension/routes/host-api/gateway.mjs`, `projects.mjs`
- Test: `extension/tests/host-api-scopes.test.mjs`

- [ ] Add `git.status` / `git.diff` (capability `read`, `v2Tag: null`).
- [ ] Counts 36 → 38 everywhere; fixtures; README rows.
- [ ] `COMMAND_CLASS` and `PROJECT_FRAME_CLASS` = `self.read`.
- [ ] Gateway cases use `scopedProjectRoot` and `gitStatus`/`gitDiff`; map errors to `denied` / `invalid_payload` / `internal`.
- [ ] Run `node scripts/generate-host-api.mjs`, contract/conformance/scopes, commit.

---

### Task 3: Web API and Changes pane

**Files:**
- Modify: `web/src/workspace/api.ts`
- Create: `web/src/workspace/Changes.tsx`, `changes.css`
- Modify: `web/src/workspace/Workspace.tsx`
- Test: `web/tests/workspace-changes.test.mjs`

- [ ] API: `gitStatus(link, projectId)`, `gitDiff(link, projectId, path, staged)`.
- [ ] Changes pane: branch/ahead/behind, entries, selected diff, empty state.
- [ ] Test pure `statusLabel(x, y)` mapping.
- [ ] Run web tests, tsc, build; commit.

---

### Task 4: Runbook and limits

- [ ] Extend `docs/how-to/remote-project-host.md` with a Changes section and the read-only boundary.
- [ ] Run acceptance on a temp repo and record it.
- [ ] Commit.

## Later phases

Commit/push, terminal, desktop client, Loop on host, iPhone.
