# Auto-System Feature-Slice Library — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure auto-system's 5,889-line template monolith into versioned, individually installable feature slices with a provenance-based upgrade path, plus a kit skill so llm-ide agents assemble apps by *copying* fixed code instead of generating it.

**Architecture:** A new `core/src/feature-library/` (manifest loader, shared placeholder substitution, lockfile, installer, upgrader) reads real file trees under `features/<slice>/`. The monolith is extracted slice-by-slice with byte-parity locked by golden fixtures captured *before* extraction. `generate:templates` becomes an orchestrator over slices. A central-kit skill exposes the catalog to llm-ide agents.

**Tech Stack:** TypeScript (Node ≥18), commander CLI, vitest, `yaml` + `zod` (already deps), ts-node for repo scripts.

**Spec:** `docs/superpowers/specs/2026-08-27-auto-system-feature-slices-design.md` (llm-ide repo)

## Global Constraints

- **Working repo:** `dnsmalla/auto-system` on branch `feat/feature-slices` (clone fresh: `git clone git@github.com:dnsmalla/auto-system.git && cd auto-system && git checkout -b feat/feature-slices`). Tasks 1–15 happen there. Task 16 touches `dnsmalla/skills` (via llm-ide's checked-out `.skills` submodule) and llm-ide itself.
- **Strict byte parity:** every task that touches generation must leave `npx vitest run core/test/templates/golden-parity.test.ts` green before commit.
- **Golden fixtures are captured in Task 1, before any extraction** — never regenerated after.
- **Lockfile/manifest safety:** unparsable lockfile → treat all files as suspect (full conflict report), never silent overwrite.
- **Upgrade rule:** user-modified files are reported as conflicts with diffs, never overwritten.
- **No new runtime deps** (`yaml`, `zod` already present). ts-node already a devDep.
- **Commits:** Conventional Commits, one concern per commit, in the auto-system repo unless a task says otherwise.
- **Node ≥18, `npm run build` (tsc) and `npm test` (vitest) must pass at every task boundary.**
- Catalog JSON shape is versioned (`schema: 1`).

### Key existing symbols (verified in auto-system @ v5.17.1)

| Symbol | Location |
|---|---|
| `generateTemplates(config)` | `core/src/templates/generator.ts:5425` |
| `WEB_TEMPLATES` / `IOS_TEMPLATES` / `ANDROID_TEMPLATES` / `BACKEND_TEMPLATES` | same file, lines 125 / 2328 / 2725 / 3144 (unexported `Record<string, string>`: relpath → template body) |
| `applyPlaceholders` closure + placeholder map | same file, ~5432–5577; `APP_NAME_PLACEHOLDER = '{{APP_NAME}}'` at :34 |
| `buildSkipFilter` | same file (~5588 call sites) |
| `getActivePlatforms(config)` | `core/src/config/platforms.ts:36` |
| `loadRegistry()` | `core/src/upgrade/registry.ts:12` |
| `validatePathWithinWorkspace` | `core/src/utils/security.ts:39` |
| `safeWriteFile(path, content)` | `core/src/utils/safe-write.ts` |
| CLI pattern (`withCommand`, `loadConfigWithPlatformFilter`, `PLATFORMS_OPTION`, chalk) | `core/src/index.ts` (generate:templates at :532) |
| `master.sh` passes all commands through via `exec node "$CLI_ENTRY" "$@"` | `master.sh` (final line) — only help text needs editing |

---

### Task 1: Golden fixture harness — lock today's output

**Files:**
- Create: `core/scripts/capture-golden.ts`
- Create: `core/test/templates/golden/default/.auto_system/system.yaml`
- Create: `core/test/templates/golden/high-security/.auto_system/system.yaml`
- Create: `core/test/templates/golden/minimal/.auto_system/system.yaml`
- Create: `core/test/templates/golden/<name>/snapshot/` (captured trees, committed)
- Test: `core/test/templates/golden-parity.test.ts`

**Interfaces:**
- Consumes: `generateTemplates(config)`, `ConfigManager.getInstance().loadConfig()` (both existing).
- Produces: `runGoldenCase(name: string, dir: string): Promise<void>` helper exported from the test file's capture sibling; golden trees later tasks diff against. Nothing outside this task imports it.

- [x] **Step 1: Write the three fixture configs**

`core/test/templates/golden/default/.auto_system/system.yaml`:

```yaml
project:
  name: MyApp
  version: 1.0.0
platforms:
  - { name: web, path: apps/web, active: true }
  - { name: ios, path: apps/ios/MyApp, active: true }
  - { name: android, path: apps/android, active: true }
  - { name: backend, path: services/core-api, active: true }
advisor:
  description: A task management app with team collaboration.
  features: [User authentication, Real-time chat, Push notifications]
  securityLevel: standard
  quality: { performance: standard, designPolish: true }
```

`core/test/templates/golden/minimal/.auto_system/system.yaml`: same minus `ios` and `android` platform entries, `securityLevel: standard`.

`core/test/templates/golden/high-security/.auto_system/system.yaml`: same as default plus:

```yaml
advisor:
  description: A high-security financial app.
  features: [User authentication, Audit log]
  securityLevel: high
  quality: { performance: pro, designPolish: true }
auth:
  password: { minLength: 12, minDistinctClasses: 3 }
  session: { accessTokenTtl: 1800, refreshTokenTtl: 2592000 }
  lockout: { maxAttempts: 3, lockMinutes: 30 }
backend:
  passwordHash: { algorithm: argon2id }
```

- [x] **Step 2: Verify fixture YAML keys against the schema**

Run: `cd core && grep -n "passwordHash\|securityLevel\|lockout" src/config/schema.ts | head -20`
Expected: the keys above exist in `SystemConfig` schema. Fix fixture keys to match the schema's real names if they differ (the schema is authoritative).

- [x] **Step 3: Extend the high-security fixture to exercise the OAuth path**

Run: `cd core && grep -n -A 12 "function generatableOAuthProviders" src/templates/generator.ts`
Read the provider-declaration shape (e.g. `auth.oauth.providers: [google]`), then add the matching block declaring `google` to `high-security/.auto_system/system.yaml`. This ensures the OAuth emitter output is goldened.

- [x] **Step 4: Write `core/scripts/capture-golden.ts`**

```ts
// One-shot: regenerate golden snapshots from the CURRENT generator.
// Usage: npx ts-node scripts/capture-golden.ts   (run from core/)
import { mkdirSync, cpSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { generateTemplates } from '../src/templates/generator';
import { ConfigManager } from '../src/config/manager';

const GOLDEN_ROOT = resolve(__dirname, '../test/templates/golden');

async function capture(name: string) {
  const caseDir = join(GOLDEN_ROOT, name);
  const work = join(caseDir, 'work');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  process.chdir(work); // generateTemplates resolves platform paths from cwd
  const config = await ConfigManager.getInstance().loadConfig();
  await generateTemplates(config);
  process.chdir(caseDir);
  rmSync(join(caseDir, 'snapshot'), { recursive: true, force: true });
  cpSync(join(caseDir, 'work'), join(caseDir, 'snapshot'), { recursive: true });
  rmSync(work, { recursive: true, force: true });
  console.log(`captured ${name}`);
}

(async () => {
  for (const name of ['default', 'high-security', 'minimal']) await capture(name);
})();
```

Adapt to reality: if `ConfigManager.loadConfig()` cannot be pointed at the work dir via cwd, find its config-path override (grep `class ConfigManager` in `core/src/config/`) and pass the case's `system.yaml` explicitly. `generateTemplates` must see `work` as the project root.

- [x] **Step 5: Capture and commit the snapshots**

Run: `cd core && npx ts-node scripts/capture-golden.ts && git add test/templates/golden && git status`
Expected: three `snapshot/` trees committed, each containing the generated `apps/`, `services/`, `docs/` files for its fixture. **These snapshots are now frozen — never regenerate them.**

- [x] **Step 6: Write the parity test**

`core/test/templates/golden-parity.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mkdirSync, rmSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { generateTemplates } from '../../src/templates/generator';
import { ConfigManager } from '../../src/config/manager';

const GOLDEN_ROOT = resolve(__dirname, 'golden');
const CASES = ['default', 'high-security', 'minimal'];

function walk(dir: string, base = dir, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, base, acc);
    else acc.push(p.slice(base.length + 1));
  }
  return acc;
}

describe('golden template parity', () => {
  for (const name of CASES) {
    it(`${name}: byte-identical to golden snapshot`, async () => {
      const caseDir = join(GOLDEN_ROOT, name);
      const work = join(caseDir, 'work');
      rmSync(work, { recursive: true, force: true });
      mkdirSync(work, { recursive: true });
      const cwd = process.cwd();
      process.chdir(work);
      try {
        const config = await ConfigManager.getInstance().loadConfig();
        await generateTemplates(config);
      } finally {
        process.chdir(cwd);
      }
      const goldenFiles = walk(join(caseDir, 'snapshot')).sort();
      const workFiles = walk(work).sort();
      expect(workFiles).toEqual(goldenFiles);
      for (const rel of goldenFiles) {
        expect(readFileSync(join(work, rel)).equals(readFileSync(join(caseDir, 'snapshot', rel))))
          .toBe(true);
      }
      rmSync(work, { recursive: true, force: true });
    }, 120_000);
  }
});
```

If the `loadConfig()`-via-cwd assumption is wrong, apply the same override found in Step 4 here.

- [x] **Step 7: Run — expect PASS (it tests today's unchanged behavior)**

Run: `cd core && npx vitest run test/templates/golden-parity.test.ts`
Expected: 3 passed.

- [x] **Step 8: Commit**

```bash
git add core/scripts/capture-golden.ts core/test/templates/golden core/test/templates/golden-parity.test.ts
git commit -m "test: capture golden template fixtures locking current generate:templates output"
```

---

### Task 2: Feature-library manifest model + catalog

**Files:**
- Create: `core/src/feature-library/manifest.ts`
- Test: `core/test/feature-library/manifest.test.ts`

**Interfaces:**
- Produces (used by Tasks 5, 6, 13, 14, 15):
  - `interface SliceManifest { id: string; version: string; description: string; platforms: Platform[]; requires: string[]; configKeys: string[]; emitters: string[]; upgradeNotes?: string }`
  - `type Platform = 'web' | 'ios' | 'android' | 'backend'`
  - `interface SliceInfo { manifest: SliceManifest; dir: string }`
  - `loadManifest(sliceDir: string): Promise<SliceManifest>` — throws on invalid
  - `listSlices(featuresRoot: string): Promise<SliceInfo[]>` — sorted by id
  - `resolveFeaturesRoot(): string` — `process.env.AUTO_SYSTEM_FEATURES_ROOT ?? <repo-root>/features` where repo-root is resolved by walking up from `__dirname` until a dir containing `master.sh` and `core/` is found

- [x] **Step 1: Write the failing tests**

`core/test/feature-library/manifest.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadManifest, listSlices } from '../../src/feature-library/manifest';

const root = join(tmpdir(), `fl-manifest-${process.pid}`);
const valid = join(root, 'legal');

beforeAll(() => {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(valid, 'files', 'web'), { recursive: true });
  writeFileSync(join(valid, 'manifest.yaml'), [
    'id: legal',
    'version: 0.1.0',
    'description: Privacy, terms, cookies pages + legal hub',
    'platforms: [web, ios, android]',
    'requires: []',
    'config-keys: [project.name, advisor]',
    'emitters: []',
    '',
  ].join('\n'));
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('loadManifest', () => {
  it('parses a valid manifest', async () => {
    const m = await loadManifest(valid);
    expect(m.id).toBe('legal');
    expect(m.platforms).toEqual(['web', 'ios', 'android']);
    expect(m.requires).toEqual([]);
  });
  it('rejects id not matching directory name', async () => {
    const bad = join(root, 'wrong-name');
    mkdirSync(join(bad), { recursive: true });
    writeFileSync(join(bad, 'manifest.yaml'), 'id: other\nversion: 0.1.0\ndescription: x\nplatforms: [web]\nrequires: []\nconfig-keys: []\nemitters: []\n');
    await expect(loadManifest(bad)).rejects.toThrow(/directory name/);
  });
  it('rejects non-semver version', async () => {
    const bad = join(root, 'badver');
    mkdirSync(bad, { recursive: true });
    writeFileSync(join(bad, 'manifest.yaml'), 'id: badver\nversion: latest\ndescription: x\nplatforms: [web]\nrequires: []\nconfig-keys: []\nemitters: []\n');
    await expect(loadManifest(bad)).rejects.toThrow(/version/);
  });
  it('rejects unknown platform', async () => {
    const bad = join(root, 'badplat');
    mkdirSync(bad, { recursive: true });
    writeFileSync(join(bad, 'manifest.yaml'), 'id: badplat\nversion: 0.1.0\ndescription: x\nplatforms: [winphone]\nrequires: []\nconfig-keys: []\nemitters: []\n');
    await expect(loadManifest(bad)).rejects.toThrow(/platform/);
  });
});

describe('listSlices', () => {
  it('lists all slices sorted', async () => {
    const slices = await listSlices(root);
    expect(slices.map((s) => s.manifest.id)).toContain('legal');
  });
});
```

- [x] **Step 2: Run — expect FAIL (module missing)**

Run: `cd core && npx vitest run test/feature-library/manifest.test.ts`
Expected: FAIL — cannot resolve `../../src/feature-library/manifest`.

- [x] **Step 3: Implement `core/src/feature-library/manifest.ts`**

```ts
import { readFile, readdir } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

export type Platform = 'web' | 'ios' | 'android' | 'backend';

const Platforms = z.enum(['web', 'ios', 'android', 'backend']);

const ManifestSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/, 'slice id must be kebab-case'),
  version: z.string().regex(/^\d+\.\d+\.\d+$/, 'version must be semver (MAJOR.MINOR.PATCH)'),
  description: z.string().min(1),
  platforms: z.array(Platforms).min(1),
  requires: z.array(z.string()),
  'config-keys': z.array(z.string()),
  emitters: z.array(z.string()),
  'upgrade-notes': z.string().optional(),
});

export interface SliceManifest {
  id: string;
  version: string;
  description: string;
  platforms: Platform[];
  requires: string[];
  configKeys: string[];
  emitters: string[];
  upgradeNotes?: string;
}

export interface SliceInfo {
  manifest: SliceManifest;
  dir: string;
}

export async function loadManifest(sliceDir: string): Promise<SliceManifest> {
  const raw = await readFile(join(sliceDir, 'manifest.yaml'), 'utf8');
  const parsed = ManifestSchema.parse(parseYaml(raw));
  if (parsed.id !== sliceDir.split(/[\\/]/).pop()) {
    throw new Error(`manifest id "${parsed.id}" must match directory name`);
  }
  return {
    id: parsed.id,
    version: parsed.version,
    description: parsed.description,
    platforms: parsed.platforms,
    requires: parsed.requires,
    configKeys: parsed['config-keys'],
    emitters: parsed.emitters,
    upgradeNotes: parsed['upgrade-notes'],
  };
}

export async function listSlices(featuresRoot: string): Promise<SliceInfo[]> {
  if (!existsSync(featuresRoot)) return [];
  const entries = (await readdir(featuresRoot, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  const out: SliceInfo[] = [];
  for (const name of entries) {
    const dir = join(featuresRoot, name);
    if (existsSync(join(dir, 'manifest.yaml'))) out.push({ manifest: await loadManifest(dir), dir });
  }
  return out;
}

/** Engine repo root = nearest ancestor of this module containing master.sh + core/. */
export function resolveEngineRoot(startDir: string = dirname(__dirname)): string {
  let dir = resolve(startDir);
  while (true) {
    if (existsSync(join(dir, 'master.sh')) && existsSync(join(dir, 'core'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error('engine root not found (master.sh + core/) from ' + startDir);
    dir = parent;
  }
}

export function resolveFeaturesRoot(): string {
  return process.env.AUTO_SYSTEM_FEATURES_ROOT ?? join(resolveEngineRoot(), 'features');
}
```

Note: when compiled to `dist/feature-library/manifest.js`, `dirname(__dirname)` is `<root>/core/dist/feature-library` — the walk-up handles both src (via ts-node) and dist.

- [x] **Step 4: Run — expect PASS**

Run: `cd core && npx vitest run test/feature-library/manifest.test.ts`
Expected: 5 passed.

- [x] **Step 5: Commit**

```bash
git add core/src/feature-library/manifest.ts core/test/feature-library/manifest.test.ts
git commit -m "feat: feature-library manifest model and catalog loader"
```

---

### Task 3: Shared substitution module (verbatim move)

**Files:**
- Create: `core/src/feature-library/substitute.ts`
- Modify: `core/src/templates/generator.ts` (replace inline placeholder map + `applyPlaceholders` with imports — lines ~5432–5577)
- Test: `core/test/feature-library/substitute.test.ts`

**Interfaces:**
- Consumes: the placeholder-map construction currently inline in `generateTemplates` (moved, not rewritten).
- Produces (used by Tasks 5, 13):
  - `interface PlaceholderContext { appName: string; appDomain: string; placeholders: Record<string, string> }`
  - `buildPlaceholderContext(config: SystemConfig): PlaceholderContext`
  - `applyPlaceholders(content: string, ctx: PlaceholderContext): string` — identical algorithm: global `{{APP_NAME}}` + `{{APP_DOMAIN}}` replace, then `split('{{KEY}}').join(value)` per placeholder.

- [x] **Step 1: Write the failing tests**

`core/test/feature-library/substitute.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildPlaceholderContext, applyPlaceholders } from '../../src/feature-library/substitute';
import type { SystemConfig } from '../../src/config/schema';

const baseConfig = {
  project: { name: 'My App', version: '1.0.0' },
  platforms: [{ name: 'backend', path: 'services/core-api', active: true }],
} as unknown as SystemConfig;

describe('applyPlaceholders', () => {
  it('replaces APP_NAME globally including spaces', () => {
    const ctx = buildPlaceholderContext(baseConfig);
    const out = applyPlaceholders('const APP = "{{APP_NAME}}"; // {{APP_NAME}}', ctx);
    expect(out).toBe('const APP = "My App"; // My App');
  });
  it('keeps unknown placeholders untouched', () => {
    const ctx = buildPlaceholderContext(baseConfig);
    expect(applyPlaceholders('{{NOPE}}', ctx)).toBe('{{NOPE}}');
  });
  it('substitutes multi-line placeholder values safely (no regex escaping issues)', () => {
    const ctx = buildPlaceholderContext(baseConfig);
    ctx.placeholders['AUTH_HASH_FUNCS'] = 'a.*b\n[c]$1';
    expect(applyPlaceholders('{{AUTH_HASH_FUNCS}}', ctx)).toBe('a.*b\n[c]$1');
  });
  it('derives APP_DOMAIN by lowercasing and stripping spaces', () => {
    const ctx = buildPlaceholderContext(baseConfig);
    expect(applyPlaceholders('{{APP_DOMAIN}}', ctx)).toBe('myapp.com');
  });
});
```

- [x] **Step 2: Run — expect FAIL**

Run: `cd core && npx vitest run test/feature-library/substitute.test.ts`
Expected: FAIL — module missing.

- [x] **Step 3: Move the code verbatim**

Cut from `core/src/templates/generator.ts` (inside `generateTemplates`, ~5432–5577): the `authPlaceholders` map construction (including `narrative`, `webFont`, hash-algorithm variants, jobs/webhook/backend/db/project blocks) and the `applyPlaceholders` closure. Paste into `core/src/feature-library/substitute.ts` as:

```ts
import type { SystemConfig } from '../config/schema';

export interface PlaceholderContext {
  appName: string;
  appDomain: string;
  placeholders: Record<string, string>;
}

const APP_NAME_PLACEHOLDER = '{{APP_NAME}}';

export function buildPlaceholderContext(config: SystemConfig): PlaceholderContext {
  const appName = config.project.name;
  const appDomain = `${config.project.name.toLowerCase().replace(/\s+/g, '')}.com`;
  // ... authPlaceholders construction moved VERBATIM from generator.ts ...
  const placeholders: Record<string, string> = { /* the moved map */ };
  return { appName, appDomain, placeholders };
}

export function applyPlaceholders(content: string, ctx: PlaceholderContext): string {
  let out = content
    .replace(new RegExp(APP_NAME_PLACEHOLDER, 'g'), ctx.appName)
    .replace(/\{\{APP_DOMAIN\}\}/g, ctx.appDomain);
  for (const [key, value] of Object.entries(ctx.placeholders)) {
    out = out.split(`{{${key}}}`).join(value);
  }
  return out;
}
```

The `/* the moved map */` body is the literal statements from generator.ts (narrative/webFont/scryptConsts/argon2Funcs/authPlaceholders/etc.) — copy them unchanged; only the variable *names* at the boundary change (`authPlaceholders` → returned as `placeholders`). In `generator.ts`, replace the moved region with:

```ts
const placeholderCtx = buildPlaceholderContext(config);
// every former applyPlaceholders(x) call becomes applyPlaceholders(x, placeholderCtx)
```

Keep `hasOAuth`, `isArgon2` etc. as local re-derivations in `generator.ts` **only if** still used elsewhere in that function (grep before deleting; they are used for OAUTH_MOUNT-style conditionals that remain in template bodies as placeholders — if only the moved map used them, they move too).

- [x] **Step 4: Run the FULL suite — parity is the real test**

Run: `cd core && npx vitest run`
Expected: ALL pass, including `golden-parity.test.ts` (3/3). A golden failure means the move altered substitution — fix until byte-identical.

- [x] **Step 5: Commit**

```bash
git add core/src/feature-library/substitute.ts core/src/templates/generator.ts core/test/feature-library/substitute.test.ts
git commit -m "refactor: extract placeholder substitution into feature-library (no behavior change)"
```

---

### Task 4: Lockfile

**Files:**
- Create: `core/src/feature-library/lockfile.ts`
- Test: `core/test/feature-library/lockfile.test.ts`

**Interfaces:**
- Produces (used by Tasks 5, 13, 6):
  - `interface FileRecord { sha256: string; emitter?: string }`
  - `interface SliceRecord { version: string; engineVersion: string; placeholders: Record<string, string>; files: Record<string, FileRecord>; pendingConflicts: string[] }`
  - `interface Lockfile { schema: 1; slices: Record<string, SliceRecord> }`
  - `readLockfile(projectRoot: string): Promise<{ lockfile: Lockfile; suspect: boolean }>` — missing file → `{ lockfile: { schema: 1, slices: {} }, suspect: false }`; unparsable → empty lockfile + `suspect: true` (callers treat every file as a conflict candidate)
  - `writeLockfile(projectRoot: string, lockfile: Lockfile): Promise<void>` — pretty-printed JSON to `.auto_system/features.lock`
  - `sha256(content: string): string`
  - `lockfilePath(projectRoot: string): string`

- [x] **Step 1: Write the failing tests**

`core/test/feature-library/lockfile.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readLockfile, writeLockfile, sha256, lockfilePath } from '../../src/feature-library/lockfile';

const root = join(tmpdir(), `fl-lock-${process.pid}`);
beforeAll(() => mkdirSync(root, { recursive: true }));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('lockfile', () => {
  it('missing lockfile reads as empty, not suspect', async () => {
    const { lockfile, suspect } = await readLockfile(root);
    expect(lockfile.slices).toEqual({});
    expect(suspect).toBe(false);
  });
  it('roundtrips a slice record', async () => {
    await writeLockfile(root, {
      schema: 1,
      slices: {
        legal: {
          version: '0.1.0',
          engineVersion: '5.17.1',
          placeholders: { APP_NAME: 'My App' },
          files: { 'apps/web/app/legal/page.tsx': { sha256: sha256('x') } },
          pendingConflicts: [],
        },
      },
    });
    const { lockfile, suspect } = await readLockfile(root);
    expect(suspect).toBe(false);
    expect(lockfile.slices.legal.files['apps/web/app/legal/page.tsx'].sha256).toBe(sha256('x'));
    expect(lockfilePath(root)).toBe(join(root, '.auto_system', 'features.lock'));
  });
  it('corrupt lockfile reads as suspect', async () => {
    writeFileSync(lockfilePath(root), '{not json');
    const { lockfile, suspect } = await readLockfile(root);
    expect(suspect).toBe(true);
    expect(lockfile.slices).toEqual({});
  });
});
```

- [x] **Step 2: Run — expect FAIL**

Run: `cd core && npx vitest run test/feature-library/lockfile.test.ts`
Expected: FAIL — module missing.

- [x] **Step 3: Implement**

```ts
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export interface FileRecord { sha256: string; emitter?: string }
export interface SliceRecord {
  version: string;
  engineVersion: string;
  placeholders: Record<string, string>;
  files: Record<string, FileRecord>;
  pendingConflicts: string[];
}
export interface Lockfile { schema: 1; slices: Record<string, SliceRecord> }

export function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export function lockfilePath(projectRoot: string): string {
  return join(projectRoot, '.auto_system', 'features.lock');
}

export async function readLockfile(projectRoot: string): Promise<{ lockfile: Lockfile; suspect: boolean }> {
  try {
    const raw = await readFile(lockfilePath(projectRoot), 'utf8');
    const parsed = JSON.parse(raw) as Lockfile;
    if (parsed?.schema !== 1 || typeof parsed.slices !== 'object' || parsed.slices === null) {
      return { lockfile: { schema: 1, slices: {} }, suspect: true };
    }
    return { lockfile: parsed, suspect: false };
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { lockfile: { schema: 1, slices: {} }, suspect: false };
    return { lockfile: { schema: 1, slices: {} }, suspect: true };
  }
}

export async function writeLockfile(projectRoot: string, lockfile: Lockfile): Promise<void> {
  await mkdir(join(projectRoot, '.auto_system'), { recursive: true });
  await writeFile(lockfilePath(projectRoot), JSON.stringify(lockfile, null, 2) + '\n', 'utf8');
}
```

- [x] **Step 4: Run — expect PASS**

Run: `cd core && npx vitest run test/feature-library/lockfile.test.ts`
Expected: 3 passed.

- [x] **Step 5: Commit**

```bash
git add core/src/feature-library/lockfile.ts core/test/feature-library/lockfile.test.ts
git commit -m "feat: feature-library lockfile with suspect-on-corrupt semantics"
```

---

### Task 5: Renderer + installer core

**Files:**
- Create: `core/src/feature-library/render.ts`
- Create: `core/src/feature-library/install.ts`
- Create fixture slice: `core/test/feature-library/fixtures/slices/demo-legal/{manifest.yaml,files/web/hello.txt,WIRING.md}`
- Test: `core/test/feature-library/install.test.ts`

**Interfaces:**
- Consumes: `SliceInfo`, `loadManifest`, `listSlices`, `resolveFeaturesRoot` (Task 2); `PlaceholderContext`, `buildPlaceholderContext`, `applyPlaceholders` (Task 3); `Lockfile`, `readLockfile`, `writeLockfile`, `sha256` (Task 4); existing `getActivePlatforms`, `loadRegistry`, `buildSkipFilter`, `validatePathWithinWorkspace`, `safeWriteFile`.
- Produces (used by Tasks 6, 8–13):
  - `render.ts`: `renderSliceFiles(sliceDir: string, manifest: SliceManifest, ctx: PlaceholderContext, platforms: Platform[]): Promise<RenderedFile[]>` where `interface RenderedFile { platform: Platform; relPath: string; content: string; emitter?: string }` — reads `files/<platform>/**` recursively, substitutes, returns in sorted path order
  - `install.ts`: `installSlice(opts: { projectRoot: string; featuresRoot: string; sliceId: string; config: SystemConfig; force?: boolean }): Promise<InstallResult>` where `interface InstallResult { created: string[]; skipped: string[]; installed: string[] /* slice ids in topo order */ }`. Semantics: topologically resolves `requires` (unknown dep or cycle → throw), renders per *active* platform, applies the same per-platform brownfield skip filters `generateTemplates` uses, validates each target path within workspace, writes via `safeWriteFile` with skip-if-exists (`force` overwrites), records every written file in the lockfile under its slice with placeholder snapshot.

- [x] **Step 1: Create the fixture slice**

`core/test/feature-library/fixtures/slices/demo-legal/manifest.yaml`:

```yaml
id: demo-legal
version: 0.1.0
description: Fixture slice for installer tests
platforms: [web]
requires: []
config-keys: [project.name]
emitters: []
```

`core/test/feature-library/fixtures/slices/demo-legal/files/web/app/legal/page.txt`:

```
Legal page for {{APP_NAME}} ({{APP_DOMAIN}})
```

`core/test/feature-library/fixtures/slices/demo-legal/WIRING.md`:

```markdown
# Wiring: demo-legal

No manual steps — fixture slice.
```

- [x] **Step 2: Write the failing tests**

`core/test/feature-library/install.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { renderSliceFiles } from '../../src/feature-library/render';
import { installSlice } from '../../src/feature-library/install';
import { loadManifest } from '../../src/feature-library/manifest';
import { buildPlaceholderContext } from '../../src/feature-library/substitute';
import { readLockfile, sha256 } from '../../src/feature-library/lockfile';
import type { SystemConfig } from '../../src/config/schema';

const FIXTURES = resolve(__dirname, 'fixtures/slices');
const project = join(tmpdir(), `fl-install-${process.pid}`);
const config = {
  project: { name: 'My App', version: '1.0.0' },
  platforms: [{ name: 'web', path: 'apps/web', active: true }],
} as unknown as SystemConfig;

beforeAll(() => {
  rmSync(project, { recursive: true, force: true });
  mkdirSync(project, { recursive: true });
});
afterAll(() => rmSync(project, { recursive: true, force: true }));

describe('renderSliceFiles', () => {
  it('substitutes placeholders into file content', async () => {
    const dir = join(FIXTURES, 'demo-legal');
    const manifest = await loadManifest(dir);
    const files = await renderSliceFiles(dir, manifest, buildPlaceholderContext(config), ['web']);
    expect(files).toHaveLength(1);
    expect(files[0].content).toBe('Legal page for My App (myapp.com)');
    expect(files[0].relPath).toBe('app/legal/page.txt');
  });
});

describe('installSlice', () => {
  it('creates files and records provenance in the lockfile', async () => {
    const result = await installSlice({
      projectRoot: project,
      featuresRoot: FIXTURES,
      sliceId: 'demo-legal',
      config,
    });
    expect(result.installed).toEqual(['demo-legal']);
    const written = join(project, 'apps/web/app/legal/page.txt');
    expect(readFileSync(written, 'utf8')).toBe('Legal page for My App (myapp.com)');
    const { lockfile } = await readLockfile(project);
    const record = lockfile.slices['demo-legal'];
    expect(record.version).toBe('0.1.0');
    expect(record.files['apps/web/app/legal/page.txt'].sha256)
      .toBe(sha256('Legal page for My App (myapp.com)'));
    expect(record.placeholders['APP_NAME' in record.placeholders ? 'APP_NAME' : '']).toBeDefined();
  });

  it('skips existing files on re-install unless force', async () => {
    const skipped = await installSlice({ projectRoot: project, featuresRoot: FIXTURES, sliceId: 'demo-legal', config });
    expect(skipped.created).toEqual([]);
    expect(skipped.skipped).toHaveLength(1);
    writeFileSyncForce(); // helper below
    const forced = await installSlice({ projectRoot: project, featuresRoot: FIXTURES, sliceId: 'demo-legal', config, force: true });
    expect(forced.created).toHaveLength(1);
  });

  function writeFileSyncForce() {
    mkdirSync(join(project, 'apps/web/app/legal'), { recursive: true });
    require('node:fs').writeFileSync(join(project, 'apps/web/app/legal/page.txt'), 'USER EDIT');
  }
});
```

Adjust the `placeholders` assertion to the snapshot's real key set after implementing (the snapshot stores the full resolved `ctx.placeholders`).

- [x] **Step 3: Run — expect FAIL**

Run: `cd core && npx vitest run test/feature-library/install.test.ts`
Expected: FAIL — modules missing.

- [x] **Step 4: Implement `render.ts`**

```ts
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { SliceManifest, Platform } from './manifest';
import type { PlaceholderContext } from './substitute';
import { applyPlaceholders } from './substitute';

export interface RenderedFile { platform: Platform; relPath: string; content: string; emitter?: string }

async function walkFiles(dir: string, base = dir, acc: string[] = []): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) await walkFiles(p, base, acc);
    else acc.push(relative(base, p));
  }
  return acc.sort();
}

/** Render a slice's static files for the given platforms (emitters run separately, Task 12). */
export async function renderSliceFiles(
  sliceDir: string,
  manifest: SliceManifest,
  ctx: PlaceholderContext,
  platforms: Platform[],
): Promise<RenderedFile[]> {
  const out: RenderedFile[] = [];
  for (const platform of manifest.platforms.filter((p) => platforms.includes(p))) {
    const platformDir = join(sliceDir, 'files', platform);
    for (const rel of await walkFiles(platformDir)) {
      const content = applyPlaceholders(await readFile(join(platformDir, rel), 'utf8'), ctx);
      out.push({ platform, relPath: rel, content });
    }
  }
  return out;
}
```

- [x] **Step 5: Implement `install.ts`**

```ts
import { join } from 'node:path';
import type { SystemConfig } from '../config/schema';
import { getActivePlatforms } from '../config/platforms';
import { loadRegistry } from '../upgrade/registry';
import { validatePathWithinWorkspace } from '../utils/security';
import { safeWriteFile } from '../utils/safe-write';
import { listSlices, type Platform, type SliceInfo } from './manifest';
import { buildPlaceholderContext } from './substitute';
import { renderSliceFiles } from './render';
import { readLockfile, writeLockfile, sha256 } from './lockfile';

export interface InstallResult { created: string[]; skipped: string[]; installed: string[] }

const PLATFORM_PATH_KEY: Record<Platform, string> = { web: 'web', ios: 'ios', android: 'android', backend: 'backend' };

/** Topo-resolve the requires chain for sliceId. Throws on unknown id or cycle. */
export async function resolveInstallOrder(featuresRoot: string, sliceId: string): Promise<SliceInfo[]> {
  const catalog = await listSlices(featuresRoot);
  const byId = new Map(catalog.map((s) => [s.manifest.id, s]));
  const order: SliceInfo[] = [];
  const visiting = new Set<string>();
  const done = new Set<string>();
  const visit = (id: string): void => {
    if (done.has(id)) return;
    if (visiting.has(id)) throw new Error(`requires cycle at "${id}"`);
    visiting.add(id);
    const slice = byId.get(id);
    if (!slice) throw new Error(`unknown slice "${id}"`);
    for (const dep of slice.manifest.requires) visit(dep);
    visiting.delete(id);
    done.add(id);
    order.push(slice);
  };
  visit(sliceId);
  return order;
}

export async function installSlice(opts: {
  projectRoot: string;
  featuresRoot: string;
  sliceId: string;
  config: SystemConfig;
  force?: boolean;
}): Promise<InstallResult> {
  const { projectRoot, featuresRoot, sliceId, config, force } = opts;
  const order = await resolveInstallOrder(featuresRoot, sliceId);
  const ctx = buildPlaceholderContext(config);
  const activePlatforms = getActivePlatforms(config);
  const activeNames = new Set(activePlatforms.map((p) => p.name as Platform));
  const registry = await loadRegistry();
  // Same brownfield filters generateTemplates applies today. buildSkipFilter is
  // exported from templates/generator.ts in this task (see step 6 note).
  const { buildSkipFilter } = await import('../templates/generator');

  const { lockfile } = await readLockfile(projectRoot);
  const created: string[] = [];
  const skipped: string[] = [];

  for (const slice of order) {
    const rendered = await renderSliceFiles(slice.dir, slice.manifest, ctx, [...activeNames]);
    const skipFilters: Record<string, (rel: string) => boolean> = {};
    for (const platform of slice.manifest.platforms) {
      skipFilters[platform] = buildSkipFilter(config, registry.templates[PLATFORM_PATH_KEY[platform]]);
    }
    const files: Record<string, { sha256: string }> = {};
    for (const file of rendered) {
      const platformCfg = activePlatforms.find((p) => p.name === file.platform);
      if (!platformCfg) continue;
      if (skipFilters[file.platform](file.relPath)) { skipped.push(`${file.relPath} (brownfield-skip)`); continue; }
      const target = join(projectRoot, platformCfg.path, file.relPath);
      validatePathWithinWorkspace(platformCfg.path, projectRoot, 'Feature slice');
      if (!force && await fileExists(target)) { skipped.push(target); continue; }
      await safeWriteFile(target, file.content);
      created.push(target);
      files[join(platformCfg.path, file.relPath)] = { sha256: sha256(file.content) };
    }
    lockfile.slices[slice.manifest.id] = {
      version: slice.manifest.version,
      engineVersion: engineVersion(),
      placeholders: ctx.placeholders,
      files,
      pendingConflicts: [],
    };
  }
  await writeLockfile(projectRoot, lockfile);
  return { created, skipped, installed: order.map((s) => s.manifest.id) };
}

async function fileExists(p: string): Promise<boolean> {
  try { await import('node:fs/promises').then((fs) => fs.access(p)); return true; } catch { return false; }
}

function engineVersion(): string {
  // core/package.json version — read at build time via require in dist; for src use static import.
  return process.env.AUTO_SYSTEM_ENGINE_VERSION ?? '5.17.1';
}
```

Step 6 note: if `buildSkipFilter` is not exported from `generator.ts`, add `export` to its declaration in this task (one-word change; golden test guards it).

- [x] **Step 6: Run — expect PASS, then full suite**

Run: `cd core && npx vitest run test/feature-library/ && npx vitest run`
Expected: all pass, golden 3/3.

- [x] **Step 7: Commit**

```bash
git add core/src/feature-library/ core/test/feature-library/
git commit -m "feat: slice renderer and installer with lockfile provenance"
```

---

### Task 6: CLI — feature:list / feature:add / feature:status

**Files:**
- Modify: `core/src/index.ts` (add three commander commands near `generate:templates`, ~line 532)
- Modify: `master.sh` (help text block, lines ~31–44)
- Test: `core/test/feature-library/cli.test.ts`

**Interfaces:**
- Consumes: `listSlices`, `resolveFeaturesRoot` (Task 2), `installSlice` (Task 5), `readLockfile` (Task 4).
- Produces (consumed by Task 16's kit skill):
  - `feature:list [--json]` → human table, or `{"schema":1,"slices":[{"id","version","description","platforms","requires"}]}`
  - `feature:add <id> [--force]` → install output (created/skipped lists)
  - `feature:status [--json]` → `{"schema":1,"installed":[{"id","installedVersion","availableVersion","upToDate","fileCount","pendingConflicts"}]}`

- [x] **Step 1: Write the failing tests**

`core/test/feature-library/cli.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const CLI = resolve(__dirname, '../../src/index.ts');

function run(args: string[]): string {
  return execFileSync('npx', ['ts-node', '-T', CLI, ...args], {
    cwd: resolve(__dirname, '../..'),
    encoding: 'utf8',
    env: { ...process.env, AUTO_SYSTEM_FEATURES_ROOT: resolve(__dirname, 'fixtures') },
  });
}

describe('feature:list', () => {
  it('emits valid schema-1 JSON', () => {
    const out = JSON.parse(run(['feature:list', '--json']));
    expect(out.schema).toBe(1);
    expect(out.slices.map((s: { id: string }) => s.id)).toContain('demo-legal');
  });
});
```

(`feature:add`/`feature:status` are covered by the install/upgrade unit tests + manual smoke in step 5 — spawning a real install from a test would write outside tmp without careful cwd; keep CLI tests read-only.)

- [x] **Step 2: Run — expect FAIL**

Run: `cd core && npx vitest run test/feature-library/cli.test.ts`
Expected: FAIL — unknown command `feature:list`.

- [x] **Step 3: Implement the commands in `core/src/index.ts`**

Insert after the `generate:templates` command block, following the file's existing `withCommand`/chalk style:

```ts
program
    .command('feature:list')
    .description('List available feature slices')
    .option('--json', 'machine-readable catalog (schema 1)')
    .action(async (opts: { json?: boolean }) => {
        await withCommand('feature:list', async () => {
            const { listSlices, resolveFeaturesRoot } = await import('./feature-library/manifest');
            const slices = await listSlices(resolveFeaturesRoot());
            if (opts.json) {
                console.log(JSON.stringify({
                    schema: 1,
                    slices: slices.map((s) => s.manifest).map((m) => ({
                        id: m.id, version: m.version, description: m.description,
                        platforms: m.platforms, requires: m.requires,
                    })),
                }, null, 2));
                return;
            }
            for (const { manifest: m } of slices) {
                console.log(chalk.green(`${m.id}@${m.version}`) + chalk.gray(` [${m.platforms.join(',')}]`) + ` — ${m.description}`);
            }
        });
    });

program
    .command('feature:add <id>')
    .description('Install a feature slice (and its requires) into this project')
    .option('--force', 'overwrite existing files')
    .action(async (id: string, opts: { force?: boolean }) => {
        await withCommand(`feature:add ${id}`, async () => {
            const { resolveFeaturesRoot } = await import('./feature-library/manifest');
            const { installSlice } = await import('./feature-library/install');
            const { created, skipped, installed } = await installSlice({
                projectRoot: process.cwd(),
                featuresRoot: resolveFeaturesRoot(),
                sliceId: id,
                config: await loadConfig(),
                force: opts.force,
            });
            console.log(chalk.green(`✓ Installed: ${installed.join(' → ')}`));
            if (created.length) console.log(chalk.green(`✓ Created: ${created.length} files`));
            if (skipped.length) console.log(chalk.gray(`  Skipped (exist): ${skipped.length} files`));
        });
    });

program
    .command('feature:status')
    .description('Show installed slices vs available versions')
    .option('--json', 'machine-readable status (schema 1)')
    .action(async (opts: { json?: boolean }) => {
        await withCommand('feature:status', async () => {
            const { listSlices, resolveFeaturesRoot } = await import('./feature-library/manifest');
            const { readLockfile } = await import('./feature-library/lockfile');
            const catalog = await listSlices(resolveFeaturesRoot());
            const { lockfile } = await readLockfile(process.cwd());
            const rows = Object.entries(lockfile.slices).map(([id, rec]) => ({
                id,
                installedVersion: rec.version,
                availableVersion: catalog.find((s) => s.manifest.id === id)?.manifest.version ?? '(gone)',
                upToDate: catalog.find((s) => s.manifest.id === id)?.manifest.version === rec.version,
                fileCount: Object.keys(rec.files).length,
                pendingConflicts: rec.pendingConflicts,
            }));
            if (opts.json) { console.log(JSON.stringify({ schema: 1, installed: rows }, null, 2)); return; }
            for (const r of rows) {
                const mark = r.upToDate ? chalk.green('✓') : chalk.yellow('↑');
                console.log(`${mark} ${r.id} ${r.installedVersion} → ${r.availableVersion} (${r.fileCount} files${r.pendingConflicts.length ? `, ${r.pendingConflicts.length} conflicts` : ''})`);
            }
        });
    });
```

- [x] **Step 4: Add help lines to `master.sh`** (in the commands echo block after `generate:feature`):

```bash
    echo "  feature:list       List available feature slices (--json for catalog)"
    echo "  feature:add <id>   Install a feature slice + its requires (--force)"
    echo "  feature:status     Installed slices vs available versions (--json)"
    echo "  feature:upgrade    Upgrade installed slices (reports conflicts, never overwrites)"
```

(The `feature:upgrade` line lands with Task 13; adding the help line now is harmless only if you also add it there — otherwise defer that one line to Task 13.)

- [x] **Step 5: Manual smoke + full suite**

Run:
```bash
cd core && npx vitest run
cd /tmp && rm -rf smoke && mkdir smoke && cd smoke && mkdir -p .auto_system
cp /path/to/auto-system/core/test/templates/golden/minimal/.auto_system/system.yaml .auto_system/
cd /path/to/auto-system && bash master.sh feature:list
bash master.sh feature:add demo-legal 2>&1 | head -5
```
Expected: list shows catalog from `AUTO_SYSTEM_FEATURES_ROOT` or repo `features/` (empty for now — "no slices" output is fine); add of a missing slice errors cleanly with unknown-slice message.

- [x] **Step 6: Commit**

```bash
git add core/src/index.ts core/master.sh core/test/feature-library/cli.test.ts 2>/dev/null || git add core/src/index.ts master.sh core/test/feature-library/cli.test.ts
git commit -m "feat: feature:list/add/status CLI commands"
```

---

### Task 7: Dump tool + deterministic slice membership

**Files:**
- Create: `core/scripts/dump-templates.ts`
- Create: `features/` (output root, populated by the script)
- Modify: `core/src/templates/generator.ts` (temporarily `export` the four record consts)
- Create: `docs/feature-slices.md` (inventory doc)

**Interfaces:**
- Produces: `features/<slice>/files/<platform>/...` raw template files (placeholders intact, `{{APP_NAME}}`/`{{APP_DOMAIN}}`/`{{KEY}}` untouched) — input for Tasks 8–12.
- Membership rules (deterministic, encoded in the script — no per-file judgment):

| Rule (matched against record key, per platform tree) | Slice |
|---|---|
| `settings` | settings |
| `support`, `help` | support |
| key starts `legal/` or contains `cookies` / `privacy` / `terms` | legal |
| starts `account/` (or iOS/Android Account views) | account |
| login, signup, mfa, forgot-password, reset-password, `lib/auth`, `services/auth-api`, `routes/auth`, `routes/oauth`, password-hash, email/mailer | auth-core |
| backend: `middleware/`, `health`, `server.ts`, `env`, `errorHandler`, `rateLimit`, `security`, `payloadGuard`, `performance`, `auditLog`, `jsonBody`, `package.json`, `tsconfig`, `.env.example`, eslint | backend-middleware |
| backend: `db/`, `repositories/`, `schemas/user`, drizzle/migration | db-core |
| backend: `jobs/`, scheduler, queue | jobs |
| backend: `webhooks/`, idempotency | webhooks |
| **everything else (residue)** | app-shell |

Final slice set (10): `app-shell`, `backend-middleware`, `db-core`, `jobs`, `webhooks`, `legal`, `support`, `settings`, `account`, `auth-core`.

- [x] **Step 1: Export the records** — in `core/src/templates/generator.ts` change `const WEB_TEMPLATES` / `IOS_TEMPLATES` / `ANDROID_TEMPLATES` / `BACKEND_TEMPLATES` to `export const …` (four one-word edits).

- [x] **Step 2: Write the dump script**

`core/scripts/dump-templates.ts`:

```ts
// One-shot extraction aid: dumps the monolith's template records into
// features/<slice>/files/<platform>/ trees. Deterministic membership rules —
// see docs/feature-slices.md. Deleted in Task 13.
// Usage: cd core && npx ts-node scripts/dump-templates.ts [--list]
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import {
    WEB_TEMPLATES, IOS_TEMPLATES, ANDROID_TEMPLATES, BACKEND_TEMPLATES,
} from '../src/templates/generator';

const FEATURES_ROOT = resolve(__dirname, '../../features');
const PLATFORMS: Array<[string, Record<string, string>]> = [
    ['web', WEB_TEMPLATES], ['ios', IOS_TEMPLATES], ['android', ANDROID_TEMPLATES], ['backend', BACKEND_TEMPLATES],
];

function sliceFor(key: string, platform: string): string {
    const k = key.toLowerCase();
    if (platform !== 'backend') {
        if (k.includes('setting')) return 'settings';
        if (k.includes('support') || k.includes('help')) return 'support';
        if (k.startsWith('legal/') || k.includes('legal') || k.includes('cookies') || k.includes('privacy') || k.includes('terms')) return 'legal';
        if (k.includes('account')) return 'account';
        if (/login|signup|mfa|forgot|reset/.test(k) || k.includes('auth')) return 'auth-core';
        return 'app-shell';
    }
    if (k.startsWith('db/') || k.includes('repositor') || k.includes('schema') || k.includes('drizzle') || k.includes('migration')) return 'db-core';
    if (k.includes('jobs/') || k.includes('job') || k.includes('schedul') || k.includes('queue')) return 'jobs';
    if (k.includes('webhook') || k.includes('idempoten')) return 'webhooks';
    if (k.startsWith('routes/auth') || k.startsWith('routes/oauth') || k.includes('password') || k.includes('mailer') || k.includes('email')) return 'auth-core';
    if (k.includes('middleware') || k.includes('health') || k.includes('server') || k.includes('env') || k.includes('errorhandler')
        || k.includes('ratelimit') || k.includes('security') || k.includes('payloadguard') || k.includes('performance')
        || k.includes('auditlog') || k.includes('jsonbody') || k === 'package.json' || k.includes('tsconfig') || k.includes('eslint') || k.includes('.env')) return 'backend-middleware';
    return 'app-shell';
}

const assignment: Record<string, Record<string, string[]>> = {};
for (const [platform, record] of PLATFORMS) {
    for (const [rel, content] of Object.entries(record)) {
        const slice = sliceFor(rel, platform);
        (assignment[slice] ??= {})[platform] ??= [];
        assignment[slice][platform].push(rel);
        if (!process.argv.includes('--list')) {
            const out = join(FEATURES_ROOT, slice, 'files', platform, rel);
            mkdirSync(dirname(out), { recursive: true });
            writeFileSync(out, content.endsWith('\n') ? content : content + '\n', 'utf8');
        }
    }
}
if (process.argv.includes('--list')) {
    for (const [slice, byPlatform] of Object.entries(assignment).sort()) {
        for (const [platform, keys] of Object.entries(byPlatform).sort()) {
            console.log(`${slice}/${platform}: ${keys.length} files`);
            for (const k of keys.sort()) console.log(`  ${k}`);
        }
    }
    process.exit(0);
}
console.log('dumped to', FEATURES_ROOT);
```

**Critical parity rule:** the monolith record VALUE is the exact emitted content. The dump appends a trailing newline only if missing — verify with the golden test after each extraction task; if a record's value does NOT end with `\n` and the slice reader adds one, parity breaks. Rule for the reader (Task 8): files are written verbatim, no newline normalization anywhere. (Drop the `.endsWith` normalization here too if unsure — dump byte-exact, `writeFileSync(out, content)`.)

- [x] **Step 3: Run `--list` first, save the inventory**

Run: `cd core && npx ts-node scripts/dump-templates.ts --list > ../docs/feature-slices-inventory.txt && head -50 ../docs/feature-slices-inventory.txt`
Review the assignment: every record key appears exactly once; spot-check that `legal`, `settings` landed as expected. If a rule misfires (e.g. `help` email templates landing in auth-core via the `email` rule), tighten the rule and re-run — **before** any extraction task depends on it.

- [x] **Step 4: Dump the trees**

Run: `cd core && npx ts-node scripts/dump-templates.ts && find ../features -type f | wc -l`
Expected: total ≈ sum of record sizes across the four maps (count with `node -e` if desired). Trees now exist.

- [x] **Step 5: Write `docs/feature-slices.md`** — the slice table from the spec (app-shell added as residue slice), membership rules above, and `feature-slices-inventory.txt` referenced. Commit inventory file too.

- [x] **Step 6: Full suite + commit**

Run: `cd core && npx vitest run` — green (nothing consumes the trees yet).

```bash
git add features/ core/scripts/dump-templates.ts core/src/templates/generator.ts docs/feature-slices.md docs/feature-slices-inventory.txt
git commit -m "feat: dump monolith templates into features/ trees with deterministic slice membership"
```

---

### Tasks 8–12: Slice-by-slice extraction + cutover

Each task follows the **same recipe** (repeated in full per task; do not skip steps). The recipe wires `generateTemplates` to source that slice's files from `features/` via `renderSliceFiles` — identical content, identical write behavior — then deletes the monolith entries. Golden parity after every step.

**Recipe R (for slice S):**
1. Create `features/S/manifest.yaml` (content given per task) and `features/S/WIRING.md` (content given per task).
2. In `generateTemplates`, replace the per-record write loop entries for S's keys with: `const rendered = await renderSliceFiles(sliceDir, manifest, placeholderCtx, activePlatformNames);` then write each through the *existing* platform basePath + skip-filter + `safeWriteFile` code path (the loops at generator.ts ~5594–5880 stay; only the content source changes). Keep write ORDER stable within a platform (sort rendered by relPath to match the original Record iteration order — verify with golden).
3. Delete S's entries from the `*_TEMPLATES` record literals (the dump trees are now the source of truth).
4. `cd core && npx vitest run` — ALL green, golden 3/3 byte-identical. Fix until true.
5. Commit.

### Task 8: Extract settings + support + legal

**Files:**
- Create: `features/settings/manifest.yaml`, `features/settings/WIRING.md`
- Create: `features/support/manifest.yaml`, `features/support/WIRING.md`
- Create: `features/legal/manifest.yaml`, `features/legal/WIRING.md`
- Modify: `core/src/templates/generator.ts`

**Interfaces:**
- Consumes: `renderSliceFiles` (Task 5), `loadManifest` (Task 2), dump trees (Task 7).
- Produces: three installable slices; `features/` trees for them now authoritative.

- [x] **Step 1: Manifests**

`features/settings/manifest.yaml`:

```yaml
id: settings
version: 0.1.0
description: App settings page/screen
platforms: [web, ios, android]
requires: []
config-keys: [project.name, advisor]
emitters: []
```

`features/support/manifest.yaml`:

```yaml
id: support
version: 0.1.0
description: Support and help pages/screens
platforms: [web, ios, android]
requires: []
config-keys: [project.name, advisor]
emitters: []
```

`features/legal/manifest.yaml`:

```yaml
id: legal
version: 0.1.0
description: Privacy policy, terms, cookies pages + legal hub
platforms: [web, ios, android]
requires: []
config-keys: [project.name, advisor]
emitters: []
```

- [x] **Step 2: WIRING.md files** (one per slice, same shape):

`features/settings/WIRING.md`:

```markdown
# Wiring: settings

Standalone page — no registration required.
Optional: add a link/tab to the settings route from your navigation.
```

`features/support/WIRING.md`:

```markdown
# Wiring: support

Standalone pages — no registration required.
Optional: point users at /support from footers or help menus.
```

`features/legal/WIRING.md`:

```markdown
# Wiring: legal

Standalone pages — no registration required.
Fill in real policy text: the generated pages contain placeholder copy,
not legal advice. Link /legal from signup and settings.
```

- [x] **Step 3: Apply recipe R steps 2–3** for all three slices (settings, support, legal) — cutover their platform entries per the recipe.

- [x] **Step 4: Full suite — golden 3/3**

Run: `cd core && npx vitest run`
Expected: all green. On mismatch, diff the failing file vs `core/test/templates/golden/<case>/snapshot/` to find the content/order divergence.

- [x] **Step 5: Commit**

```bash
git add features/ core/src/templates/generator.ts
git commit -m "refactor: source settings/support/legal templates from feature slices"
```

### Task 9: Extract backend-middleware + db-core

**Files:**
- Create: `features/backend-middleware/manifest.yaml` + `WIRING.md`
- Create: `features/db-core/manifest.yaml` + `WIRING.md`
- Modify: `core/src/templates/generator.ts`

**Interfaces:** same as Task 8.

- [x] **Step 1: Manifests**

`features/backend-middleware/manifest.yaml`:

```yaml
id: backend-middleware
version: 0.1.0
description: Fastify server bootstrap, security/rate-limit/payload/audit middleware, health routes
platforms: [backend]
requires: []
config-keys: [backend.port, backend.cors, backend.rateLimits, backend.logging, backend.apiPrefix, project.name]
emitters: []
```

`features/db-core/manifest.yaml`:

```yaml
id: db-core
version: 0.1.0
description: Database client, users/sessions/reset-token repositories, schema
platforms: [backend]
requires: [backend-middleware]
config-keys: [database.urlEnvVar, auth.session]
emitters: []
```

- [x] **Step 2: WIRING.md files**

`features/backend-middleware/WIRING.md`:

```markdown
# Wiring: backend-middleware

1. Copy `.env.example` values into a real `.env` (never commit it).
2. `npm install` inside the backend platform path on first install.
3. Health check: GET /health after `npm run dev`.
```

`features/db-core/WIRING.md`:

```markdown
# Wiring: db-core

1. Set DATABASE_URL (env var name configurable via database.urlEnvVar).
2. Run migrations if the generated schema emits any (see slice output).
3. Repositories are import-only; routes register them in later slices.
```

- [x] **Step 3: Apply recipe R steps 2–3** for both slices.
- [x] **Step 4: Full suite — golden 3/3.** Run: `cd core && npx vitest run`
- [x] **Step 5: Commit**

```bash
git add features/ core/src/templates/generator.ts
git commit -m "refactor: source backend-middleware/db-core templates from feature slices"
```

### Task 10: Extract jobs + webhooks

**Files:**
- Create: `features/jobs/manifest.yaml` + `WIRING.md`
- Create: `features/webhooks/manifest.yaml` + `WIRING.md`
- Modify: `core/src/templates/generator.ts`

- [x] **Step 1: Manifests**

`features/jobs/manifest.yaml`:

```yaml
id: jobs
version: 0.1.0
description: In-process background job runner with cron schedules and async queue
platforms: [backend]
requires: [db-core]
config-keys: [jobs.scheduled, jobs.async]
emitters: []
```

`features/webhooks/manifest.yaml`:

```yaml
id: webhooks
version: 0.1.0
description: Inbound webhook handling with idempotency cache
platforms: [backend]
requires: [backend-middleware]
config-keys: [webhooks.idempotencyCacheSize]
emitters: []
```

- [x] **Step 2: WIRING.md files**

`features/jobs/WIRING.md`:

```markdown
# Wiring: jobs

1. Built-in cleanup jobs (expired sessions, reset tokens) run automatically.
2. Custom jobs: declare under jobs.scheduled / jobs.async in system.yaml and
   re-run feature:add jobs --force (or generate:templates).
3. Handlers live in the jobs directory; register new ones in the runner index.
```

`features/webhooks/WIRING.md`:

```markdown
# Wiring: webhooks

1. Declare provider secrets as env vars — never in system.yaml.
2. Add handler stubs per provider in the webhooks directory.
3. Idempotency cache is in-process; restart replays are safe for 2048 events.
```

- [x] **Step 3: Apply recipe R steps 2–3.**
- [x] **Step 4: Full suite — golden 3/3.** Run: `cd core && npx vitest run`
- [x] **Step 5: Commit**

```bash
git add features/ core/src/templates/generator.ts
git commit -m "refactor: source jobs/webhooks templates from feature slices"
```

### Task 11: Extract account + app-shell

**Files:**
- Create: `features/account/manifest.yaml` + `WIRING.md`
- Create: `features/app-shell/manifest.yaml` + `WIRING.md`
- Modify: `core/src/templates/generator.ts`

- [x] **Step 1: Manifests**

`features/account/manifest.yaml`:

```yaml
id: account
version: 0.1.0
description: Account hub — security, data export, deletion, payment stubs
platforms: [web, ios, android]
requires: [auth-core]
config-keys: [project.name, advisor]
emitters: []
```

`features/app-shell/manifest.yaml`:

```yaml
id: app-shell
version: 0.1.0
description: Platform bootstrap residue — layout, shared components, theme wiring, config files
platforms: [web, ios, android, backend]
requires: []
config-keys: [project.name, advisor.quality, theme]
emitters: []
```

- [x] **Step 2: WIRING.md files**

`features/account/WIRING.md`:

```markdown
# Wiring: account

1. Requires auth-core routes to be mounted (account pages call them).
2. Payment page is a stub — integrate a real provider before use.
3. Account deletion should trigger your data-retention policy.
```

`features/app-shell/WIRING.md`:

```markdown
# Wiring: app-shell

1. This slice is the platform skeleton — install it FIRST for greenfield apps
   (generate:templates does this automatically).
2. Review generated package.json deps and env examples per platform.
3. Theme tokens flow from theme sync; do not hand-edit generated token files.
```

- [x] **Step 3: Apply recipe R steps 2–3.** Note account's `requires: [auth-core]` does NOT block extraction order — requires are an install-time graph, not a code dependency of the cutover.
- [x] **Step 4: Full suite — golden 3/3.** Run: `cd core && npx vitest run`
- [x] **Step 5: Commit**

```bash
git add features/ core/src/templates/generator.ts
git commit -m "refactor: source account/app-shell templates from feature slices"
```

### Task 12: Extract auth-core + emit/ modules

**Files:**
- Create: `features/auth-core/manifest.yaml` + `WIRING.md`
- Create: `features/auth-core/emit/password-hash.ts`, `features/auth-core/emit/oauth-router.ts`
- Modify: `core/src/templates/generator.ts`
- Modify: `core/src/feature-library/install.ts` (run emitters)
- Test: `core/test/feature-library/emitters.test.ts`

**Interfaces:**
- Produces: `interface EmitterModule { render(config: SystemConfig, ctx: PlaceholderContext): Array<{ platform: Platform; relPath: string; content: string }> }` — `install.ts` dynamically imports each `emit/<name>.ts` listed in the manifest (relative to slice dir) and appends its output to the rendered set, tagging lockfile records with `emitter: name`.

- [x] **Step 1: Manifest + WIRING**

`features/auth-core/manifest.yaml`:

```yaml
id: auth-core
version: 0.1.0
description: Full auth stack — login/signup/MFA/forgot/reset, sessions, lockout, OAuth, email
platforms: [web, ios, android, backend]
requires: [backend-middleware, db-core]
config-keys: [auth, backend.passwordHash, advisor.securityLevel]
emitters: [password-hash, oauth-router]
upgrade-notes: Password-hash parameter changes re-emit the backend hash module; sessions table gains no columns in 0.x.
```

`features/auth-core/WIRING.md`:

```markdown
# Wiring: auth-core

1. Mount authRouter at AUTH_API_PREFIX (default /v1/auth) in routes/index.ts.
2. Mount oauthRouter at /auth/oauth ONLY if OAuth providers are declared.
3. Set SESSION_SECRET and email transport env vars before first run.
4. Web: auth-api.ts + lib/auth.ts are generated — never hand-edit (see kit skill configure-auth).
5. iOS/Android: wire LoginView/SignUpView into your navigation entry point.
```

- [x] **Step 2: Write failing emitter tests**

`core/test/feature-library/emitters.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { SystemConfig } from '../../src/config/schema';
import { buildPlaceholderContext } from '../../src/feature-library/substitute';

const config = {
  project: { name: 'MyApp', version: '1.0.0' },
  platforms: [{ name: 'backend', path: 'services/core-api', active: true }],
  backend: { passwordHash: { algorithm: 'argon2id' } },
} as unknown as SystemConfig;

describe('password-hash emitter', () => {
  it('renders argon2 variant when configured', async () => {
    const emitter = await import('../../features/auth-core/emit/password-hash');
    const out = emitter.render(config, buildPlaceholderContext(config));
    expect(out.length).toBeGreaterThan(0);
    expect(out[0].content).toContain('@node-rs/argon2');
  });
  it('renders scrypt variant by default', async () => {
    const cfg = { ...config, backend: undefined } as unknown as SystemConfig;
    const emitter = await import('../../features/auth-core/emit/password-hash');
    const out = emitter.render(cfg, buildPlaceholderContext(cfg));
    expect(out[0].content).toContain('scryptSync');
  });
});
```

(If importing TS from `features/` doesn't resolve under vitest, add a path alias or move emitters to `core/src/feature-library/emitters/` with the manifest pointing at `core:` prefixed names — pick one, keep it consistent.)

- [x] **Step 3: Run — expect FAIL.** Run: `cd core && npx vitest run test/feature-library/emitters.test.ts`

- [x] **Step 4: Move the emitter code.** In `generator.ts`, the hash-algorithm variants (`scryptConsts`, `scryptFuncs`, `argon2Funcs` — Task 3 kept them near the placeholder map) and the OAuth router emission (`generatableOAuthProviders` + `oauthContent` construction, ~5875) move into the two emit modules, each exporting `render(config, ctx)` returning the same file contents the inline code produced. The `OAUTH_IMPORT`/`OAUTH_MOUNT`/`AUTH_HASH_*` placeholders remain exactly as computed today (they live in the ctx map; emitters consume ctx, not raw config, for those).

`features/auth-core/emit/password-hash.ts` skeleton (body = moved code):

```ts
import type { SystemConfig } from '../../../core/src/config/schema';
import type { PlaceholderContext } from '../../../core/src/feature-library/substitute';

export function render(config: SystemConfig, ctx: PlaceholderContext): Array<{ platform: 'backend'; relPath: string; content: string }> {
  // buildPlaceholderContext already resolved the algorithm variant into
  // AUTH_HASH_FUNCS (scrypt funcs vs argon2 funcs) from config.backend.passwordHash.
  const isArgon2 = (config.backend?.passwordHash?.algorithm ?? 'scrypt') === 'argon2id';
  return [{
    platform: 'backend',
    relPath: 'src/shared/passwordHash.ts',
    content: (isArgon2 ? '// argon2id (PHC string; salt unused for schema parity)\n' : '// scrypt (salt column used)\n') + ctx.placeholders['AUTH_HASH_FUNCS']!,
  }];
}
```

(If today's generator emits the hash functions INLINE inside `routes/auth.ts` rather than a separate file, the emitter instead returns the two AUTH_HASH placeholder values for the template to splice — match whatever the monolith does; golden decides. The invariant: emitter output + template placeholders == today's bytes.)

- [x] **Step 5: Wire emitters into `install.ts`** — after `renderSliceFiles`, for each `manifest.emitters` name: `const mod = await import(join(sliceDir, 'emit', name + '.ts'))` (use the resolution strategy fixed in Step 2's note); validate `typeof mod.render === 'function'`; append `mod.render(config, ctx)` items (tag `emitter: name` in lockfile FileRecord).

- [x] **Step 6: Apply recipe R steps 2–3 for auth-core's static files** (the largest set: auth pages/views/screens, auth-api, lib/auth, routes/auth).

- [x] **Step 7: Full suite — golden 3/3** (the high-security fixture covers argon2 + OAuth). Run: `cd core && npx vitest run`

- [x] **Step 8: Commit**

```bash
git add features/auth-core core/src/templates/generator.ts core/src/feature-library/install.ts core/test/feature-library/emitters.test.ts
git commit -m "refactor: extract auth-core with password-hash and oauth emitters"
```

---

### Task 13: Final cutover — orchestrator + monolith deletion

**Files:**
- Modify: `core/src/templates/generator.ts` (delete empty `*_TEMPLATES` records and their imports; `generateTemplates` becomes orchestrator)
- Modify: `core/src/index.ts` (`generate:templates` description)
- Delete: `core/scripts/dump-templates.ts`
- Modify: `core/vitest.config.ts` (coverage excludes — remove `src/templates/generator.ts` line, add `src/feature-library/render.ts` only if thresholds can't be met otherwise)

**Interfaces:**
- Produces: `generateTemplates(config)` keeps its exact signature and `{created, skipped}` return. Internally: for each slice in install order (app-shell → backend-middleware → db-core → auth-core-dependent chain → …) call the same shared render+write path `installSlice` uses, with the legacy skip-if-exists semantics, and update the lockfile.

- [x] **Step 1: Rewrite `generateTemplates` as orchestrator**

```ts
export async function generateTemplates(config: SystemConfig): Promise<{ created: string[]; skipped: string[] }> {
    const { resolveFeaturesRoot, listSlices } = await import('../feature-library/manifest');
    const { installSlice } = await import('../feature-library/install');
    const featuresRoot = resolveFeaturesRoot();
    const all = await listSlices(featuresRoot);
    const created: string[] = [];
    const skipped: string[] = [];
    // app-shell first (greenfield skeleton), then everything in requires order.
    const ordered = ['app-shell', ...all.map((s) => s.manifest.id).filter((id) => id !== 'app-shell')];
    for (const id of ordered) {
        if (!all.some((s) => s.manifest.id === id)) continue;
        const result = await installSlice({
            projectRoot: process.cwd(), featuresRoot, sliceId: id, config,
        });
        created.push(...result.created);
        skipped.push(...result.skipped);
    }
    return { created, skipped };
}
```

Deviation risk vs legacy: legacy had bespoke write order, OAuth docs baseline, and `.cursorrules`-adjacent extras (`docsDir` baseline writes at ~5837). If golden fails, port those exact bespoke writes into the relevant slice's static files or a tiny dedicated emitter (`features/backend-middleware/emit/docs-baseline.ts`) until parity holds — golden is the contract, not this snippet.

- [x] **Step 2: Delete the monolith body** — remove the four record consts, `buildSkipFilter` inline copy (now imported from its new home in feature-library or keep in generator.ts but exported — wherever Task 5 put it), and all now-unused helpers. `generator.ts` should be <200 lines.

- [x] **Step 3: Delete `core/scripts/dump-templates.ts`** and the temporary record exports.

- [x] **Step 4: Full suite + golden 3/3 + self-check**

Run: `cd core && npx vitest run && npx ts-node scripts/capture-golden.ts --check 2>/dev/null; npx vitest run test/templates/golden-parity.test.ts`
(The capture script stays — it is the tool to create NEW goldens when a template intentionally changes; its snapshots stay frozen.)
Also run from repo root: `bash master.sh status && bash master.sh feature:list`
Expected: all green; feature:list shows 10 slices.

- [x] **Step 5: Regenerate the self-hosted app if a repo config exists**

Run: `ls .auto_system/system.yaml 2>/dev/null && bash master.sh generate:templates && git status --short apps services | head`
Expected: no diffs (skip-if-exists) OR diffs only in newly-added files. If the repo has no `.auto_system/system.yaml`, note that in the commit message and skip.

- [x] **Step 6: Commit**

```bash
git add -A core features
git commit -m "refactor: generate:templates orchestrates feature slices; monolith body deleted"
```

---

### Task 14: feature:upgrade

**Files:**
- Create: `core/src/feature-library/upgrade.ts`
- Modify: `core/src/index.ts` (`feature:upgrade [id]` command)
- Modify: `master.sh` (help line if deferred in Task 6)
- Test: `core/test/feature-library/upgrade.test.ts`

**Interfaces:**
- Consumes: `install` internals, `renderSliceFiles`, lockfile, `loadManifest`, `listSlices`, `buildPlaceholderContext`.
- Produces:
  - `interface UpgradeConflict { path: string; recordedHash: string; currentHash: string; newTemplateHash: string }`
  - `interface UpgradeReport { sliceId: string; from: string; to: string; updated: string[]; added: string[]; removed: string[]; conflicts: UpgradeConflict[] }`
  - `upgradeSlice(opts: { projectRoot: string; featuresRoot: string; sliceId: string; config: SystemConfig }): Promise<UpgradeReport>` — semantics: render new version with CURRENT config; per file: missing on disk → write + `added`; `sha256(disk) === record.sha256` → write + `updated` + refresh record; differs → `conflicts` (never write); in old record but not new render → `removed` (report only, never delete). Lockfile: bump version, refresh hashes for written files, set `pendingConflicts` to conflicted paths (cleared when a later upgrade finds them resolved). `suspect` lockfile → every file becomes a conflict.

- [x] **Step 1: Write the failing tests**

`core/test/feature-library/upgrade.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { installSlice } from '../../src/feature-library/install';
import { upgradeSlice } from '../../src/feature-library/upgrade';
import type { SystemConfig } from '../../src/config/schema';

const FIXTURES_V1 = resolve(__dirname, 'fixtures/upgrade/v1');
const FIXTURES_V2 = resolve(__dirname, 'fixtures/upgrade/v2');
const project = join(tmpdir(), `fl-upgrade-${process.pid}`);
const config = {
  project: { name: 'MyApp', version: '1.0.0' },
  platforms: [{ name: 'web', path: 'apps/web', active: true }],
} as unknown as SystemConfig;

function writeSlice(root: string, version: string, body: string) {
  mkdirSync(join(root, 'demo-up/files/web/app/x.txt'), { recursive: true });
  writeFileSync(join(root, 'demo-up/manifest.yaml'),
    `id: demo-up\nversion: ${version}\ndescription: d\nplatforms: [web]\nrequires: []\nconfig-keys: []\nemitters: []\n`);
  writeFileSync(join(root, 'demo-up/files/web/app/x.txt'), body);
}

beforeAll(() => {
  rmSync(project, { recursive: true, force: true });
  mkdirSync(project, { recursive: true });
  writeSlice(FIXTURES_V1, '0.1.0', 'template v1 {{APP_NAME}}\n');
  writeSlice(FIXTURES_V2, '0.2.0', 'template v2 {{APP_NAME}}\n');
});
afterAll(() => { rmSync(project, { recursive: true, force: true }); rmSync(FIXTURES_V1, { recursive: true, force: true }); rmSync(FIXTURES_V2, { recursive: true, force: true }); });

describe('upgradeSlice', () => {
  it('mechanically updates untouched files and reports modified ones as conflicts', async () => {
    await installSlice({ projectRoot: project, featuresRoot: FIXTURES_V1, sliceId: 'demo-up', config });
    // user edits a DIFFERENT copy: add a second file scenario is overkill; edit x.txt
    const target = join(project, 'apps/web/app/x.txt');
    writeFileSync(target, 'USER CUSTOMIZED\n');
    const report = await upgradeSlice({ projectRoot: project, featuresRoot: FIXTURES_V2, sliceId: 'demo-up', config });
    expect(report.from).toBe('0.1.0');
    expect(report.to).toBe('0.2.0');
    expect(report.conflicts).toHaveLength(1);
    expect(report.conflicts[0].path.endsWith('app/x.txt')).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('USER CUSTOMIZED\n'); // never overwritten
  });
  it('updates untouched files mechanically', async () => {
    rmSync(join(project, 'apps/web/app/x.txt'));
    rmSync(join(project, '.auto_system/features.lock'));
    await installSlice({ projectRoot: project, featuresRoot: FIXTURES_V1, sliceId: 'demo-up', config });
    const report = await upgradeSlice({ projectRoot: project, featuresRoot: FIXTURES_V2, sliceId: 'demo-up', config });
    expect(report.updated).toHaveLength(1);
    expect(readFileSync(join(project, 'apps/web/app/x.txt'), 'utf8')).toBe('template v2 MyApp\n');
  });
});
```

- [x] **Step 2: Run — expect FAIL.** Run: `cd core && npx vitest run test/feature-library/upgrade.test.ts`

- [x] **Step 3: Implement `upgrade.ts`** per the Produces contract above. Structure: read lockfile (suspect → all-conflict mode), load manifest, render, classify each rendered file, write `updated`/`added`, collect conflicts, mutate lockfile record, write lockfile, return report.

- [x] **Step 4: CLI command** in `core/src/index.ts` (style of Task 6):

```ts
program
    .command('feature:upgrade [id]')
    .description('Upgrade installed slices; reports conflicts, never overwrites modified files')
    .action(async (id: string | undefined) => {
        await withCommand('feature:upgrade', async () => {
            const { readLockfile } = await import('./feature-library/lockfile');
            const { resolveFeaturesRoot } = await import('./feature-library/manifest');
            const { upgradeSlice } = await import('./feature-library/upgrade');
            const { lockfile } = await readLockfile(process.cwd());
            const config = await loadConfig();
            const targets = id ? [id] : Object.keys(lockfile.slices);
            if (!targets.length) { console.log(chalk.gray('No installed slices.')); return; }
            for (const sliceId of targets) {
                const report = await upgradeSlice({ projectRoot: process.cwd(), featuresRoot: resolveFeaturesRoot(), sliceId, config });
                console.log(chalk.blue(`${sliceId}: ${report.from} → ${report.to}`) +
                    `  updated ${report.updated.length}, added ${report.added.length}, removed ${report.removed.length}, conflicts ${report.conflicts.length}`);
                for (const c of report.conflicts) console.log(chalk.yellow(`  CONFLICT ${c.path} (yours kept; template change not applied)`));
                for (const p of report.removed) console.log(chalk.gray(`  REMOVED from template (left on disk): ${p}`));
            }
        });
    });
```

Add the `feature:upgrade` help line to `master.sh` if not already present (Task 6 step 4 note).

- [x] **Step 5: Full suite + commit**

Run: `cd core && npx vitest run` — all green.

```bash
git add core/src/feature-library/upgrade.ts core/test/feature-library/upgrade.test.ts core/src/index.ts master.sh
git commit -m "feat: feature:upgrade with provenance-checked mechanical updates and conflict reporting"
```

---

### Task 15: Slice lint + CI

**Files:**
- Create: `core/scripts/lint-slices.ts`
- Create: `core/test/feature-library/lint-slices.test.ts`
- Modify: `core/package.json` (script `"lint:slices": "ts-node scripts/lint-slices.ts"`)
- Modify: `.github/workflows/ci.yml` (add lint:slices step after the existing core test step)

**Interfaces:**
- Produces: `lintSlices(featuresRoot: string): Promise<Array<{ slice: string; errors: string[] }>>` — checks per slice: manifest validates (Task 2 rules); every declared platform has ≥1 file under `files/<platform>/`; no file path contains `..` or is absolute; every `{{PLACEHOLDER}}` in every file is either in the substitution ctx key set (validated against a fixture default config's ctx) or `APP_NAME`/`APP_DOMAIN`; requires graph across ALL slices is acyclic and refers to known ids; WIRING.md exists and is non-empty. Exit 1 if any errors.

- [x] **Step 1: Write the failing test** — `core/test/feature-library/lint-slices.test.ts` calls `lintSlices` against a temp features root with one good slice and three bad ones (missing platform dir, `../escape` path file, unknown `{{BOGUS_X}}` placeholder), asserting the error lists.

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, tmpdir } from 'node:path';
import { lintSlices } from '../../scripts/lint-slices';

const root = join(tmpdir(), `fl-lint-${process.pid}`);
const good = join(root, 'good-slice');
const noFiles = join(root, 'no-files');
const escape = join(root, 'escape');
const bogus = join(root, 'bogus');

const manifest = (id: string) => `id: ${id}\nversion: 0.1.0\ndescription: d\nplatforms: [web]\nrequires: []\nconfig-keys: []\nemitters: []\n`;

beforeAll(() => {
  mkdirSync(join(good, 'files/web/app'), { recursive: true });
  writeFileSync(join(good, 'manifest.yaml'), manifest('good-slice'));
  writeFileSync(join(good, 'files/web/app/ok.txt'), 'Hi {{APP_NAME}}\n');
  writeFileSync(join(good, 'WIRING.md'), '# Wiring\nnone\n');

  mkdirSync(join(noFiles, 'files/ios'), { recursive: true });
  writeFileSync(join(noFiles, 'manifest.yaml'), manifest('no-files'));
  writeFileSync(join(noFiles, 'WIRING.md'), '# Wiring\nnone\n');

  mkdirSync(join(escape, 'files/web/app/../../escaped'), { recursive: true });
  writeFileSync(join(escape, 'manifest.yaml'), manifest('escape'));
  writeFileSync(join(escape, 'WIRING.md'), '# Wiring\nnone\n');

  mkdirSync(join(bogus, 'files/web/app'), { recursive: true });
  writeFileSync(join(bogus, 'manifest.yaml'), manifest('bogus'));
  writeFileSync(join(bogus, 'files/web/app/x.txt'), '{{NOT_A_REAL_KEY}}\n');
  writeFileSync(join(bogus, 'WIRING.md'), '# Wiring\nnone\n');
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('lintSlices', () => {
  it('passes the good slice and flags each defect specifically', async () => {
    const reports = await lintSlices(root);
    const byId = Object.fromEntries(reports.map((r) => [r.slice, r.errors]));
    expect(byId['good-slice']).toEqual([]);
    expect(byId['no-files'].join(' ')).toMatch(/no files for platform/);
    expect(byId.escape.join(' ')).toMatch(/\.\./);
    expect(byId.bogus.join(' ')).toMatch(/NOT_A_REAL_KEY/);
  });
});
```

- [x] **Step 2: Run — expect FAIL.** Run: `cd core && npx vitest run test/feature-library/lint-slices.test.ts`

- [x] **Step 3: Implement `core/scripts/lint-slices.ts`** exporting `lintSlices` (same file doubles as CLI via `if (require.main === module)` calling `resolveFeaturesRoot()` and exiting 1 on errors). Placeholder key set: build a ctx from the minimal golden fixture config (load `core/test/templates/golden/minimal/.auto_system/system.yaml` via ConfigManager with cwd override) plus `APP_NAME`/`APP_DOMAIN`.

- [x] **Step 4: Lint the real library**

Run: `cd core && npm run lint:slices`
Expected: 0 errors across the 10 slices. Fix any flagged template (usually a typo'd placeholder — fix the *template file*, not the linter).

- [x] **Step 5: CI** — add to `.github/workflows/ci.yml` after the core-test step:

```yaml
      - name: Lint feature slices
        run: cd core && npm run lint:slices
```

- [x] **Step 6: Full suite + commit**

Run: `cd core && npx vitest run` — green.

```bash
git add core/scripts/lint-slices.ts core/test/feature-library/lint-slices.test.ts core/package.json .github/workflows/ci.yml
git commit -m "feat: slice linter (manifest, paths, placeholders, requires graph) wired into CI"
```

---

### Task 16: Kit skill + llm-ide sync

**Files (different repos!):**
- Create: `.skills/skills/install-feature-slice/SKILL.md` (in llm-ide's checked-out `.skills` submodule → dnsmalla/skills repo, branch `feat/feature-slices`)
- Modify: `.skills` submodule pin in llm-ide (main branch, ask before pushing)
- No auto-system changes.

**Interfaces:**
- Consumes: `master.sh feature:list --json` (schema 1), `feature:add <id>`, `feature:status`, `feature:upgrade`, per-slice `WIRING.md`.

- [ ] **Step 1: Write the skill** (frontmatter style matches `.skills/skills/configure-auth/SKILL.md`):

```markdown
---
name: install-feature-slice
description: >-
  Install fixed cross-platform feature slices (auth, legal, account, jobs,
  webhooks, …) from the auto-system library instead of generating boilerplate.
  Trigger on: "add login", "add auth", "add legal pages", "add account pages",
  "add background jobs", "add webhooks", "scaffold an app from templates",
  "upgrade templates", or any request to build a standard feature in an
  auto-system project. Never hand-write code that a slice provides — check the
  catalog first.
---

# Install feature slices

Fixed features ship as **slices** — versioned, cross-platform template packages
in the engine (`features/`). The engine *copies* slice code; you only write
what's custom. Never write auth/legal/account boilerplate by hand.

## Discover

```bash
bash .auto_system_engine/master.sh feature:list --json
```

Reads ~10 lines per slice (manifest only — template bodies never enter your
context). Pick slices whose description matches the request.

## Install

```bash
bash .auto_system_engine/master.sh feature:add <slice-id>
```

Requires-resolves automatically. Skipped files already exist (brownfield-safe);
`--force` overwrites — NEVER use `--force` without confirming with the user.

## Wire

Read `features/<slice-id>/WIRING.md` **in the engine submodule** and perform
each step. This is the only slice content you need in context.

## Upgrade

`feature:status` shows drift; `feature:upgrade [id]` updates untouched files
mechanically and lists CONFLICTS where the user customized a file. Resolve
conflicts by reading the template's new version and applying its change to the
user's customized file — never discard user code.

## Rules

- Slice-generated files are owned by the engine; re-running install/upgrade is
  how they change (see also: configure-auth for the auth: block).
- After install, run the project's compliance check
  (`master.sh compliance`) to confirm 10/10.
```

- [ ] **Step 2: Register if the kit has an index** — check `.skills/registry.yaml` and `CATALOG.md` for per-skill entries (grep `configure-auth`); add `install-feature-slice` in the same places and family if required.

- [ ] **Step 3: Commit + push the skills repo**

```bash
cd .skills && git checkout -b feat/feature-slices
git add skills/install-feature-slice registry.yaml CATALOG.md 2>/dev/null
git commit -m "feat: install-feature-slice skill for auto-system slice library"
git push -u origin feat/feature-slices
```

- [ ] **Step 4: llm-ide pin bump + sync** (from llm-ide root, after the skills branch merges to the kit's main — coordinate with the user):

```bash
cd .skills && git checkout main && git pull
cd .. && git add .skills
cd extension && npm run sync:skills
cd .. && git add llm_agent && git status
git commit -m "chore: bump skills kit pin with install-feature-slice; sync agent tools"
```

Ask the user before pushing to llm-ide main (repo convention).

- [ ] **Step 5: Verify end-to-end** — from a scratch project with `.auto_system/system.yaml` and the engine submodule: `feature:add legal` → files land; llm-ide agent asked to "add legal pages" picks the skill (verify via the chat "/" menu or agent tool listing showing `install-feature-slice`).

- [ ] **Step 6: Final auto-system commit** — version bump `core/package.json` → `5.18.0`, update root `CHANGELOG.md`, push `feat/feature-slices`, open PR.

---

## Self-Review (done at plan time)

- **Spec coverage:** slice format (T2/T7–T12 manifests), commands list/add/status (T6) upgrade (T14), lockfile semantics incl. suspect-on-corrupt (T4, T14), strict parity + 3 fixtures (T1, every extraction), orchestrator cutover + monolith deletion (T13), kit skill + sync (T16), slice lint + CI (T15), app-shell residue slice added (T7/T11) per spec's "boundaries finalized during extraction" clause.
- **Placeholder risks flagged honestly:** emitter file-target shape in T12 depends on whether hash funcs are a separate file or inline — the plan gives the invariant (golden decides) rather than inventing bytes. Fixture YAML keys verified against schema in T1 Step 2; OAuth provider shape discovered in T1 Step 3.
- **Type consistency:** `SliceManifest.configKeys` (camel, from YAML `config-keys`) used consistently; `RenderedFile.emitter?` produced by render/emitters and consumed by lockfile `FileRecord.emitter?`; `InstallResult.installed` topo order.
