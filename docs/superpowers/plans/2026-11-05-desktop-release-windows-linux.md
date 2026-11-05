# Desktop release on macOS, Windows and Linux Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Tauri desktop app releasable from one tag-driven pipeline: signed and notarized macOS dmg, signed Windows NSIS installer, Linux AppImage and deb, SHA-256 sums, provenance, signed auto-update through `tauri-plugin-updater`, a packaged-app smoke test on every OS, and a manual real-run checklist for the user.

**Architecture:** `.github/workflows/desktop-release.yml` grows from today's unsigned manual draft into: `preflight` (version and secrets, fail fast) → `bundle` matrix (stage core, sign nested binaries, `tauri build` with a release-only `--config` overlay, verify, smoke the packaged app, collect canonically named files) → `publish` (verify every updater signature, write `latest.json` and `SHA256SUMS`, SBOM, attestations, **draft** GitHub Release). Nothing reaches users until the user publishes the draft and runs `desktop-promote.yml`, which copies that release's `latest.json` to a fixed channel release `desktop-stable` (the updater endpoint). All release-only configuration (signing command, updater pubkey and endpoint, `createUpdaterArtifacts`) lives in a generated overlay, so local and CI dev builds stay unsigned and updater-free; the Rust host registers the updater plugin only when the overlay is present and valid.

**Tech Stack:** GitHub Actions, Tauri 2.11.6 CLI 2.11.5, `tauri-plugin-updater` 2.x (new), Node 22 `node:test` / `node:crypto` (Ed25519, BLAKE2b-512), Rust (cargo test), Apple `codesign` / `notarytool` / `stapler`, Windows SDK `signtool` with the Azure Artifact Signing dlib (`Microsoft.ArtifactSigning.Client` NuGet), `dpkg-deb`, `xvfb-run`, `npm sbom`, `actions/attest-build-provenance`.

**Spec:** [desktop-signing-decisions.md](../../how-to/desktop-signing-decisions.md) (decisions 1 to 4, "What you must provide"); [desktop/PACKAGING.md](../../../desktop/PACKAGING.md) (sizes, "do not bundle the SDK `claude` binary", Production sidecar T6, tray caveats, macOS app build signing notes); [MASTER-PLAN](../MASTER-PLAN.md) S2 (signing line, Windows host hardening, Phase 0 Windows autobench) and S10 (Tauri release workflow, Windows signing decision, signed auto-update); [USER-NEEDS](../USER-NEEDS.md) UN-009, UN-070, UN-071, UN-072; [mac-release.yml](../../../.github/workflows/mac-release.yml) (fail-fast secrets pattern) and [release-with-auto-update.md](../../how-to/release-with-auto-update.md) (Sparkle, for contrast).

## Global Constraints

- **Concurrent work:** another agent is editing `desktop/src-tauri` (relay client: `Cargo.toml` deps, `Cargo.lock`, `src/relay/`, `account_oauth.rs`). **No task touches `desktop/src-tauri/src/relay/` or `desktop/src-tauri/src/account_oauth.rs`.** Tasks 8 to 10 edit `Cargo.toml`, `Cargo.lock`, `tauri.conf.json`, `lib.rs`, `build.rs`, `capabilities/default.json`, `prefs.rs` and add `updater.rs`; each edit is small and isolated, and **those tasks start only after the relay work is committed** (check `git status --short desktop/src-tauri` is clean before starting). Tasks 1 to 7 and 11 to 13 touch nothing under `desktop/src-tauri/`.
- Do not touch `ui/screens/settings/sections/AccountSection.tsx`.
- Secrets never enter the repo. Every secret is a GitHub Actions secret, checked by a fail-fast step before any build when the run is signed. Public material (the updater public key) is a committed file so a key change is a reviewed commit.
- The SDK's `claude` binary is never bundled: `stage-core.mjs` with `LLMIDE_STAGE_RELEASE=1` stays the only staging path, and every packaged artifact is re-checked with `verifyNoSdkBinary` (MASTER-PLAN S2 condition 2). Never set `LLMIDE_STAGE_ALLOW_SDK_BINARY`.
- No update is ever installed without a valid signature: the plugin verifies against the embedded key, and the publish job refuses to write `latest.json` unless every `.sig` verifies against `desktop/release/updater.pubkey`.
- Installer size budget: **150 MB per installer file** (Tauri plan §6, PACKAGING.md "Sizes").
- Tag format: `desktop-vX.Y.Z` (distinct from `v*` extension and `mac-v*` Mac trains). Desktop releases are created with `--latest=false` so they never become the repo's "Latest" release.
- Bundle identifier `com.llmide.desktop`, product name `LLM-IDE` (already in `tauri.conf.json` and asserted by `verify-bundle.mjs`; the "spike values" line in the decisions doc is stale and is corrected in Task 13).
- Version of record: `tauri.conf.json` `version` and `Cargo.toml` `[package] version` must be equal and equal the tag (crash reports use `CARGO_PKG_VERSION`).
- Workflow tests follow the house pattern (`extension/tests/scripts-build-number.test.mjs`): read the YAML as text and assert with regexes. New desktop tests live in `desktop/scripts/*.test.mjs` so `cd desktop && npm test` runs them.
- Pinned versions only (exact `=x.y.z` in Cargo, exact npm versions, action major tags as the repo already uses). Any newly pinned version must be at least two weeks old.
- Conventional Commits, one concern per commit, commit on `main` (user preference), push only at night.

---

## File structure

| File | Responsibility | Task |
|---|---|---|
| `desktop/scripts/release-version.mjs` (+ `.test.mjs`) | Tag vs `tauri.conf.json` vs `Cargo.toml` version check | 1 |
| `desktop/scripts/collect-release.mjs` (+ `.test.mjs`) | Find each target's bundle outputs, give them canonical names, enforce the size budget | 2 |
| `desktop/scripts/minisign.mjs` (+ `.test.mjs`) | Verify Tauri updater (minisign) signatures in Node | 3 |
| `desktop/scripts/update-manifest.mjs` (+ `.test.mjs`) | Build and check `latest.json`; write `SHA256SUMS` | 3 |
| `desktop/scripts/smoke-app.mjs` (+ `.test.mjs`) | Launch the packaged app, wait for its core, stop the app, assert no core survives | 4 |
| `.github/workflows/desktop-release.yml` | The pipeline | 5, 6, 7, 11 |
| `desktop/scripts/desktop-release-workflow.test.mjs` | Text asserts on the release, promote and autobench workflows | 5, 6, 7, 11, 12 |
| `desktop/release/node-entitlements.plist` | Hardened-runtime entitlements for the bundled node | 6 |
| `desktop/release/macos-sign-nested.sh` | Sign every Mach-O in the staged core with Developer ID | 6 |
| `desktop/scripts/release-config.mjs` (+ `.test.mjs`) | Generate the release-only `--config` overlay (Windows sign command, updater) | 7, 11 |
| `desktop/scripts/verify-linux-bundle.mjs` (+ `.test.mjs`) | deb Depends + contents, AppImage contents | 8 |
| `desktop/src-tauri/tauri.conf.json` | `bundle.linux.deb.depends` | 8 |
| `desktop/src-tauri/src/updater.rs` | Updater config check, install kind, status, `update_status` / `update_check` / `update_install` commands, background check | 9 |
| `desktop/src-tauri/{Cargo.toml,Cargo.lock,src/lib.rs,build.rs,capabilities/default.json}` | Register the plugin and the three commands | 9 |
| `desktop/src-tauri/src/prefs.rs` | `update_checks` pref | 10 |
| `ui/screens/shell/host-prefs.ts`, `ui/screens/shell/settings-adapter.ts`, `ui/screens/settings/host.ts` | Plumb the pref and the commands | 10 |
| `ui/screens/settings/updates-model.ts` (+ `tests/updates-model.test.ts`) | Decode update status, render text | 10 |
| `ui/screens/settings/sections/UpdatesSection.tsx`, `ui/screens/settings/notices.ts` | The Updates & About group | 10 |
| `desktop/release/updater.pubkey` | Committed updater public key (user creates it, UN-112) | 11 |
| `.github/workflows/desktop-promote.yml` | Copy a published release's `latest.json` to `desktop-stable` | 11 |
| `.github/workflows/desktop-autobench.yml` | Opt-in autobench run (UN-009) | 12 |
| `docs/how-to/desktop-release.md` | Cut, promote, roll back; the real-run checklist | 13 |
| `docs/how-to/desktop-signing-decisions.md`, `docs/how-to/release.md`, `desktop/PACKAGING.md`, `docs/superpowers/{MASTER-PLAN,USER-NEEDS}.md` | Docs and tracking | 13 |

---

### Task 1: Release version check

**Files:**
- Create: `desktop/scripts/release-version.mjs`
- Test: `desktop/scripts/release-version.test.mjs`

**Interfaces:**
- Produces: `tagVersion(tag: string) -> string | null`, `cargoVersion(tomlText: string) -> string | null`, `versionProblems({ tag, conf, cargo }) -> string[]`; CLI `node desktop/scripts/release-version.mjs <tag>` exits 0 or 1 and prints `version=X.Y.Z` on success.

- [ ] **Step 1: Write the failing test**

```js
// desktop/scripts/release-version.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tagVersion, cargoVersion, versionProblems } from './release-version.mjs';

test('tagVersion accepts desktop-vX.Y.Z only', () => {
  assert.equal(tagVersion('desktop-v1.2.3'), '1.2.3');
  for (const t of ['v1.2.3', 'mac-v1.2.3', 'desktop-v1.2', 'desktop-v1.2.3-rc1', '', undefined]) assert.equal(tagVersion(t), null);
});

test('cargoVersion reads [package] only, not a dependency version', () => {
  const toml = '[package]\nname = "x"\nversion = "0.4.0"\n\n[dependencies]\nserde = { version = "=1.0.228" }\nversion = "9.9.9"\n';
  assert.equal(cargoVersion(toml), '0.4.0');
  assert.equal(cargoVersion('[dependencies]\nversion = "1"\n'), null);
});

test('versionProblems: all three must agree and 0.0.0 is refused', () => {
  assert.deepEqual(versionProblems({ tag: 'desktop-v0.1.0', conf: '0.1.0', cargo: '0.1.0' }), []);
  assert.match(versionProblems({ tag: 'desktop-v0.1.0', conf: '0.1.0', cargo: '0.0.9' }).join(), /Cargo\.toml/);
  assert.match(versionProblems({ tag: 'desktop-v0.2.0', conf: '0.1.0', cargo: '0.1.0' }).join(), /tag/);
  assert.match(versionProblems({ tag: 'desktop-v0.0.0', conf: '0.0.0', cargo: '0.0.0' }).join(), /placeholder/);
  assert.match(versionProblems({ tag: 'v0.1.0', conf: '0.1.0', cargo: '0.1.0' }).join(), /desktop-vX\.Y\.Z/);
});

test('the repo files parse today', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const t = join(import.meta.dirname, '..', 'src-tauri');
  assert.ok(cargoVersion(readFileSync(join(t, 'Cargo.toml'), 'utf8')));
  assert.ok(JSON.parse(readFileSync(join(t, 'tauri.conf.json'), 'utf8')).version);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd desktop && node --test scripts/release-version.test.mjs`
Expected: FAIL, `Cannot find module ... release-version.mjs`.

- [ ] **Step 3: Write the implementation**

```js
// desktop/scripts/release-version.mjs
// The release tag, tauri.conf.json `version` and Cargo.toml `[package] version` must name the same X.Y.Z
// (the updater compares tauri.conf's version; crash reports use CARGO_PKG_VERSION).
//   node scripts/release-version.mjs desktop-v0.1.0     -> prints version=0.1.0, exit 0; else the problems, exit 1
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const TAURI = resolve(import.meta.dirname, '..', 'src-tauri');
export const TAG_RE = /^desktop-v(\d+\.\d+\.\d+)$/;

export const tagVersion = (tag) => TAG_RE.exec(tag ?? '')?.[1] ?? null;

export function cargoVersion(text) {
  const pkg = text.split(/^\[/m).find((s) => s.startsWith('package]'));
  return (pkg && /^version\s*=\s*"([^"]+)"/m.exec(pkg)?.[1]) || null;
}

export function versionProblems({ tag, conf, cargo }) {
  const p = [];
  const t = tagVersion(tag);
  if (!t) p.push(`tag ${JSON.stringify(tag)} is not desktop-vX.Y.Z`);
  if (conf !== cargo) p.push(`tauri.conf.json version ${conf} != Cargo.toml version ${cargo}`);
  if (t && conf !== t) p.push(`tauri.conf.json version ${conf} != tag ${t}`);
  if (conf === '0.0.0') p.push('version 0.0.0 is the unreleased placeholder; bump it first (docs/how-to/desktop-release.md)');
  return p;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const conf = JSON.parse(readFileSync(join(TAURI, 'tauri.conf.json'), 'utf8')).version;
  const cargo = cargoVersion(readFileSync(join(TAURI, 'Cargo.toml'), 'utf8'));
  const p = versionProblems({ tag: process.argv[2], conf, cargo });
  if (p.length) { for (const x of p) console.error(`::error::${x}`); process.exit(1); }
  console.log(`version=${conf}`);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd desktop && node --test scripts/release-version.test.mjs`
Expected: PASS (4 tests). Also `node scripts/release-version.mjs desktop-v0.0.0` exits 1 with the placeholder message.

- [ ] **Step 5: Commit**

```bash
git add desktop/scripts/release-version.mjs desktop/scripts/release-version.test.mjs
git commit -m "feat(desktop): add the release tag and version check"
```

---

### Task 2: Collect bundle outputs under canonical names, with the size budget

Tauri writes `LLM-IDE.app.tar.gz` for both macOS arches (no arch in the name), so two targets would collide in one release. This script copies each target's outputs to `dist/` under names that carry the version and arch, and fails on anything missing or over budget.

**Files:**
- Create: `desktop/scripts/collect-release.mjs`
- Test: `desktop/scripts/collect-release.test.mjs`

**Interfaces:**
- Produces: `TARGETS` (keys `darwin-arm64`, `darwin-x64`, `win32-x64`, `linux-x64`), `planCollect({ target, version, files, signed }) -> { copies: [{ from, to }], problems: string[] }` where `files` are paths relative to the bundle dir with `/` separators; `BUDGET_BYTES = 150 * 1024 * 1024`; `budgetProblems(entries: [{ name, size }]) -> string[]`. CLI: `node desktop/scripts/collect-release.mjs --target <t> --version <v> [--signed] <bundleDir> <outDir>`.
- Canonical names (consumed by Task 3): `LLM-IDE_<v>_aarch64.dmg`, `LLM-IDE_<v>_x64.dmg`, `LLM-IDE_<v>_aarch64.app.tar.gz`, `LLM-IDE_<v>_x64.app.tar.gz`, `LLM-IDE_<v>_x64-setup.exe`, `LLM-IDE_<v>_amd64.AppImage`, `LLM-IDE_<v>_amd64.deb`, each updater artifact with a `.sig` beside it.

- [ ] **Step 1: Write the failing test**

```js
// desktop/scripts/collect-release.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planCollect, budgetProblems, BUDGET_BYTES } from './collect-release.mjs';

const V = '0.1.0';
test('macOS arm64: dmg kept, the arch-less app.tar.gz renamed, sig follows when signed', () => {
  const files = ['dmg/LLM-IDE_0.1.0_aarch64.dmg', 'macos/LLM-IDE.app.tar.gz', 'macos/LLM-IDE.app.tar.gz.sig', 'macos/LLM-IDE.app/Contents/Info.plist'];
  const r = planCollect({ target: 'darwin-arm64', version: V, files, signed: true });
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.copies.map((c) => c.to).sort(), ['LLM-IDE_0.1.0_aarch64.app.tar.gz', 'LLM-IDE_0.1.0_aarch64.app.tar.gz.sig', 'LLM-IDE_0.1.0_aarch64.dmg']);
});

test('an unsigned dry run needs only the installers', () => {
  const r = planCollect({ target: 'win32-x64', version: V, files: ['nsis/LLM-IDE_0.1.0_x64-setup.exe'], signed: false });
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.copies.map((c) => c.to), ['LLM-IDE_0.1.0_x64-setup.exe']);
});

test('a signed run without the updater sig fails', () => {
  const r = planCollect({ target: 'linux-x64', version: V, files: ['appimage/LLM-IDE_0.1.0_amd64.AppImage', 'deb/LLM-IDE_0.1.0_amd64.deb'], signed: true });
  assert.match(r.problems.join(), /AppImage\.sig/);
});

test('a missing installer is named, together with what was found', () => {
  const r = planCollect({ target: 'darwin-x64', version: V, files: ['dmg/Other.dmg'], signed: false });
  assert.match(r.problems.join(), /LLM-IDE_0\.1\.0_x64\.dmg.*found: dmg\/Other\.dmg/s);
});

test('unknown target is refused', () => {
  assert.match(planCollect({ target: 'linux-arm64', version: V, files: [], signed: false }).problems.join(), /unknown target/);
});

test('budget applies to installers only, not to .sig files', () => {
  assert.deepEqual(budgetProblems([{ name: 'a.dmg', size: BUDGET_BYTES }, { name: 'a.sig', size: 1 }]), []);
  assert.match(budgetProblems([{ name: 'big.AppImage', size: BUDGET_BYTES + 1 }]).join(), /big\.AppImage.*150 MB/);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd desktop && node --test scripts/collect-release.test.mjs`
Expected: FAIL, module not found.

- [ ] **Step 3: Write the implementation**

```js
// desktop/scripts/collect-release.mjs
// Copies one target's Tauri bundle outputs to <outDir> under canonical, arch-carrying names and checks the
// 150 MB per-installer budget (Tauri plan §6). Signed runs also need each updater artifact's .sig.
//   node scripts/collect-release.mjs --target darwin-arm64 --version 0.1.0 [--signed] <bundleDir> <outDir>
import { copyFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

export const BUDGET_BYTES = 150 * 1024 * 1024;
const INSTALLER_RE = /\.(dmg|exe|AppImage|deb|rpm|msi|tar\.gz)$/;

// Each entry: the source file (regex on the bundle-relative path), its canonical name, and whether it is an
// updater artifact (then a .sig must sit beside it in a signed run).
export const TARGETS = {
  'darwin-arm64': (v) => [
    { re: new RegExp(`^dmg/LLM-IDE_${v}_aarch64\\.dmg$`), to: `LLM-IDE_${v}_aarch64.dmg` },
    { re: /^macos\/LLM-IDE\.app\.tar\.gz$/, to: `LLM-IDE_${v}_aarch64.app.tar.gz`, updater: true },
  ],
  'darwin-x64': (v) => [
    { re: new RegExp(`^dmg/LLM-IDE_${v}_x64\\.dmg$`), to: `LLM-IDE_${v}_x64.dmg` },
    { re: /^macos\/LLM-IDE\.app\.tar\.gz$/, to: `LLM-IDE_${v}_x64.app.tar.gz`, updater: true },
  ],
  'win32-x64': (v) => [
    { re: new RegExp(`^nsis/LLM-IDE_${v}_x64-setup\\.exe$`), to: `LLM-IDE_${v}_x64-setup.exe`, updater: true },
  ],
  'linux-x64': (v) => [
    { re: new RegExp(`^appimage/LLM-IDE_${v}_amd64\\.AppImage$`), to: `LLM-IDE_${v}_amd64.AppImage`, updater: true },
    { re: new RegExp(`^deb/LLM-IDE_${v}_amd64\\.deb$`), to: `LLM-IDE_${v}_amd64.deb` },
  ],
};

export function planCollect({ target, version, files, signed }) {
  const spec = TARGETS[target];
  if (!spec) return { copies: [], problems: [`unknown target ${target}`] };
  const v = version.replaceAll('.', '\\.');
  const copies = [];
  const problems = [];
  const found = files.filter((f) => INSTALLER_RE.test(f) && !f.includes('.app/')).join(', ') || 'nothing';
  for (const e of spec(v)) {
    const want = e.to.replaceAll('\\.', '.');
    const from = files.find((f) => e.re.test(f));
    if (!from) { problems.push(`missing ${want} (found: ${found})`); continue; }
    copies.push({ from, to: want });
    if (e.updater && signed) {
      if (files.includes(`${from}.sig`)) copies.push({ from: `${from}.sig`, to: `${want}.sig` });
      else problems.push(`missing ${want}.sig (the updater signature; is TAURI_SIGNING_PRIVATE_KEY set?)`);
    }
  }
  return { copies, problems };
}

export function budgetProblems(entries) {
  return entries
    .filter((e) => !e.name.endsWith('.sig') && e.size > BUDGET_BYTES)
    .map((e) => `${e.name} is ${(e.size / 1048576).toFixed(1)} MB, over the 150 MB installer budget`);
}

function walk(dir, root = dir, out = []) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    // A .app is a directory; its inside is never a release file, so do not descend.
    if (statSync(p).isDirectory() && !n.endsWith('.app')) walk(p, root, out);
    else out.push(relative(root, p).split(sep).join('/'));
  }
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const a = process.argv.slice(2);
  const opt = (k) => { const i = a.indexOf(k); return i >= 0 ? a.splice(i, 2)[1] : null; };
  const target = opt('--target');
  const version = opt('--version');
  const signed = a.includes('--signed');
  const [bundleDir, outDir] = a.filter((x) => x !== '--signed');
  const { copies, problems } = planCollect({ target, version, files: walk(resolve(bundleDir)), signed });
  mkdirSync(outDir, { recursive: true });
  for (const c of copies) copyFileSync(join(bundleDir, c.from), join(outDir, c.to));
  problems.push(...budgetProblems(copies.map((c) => ({ name: c.to, size: statSync(join(outDir, c.to)).size }))));
  for (const c of copies) console.log(`${c.to}  ${(statSync(join(outDir, c.to)).size / 1048576).toFixed(1)} MB`);
  if (problems.length) { for (const p of problems) console.error(`::error::${p}`); process.exit(1); }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd desktop && node --test scripts/collect-release.test.mjs`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add desktop/scripts/collect-release.mjs desktop/scripts/collect-release.test.mjs
git commit -m "feat(desktop): collect release bundles under canonical names with a size budget"
```

---

### Task 3: Verify updater signatures, build `latest.json`, write `SHA256SUMS`

**Files:**
- Create: `desktop/scripts/minisign.mjs`, `desktop/scripts/update-manifest.mjs`
- Test: `desktop/scripts/minisign.test.mjs`, `desktop/scripts/update-manifest.test.mjs`

**Interfaces:**
- Consumes: canonical names from Task 2.
- Produces: `verifyMinisign(tauriPubkey: string, tauriSig: string, bytes: Buffer) -> { ok: true } | { ok: false, reason: string }`; `RELEASE_BASE = 'https://github.com/dnsmalla/llm-ide/releases/download/'`; `PLATFORMS` (`darwin-aarch64`, `darwin-x86_64`, `windows-x86_64`, `linux-x86_64`); `buildManifest({ version, notes, pubDate, files, read, pubkey }) -> { manifest, problems }`; `manifestProblems(manifest, version) -> string[]`; `sha256Sums(files, read) -> string`. CLI: `node desktop/scripts/update-manifest.mjs --version <v> --pubkey <file> --notes <file> <distDir>` writes `<distDir>/latest.json` and `<distDir>/SHA256SUMS`; `node desktop/scripts/update-manifest.mjs --check <latest.json> --version <v>` only checks shape.

Format notes (Tauri 2 updater): the public key in config and each `.sig` file are base64 of minisign text boxes. The public key box line 2 decodes to `"Ed"` + 8-byte key id + 32-byte Ed25519 key. The signature box line 2 decodes to a 2-byte algorithm (`"ED"` = BLAKE2b-512 prehash, `"Ed"` = legacy raw) + key id + 64-byte signature; line 3 is the trusted comment, line 4 the global signature over `signature || trusted comment`. The test signs with the real Tauri CLI so a format mismatch fails the test, not a release.

- [ ] **Step 1: Write the failing minisign test**

```js
// desktop/scripts/minisign.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyMinisign } from './minisign.mjs';

const CLI = join(import.meta.dirname, '..', 'node_modules', '.bin', process.platform === 'win32' ? 'tauri.cmd' : 'tauri');
const have = existsSync(CLI);

function keypair(dir, name) {
  const key = join(dir, name);
  // --ci: no prompt; empty password.
  execFileSync(CLI, ['signer', 'generate', '--ci', '-p', '', '-w', key], { stdio: 'pipe', shell: process.platform === 'win32' });
  return { key, pub: readFileSync(`${key}.pub`, 'utf8').trim() };
}
function sign(file, key) {
  execFileSync(CLI, ['signer', 'sign', '-f', key, '-p', '', file], { stdio: 'pipe', shell: process.platform === 'win32' });
  return readFileSync(`${file}.sig`, 'utf8').trim();
}

test('a signature made by the Tauri CLI verifies; tampering, another key and garbage do not', { skip: !have && 'desktop/node_modules missing' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'minisign-'));
  const a = keypair(dir, 'a.key');
  const b = keypair(dir, 'b.key');
  const file = join(dir, 'payload.bin');
  writeFileSync(file, Buffer.from('LLM-IDE update payload'));
  const sig = sign(file, a.key);
  const bytes = readFileSync(file);
  assert.deepEqual(verifyMinisign(a.pub, sig, bytes), { ok: true });
  const tampered = Buffer.from(bytes); tampered[0] ^= 1;
  assert.equal(verifyMinisign(a.pub, sig, tampered).ok, false);
  assert.match(verifyMinisign(b.pub, sig, bytes).reason, /key id/);
  assert.equal(verifyMinisign(a.pub, 'not base64 at all', bytes).ok, false);
  assert.equal(verifyMinisign('', sig, bytes).ok, false);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd desktop && node --test scripts/minisign.test.mjs`
Expected: FAIL, module not found. (If the CLI flags were renamed, `npx tauri signer generate --help` and `npx tauri signer sign --help` show the current ones; fix the test's flags, not the verifier.)

- [ ] **Step 3: Write `minisign.mjs`**

```js
// desktop/scripts/minisign.mjs
// Verifies a Tauri updater signature (minisign, Ed25519) in Node, so the publish job can refuse to write a
// latest.json whose signatures the installed apps would reject. Fails closed on any parse problem.
import { createHash, createPublicKey, verify } from 'node:crypto';

const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');
const box = (b64) => Buffer.from(String(b64).trim(), 'base64').toString('utf8').split(/\r?\n/);

function publicKey(tauriPubkey) {
  const raw = Buffer.from(box(tauriPubkey)[1] ?? '', 'base64');
  if (raw.length !== 42 || raw.subarray(0, 2).toString('latin1') !== 'Ed') throw new Error('not a minisign Ed25519 public key');
  return { id: raw.subarray(2, 10), key: createPublicKey({ key: Buffer.concat([SPKI_ED25519, raw.subarray(10)]), format: 'der', type: 'spki' }) };
}

export function verifyMinisign(tauriPubkey, tauriSig, bytes) {
  try {
    const pk = publicKey(tauriPubkey);
    const lines = box(tauriSig);
    const sig = Buffer.from(lines[1] ?? '', 'base64');
    if (sig.length !== 74) return { ok: false, reason: 'malformed signature' };
    const alg = sig.subarray(0, 2).toString('latin1');
    if (!sig.subarray(2, 10).equals(pk.id)) return { ok: false, reason: 'key id mismatch (signed with another key)' };
    const msg = alg === 'ED' ? createHash('blake2b512').update(bytes).digest() : alg === 'Ed' ? bytes : null;
    if (!msg) return { ok: false, reason: `unknown algorithm ${alg}` };
    if (!verify(null, msg, pk.key, sig.subarray(10))) return { ok: false, reason: 'bad signature' };
    const trusted = (lines[2] ?? '').replace(/^trusted comment: /, '');
    const global = Buffer.from(lines[3] ?? '', 'base64');
    if (!verify(null, Buffer.concat([sig.subarray(10), Buffer.from(trusted, 'utf8')]), pk.key, global)) return { ok: false, reason: 'bad trusted-comment signature' };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: String(e?.message ?? e) };
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd desktop && node --test scripts/minisign.test.mjs`
Expected: PASS.

- [ ] **Step 5: Write the failing manifest test**

```js
// desktop/scripts/update-manifest.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildManifest, manifestProblems, sha256Sums, PLATFORMS, RELEASE_BASE } from './update-manifest.mjs';

const V = '0.2.0';
const names = ['LLM-IDE_0.2.0_aarch64.app.tar.gz', 'LLM-IDE_0.2.0_x64.app.tar.gz', 'LLM-IDE_0.2.0_x64-setup.exe', 'LLM-IDE_0.2.0_amd64.AppImage'];
const files = [...names, ...names.map((n) => `${n}.sig`), 'LLM-IDE_0.2.0_amd64.deb', 'LLM-IDE_0.2.0_aarch64.dmg'];
const read = (n) => Buffer.from(n.endsWith('.sig') ? `SIG:${n}` : `BODY:${n}`);
const okVerify = () => ({ ok: true });

test('every platform gets its url and signature text', () => {
  const { manifest, problems } = buildManifest({ version: V, notes: 'n', pubDate: '2026-11-05T00:00:00Z', files, read, pubkey: 'k', verifySig: okVerify });
  assert.deepEqual(problems, []);
  assert.deepEqual(Object.keys(manifest.platforms).sort(), PLATFORMS.map((p) => p.key).sort());
  assert.equal(manifest.platforms['windows-x86_64'].url, `${RELEASE_BASE}desktop-v0.2.0/LLM-IDE_0.2.0_x64-setup.exe`);
  assert.equal(manifest.platforms['linux-x86_64'].signature, 'SIG:LLM-IDE_0.2.0_amd64.AppImage.sig');
  assert.deepEqual(manifestProblems(manifest, V), []);
});

test('a missing platform, a missing sig or a failed verification is a problem', () => {
  const drop = files.filter((f) => !f.startsWith('LLM-IDE_0.2.0_x64-setup.exe'));
  assert.match(buildManifest({ version: V, notes: '', pubDate: 'x', files: drop, read, pubkey: 'k', verifySig: okVerify }).problems.join(), /windows-x86_64/);
  const noSig = files.filter((f) => f !== 'LLM-IDE_0.2.0_amd64.AppImage.sig');
  assert.match(buildManifest({ version: V, notes: '', pubDate: 'x', files: noSig, read, pubkey: 'k', verifySig: okVerify }).problems.join(), /AppImage\.sig/);
  const bad = () => ({ ok: false, reason: 'bad signature' });
  assert.match(buildManifest({ version: V, notes: '', pubDate: 'x', files, read, pubkey: 'k', verifySig: bad }).problems.join(), /bad signature/);
});

test('manifestProblems refuses a wrong version, http, another repo or tag, and an empty signature', () => {
  const { manifest } = buildManifest({ version: V, notes: '', pubDate: 'x', files, read, pubkey: 'k', verifySig: okVerify });
  assert.match(manifestProblems(manifest, '0.3.0').join(), /version/);
  const m = structuredClone(manifest);
  m.platforms['darwin-aarch64'].url = 'http://evil.example/x';
  m.platforms['linux-x86_64'].signature = '';
  m.platforms['windows-x86_64'].url = `${RELEASE_BASE}desktop-v0.1.0/x.exe`;
  const p = manifestProblems(m, V).join('\n');
  assert.match(p, /darwin-aarch64/); assert.match(p, /linux-x86_64/); assert.match(p, /windows-x86_64/);
});

test('SHA256SUMS lists every non-sig file, sorted, sha256sum format', () => {
  const out = sha256Sums(['b.deb', 'a.dmg', 'a.dmg.sig'], (n) => Buffer.from(n));
  const lines = out.trim().split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^[0-9a-f]{64} {2}a\.dmg$/);
  assert.match(lines[1], /^[0-9a-f]{64} {2}b\.deb$/);
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `cd desktop && node --test scripts/update-manifest.test.mjs`
Expected: FAIL, module not found.

- [ ] **Step 7: Write `update-manifest.mjs`**

```js
// desktop/scripts/update-manifest.mjs
// Builds the Tauri updater manifest (latest.json) from a release dist folder and refuses to write it unless
// every platform is present and every .sig verifies against the committed public key. Also writes SHA256SUMS.
//   node scripts/update-manifest.mjs --version 0.2.0 --pubkey release/updater.pubkey --notes notes.md <distDir>
//   node scripts/update-manifest.mjs --check latest.json --version 0.2.0
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { verifyMinisign } from './minisign.mjs';

export const RELEASE_BASE = 'https://github.com/dnsmalla/llm-ide/releases/download/';
export const PLATFORMS = [
  { key: 'darwin-aarch64', file: (v) => `LLM-IDE_${v}_aarch64.app.tar.gz` },
  { key: 'darwin-x86_64', file: (v) => `LLM-IDE_${v}_x64.app.tar.gz` },
  { key: 'windows-x86_64', file: (v) => `LLM-IDE_${v}_x64-setup.exe` },
  { key: 'linux-x86_64', file: (v) => `LLM-IDE_${v}_amd64.AppImage` },
];
const NOTES_MAX = 4000;

export function buildManifest({ version, notes, pubDate, files, read, pubkey, verifySig = verifyMinisign }) {
  const problems = [];
  const platforms = {};
  for (const p of PLATFORMS) {
    const name = p.file(version);
    if (!files.includes(name)) { problems.push(`${p.key}: ${name} missing`); continue; }
    if (!files.includes(`${name}.sig`)) { problems.push(`${p.key}: ${name}.sig missing`); continue; }
    const signature = read(`${name}.sig`).toString('utf8').trim();
    const v = verifySig(pubkey, signature, read(name));
    if (!v.ok) { problems.push(`${p.key}: ${name}: ${v.reason}`); continue; }
    platforms[p.key] = { signature, url: `${RELEASE_BASE}desktop-v${version}/${name}` };
  }
  const manifest = { version, notes: String(notes ?? '').slice(0, NOTES_MAX), pub_date: pubDate, platforms };
  return { manifest, problems: [...problems, ...(problems.length ? [] : manifestProblems(manifest, version))] };
}

export function manifestProblems(m, version) {
  const p = [];
  if (m?.version !== version) p.push(`manifest version ${m?.version} != ${version}`);
  const prefix = `${RELEASE_BASE}desktop-v${version}/`;
  for (const { key } of PLATFORMS) {
    const e = m?.platforms?.[key];
    if (!e) { p.push(`${key}: missing`); continue; }
    if (typeof e.url !== 'string' || !e.url.startsWith(prefix)) p.push(`${key}: url must start with ${prefix}`);
    if (typeof e.signature !== 'string' || e.signature.length < 40) p.push(`${key}: empty or short signature`);
  }
  return p;
}

export function sha256Sums(files, read) {
  return files.filter((f) => !f.endsWith('.sig')).sort()
    .map((f) => `${createHash('sha256').update(read(f)).digest('hex')}  ${f}`).join('\n') + '\n';
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const a = process.argv.slice(2);
  const opt = (k) => { const i = a.indexOf(k); return i >= 0 ? a.splice(i, 2)[1] : null; };
  const version = opt('--version');
  const check = opt('--check');
  if (check) {
    const p = manifestProblems(JSON.parse(readFileSync(check, 'utf8')), version);
    if (p.length) { for (const x of p) console.error(`::error::${x}`); process.exit(1); }
    console.log('latest.json OK'); process.exit(0);
  }
  const pubkey = readFileSync(opt('--pubkey'), 'utf8').trim();
  const notesFile = opt('--notes');
  const dist = resolve(a[0]);
  const files = readdirSync(dist);
  const read = (n) => readFileSync(join(dist, n));
  const { manifest, problems } = buildManifest({ version, notes: notesFile ? readFileSync(notesFile, 'utf8') : '', pubDate: new Date().toISOString(), files, read, pubkey });
  if (problems.length) { for (const x of problems) console.error(`::error::${x}`); process.exit(1); }
  writeFileSync(join(dist, 'latest.json'), JSON.stringify(manifest, null, 2) + '\n');
  writeFileSync(join(dist, 'SHA256SUMS'), sha256Sums(readdirSync(dist).filter((f) => f !== 'SHA256SUMS'), read));
  console.log(`latest.json + SHA256SUMS written for ${Object.keys(manifest.platforms).length} platforms`);
}
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `cd desktop && node --test scripts/minisign.test.mjs scripts/update-manifest.test.mjs`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add desktop/scripts/minisign.mjs desktop/scripts/minisign.test.mjs desktop/scripts/update-manifest.mjs desktop/scripts/update-manifest.test.mjs
git commit -m "feat(desktop): verify updater signatures and build the update manifest"
```

---

### Task 4: Packaged-app smoke test

`smoke-core.mjs` tests the staged core alone. This one launches the **packaged** app the way a user does (no repo checkout, memory keychain, temp data dir), waits for the core it spawns, stops the app, and asserts the core tree died with it (SIGTERM reaches the host's `ctrlc` handler on unix; on Windows `taskkill /F` of the host alone must take the core down through the Job Object).

**Files:**
- Create: `desktop/scripts/smoke-app.mjs`
- Test: `desktop/scripts/smoke-app.test.mjs`

**Interfaces:**
- Produces: `CORE_PORTS = [3457, 3458, 3459]`; `isHostCore(status: number, headers: Headers | Record<string,string>) -> boolean`; `coreProcesses(psText: string) -> number[]` (unix `ps -axo pid=,command=` output); `coreProcessesWin(json: string) -> number[]` (PowerShell `Get-CimInstance Win32_Process | Select ProcessId,CommandLine | ConvertTo-Json` output). CLI: `node desktop/scripts/smoke-app.mjs <path-to-app-executable>`; exit 0 or 1.

- [ ] **Step 1: Write the failing test**

```js
// desktop/scripts/smoke-app.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isHostCore, coreProcesses, coreProcessesWin } from './smoke-app.mjs';

const NONCE = 'a'.repeat(64);
test('only a 200 /health with a 64-hex launch nonce is the app-spawned core', () => {
  assert.equal(isHostCore(200, { 'x-llmide-nonce': NONCE }), true);
  assert.equal(isHostCore(200, {}), false);
  assert.equal(isHostCore(200, { 'x-llmide-nonce': 'short' }), false);
  assert.equal(isHostCore(503, { 'x-llmide-nonce': NONCE }), false);
  assert.equal(isHostCore(200, new Headers({ 'x-llmide-nonce': NONCE })), true);
});

test('unix ps: the bundled node running server.mjs, nothing else', () => {
  const ps = [
    '  101 /Applications/LLM-IDE.app/Contents/Resources/core/node/node /Applications/LLM-IDE.app/Contents/Resources/core/root/extension/server.mjs',
    '  102 /usr/local/bin/node server.mjs',
    '  103 /tmp/.mount_LLMxyz/usr/lib/LLM-IDE/core/node/node /tmp/.mount_LLMxyz/usr/lib/LLM-IDE/core/root/extension/server.mjs',
    '  104 /Applications/LLM-IDE.app/Contents/Resources/core/node/node --version',
  ].join('\n');
  assert.deepEqual(coreProcesses(ps), [101, 103]);
});

test('windows: CommandLine with \\core\\node\\node.exe and server.mjs', () => {
  const json = JSON.stringify([
    { ProcessId: 7, CommandLine: '"C:\\Users\\r\\AppData\\Local\\LLM-IDE\\core\\node\\node.exe" "C:\\Users\\r\\AppData\\Local\\LLM-IDE\\core\\root\\extension\\server.mjs"' },
    { ProcessId: 8, CommandLine: 'node.exe server.mjs' },
    { ProcessId: 9, CommandLine: null },
  ]);
  assert.deepEqual(coreProcessesWin(json), [7]);
  assert.deepEqual(coreProcessesWin(JSON.stringify({ ProcessId: 7, CommandLine: 'x\\core\\node\\node.exe y\\server.mjs' })), [7]);
  assert.deepEqual(coreProcessesWin(''), []);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd desktop && node --test scripts/smoke-app.test.mjs`
Expected: FAIL, module not found.

- [ ] **Step 3: Write the implementation**

```js
// desktop/scripts/smoke-app.mjs
// Launches the PACKAGED app (no repo checkout), waits for the core it spawns on 3457..3459 (a 200 /health that
// echoes a launch nonce), stops the app the way the OS would, and asserts no bundled-node core process survives.
// Memory keychain + a temp data dir, so the runner's keychain and real user data are never touched. No model call.
//   node scripts/smoke-app.mjs <app executable>      (Linux: run under xvfb-run; AppImage: APPIMAGE_EXTRACT_AND_RUN=1)
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, openSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const CORE_PORTS = [3457, 3458, 3459];
const WIN = process.platform === 'win32';
const START_MS = 120_000;
const STOP_MS = 20_000;

export function isHostCore(status, headers) {
  const n = typeof headers?.get === 'function' ? headers.get('x-llmide-nonce') : headers?.['x-llmide-nonce'];
  return status === 200 && /^[0-9a-f]{64}$/.test(n ?? '');
}

const isCoreCmd = (cmd, nodeMark) => typeof cmd === 'string' && cmd.includes(nodeMark) && cmd.includes('server.mjs');

export function coreProcesses(psText) {
  return psText.split('\n').map((l) => /^\s*(\d+)\s+(.*)$/.exec(l)).filter(Boolean)
    .filter((m) => isCoreCmd(m[2], '/core/node/node ')).map((m) => Number(m[1]));
}

export function coreProcessesWin(json) {
  if (!json.trim()) return [];
  const rows = [JSON.parse(json)].flat();
  return rows.filter((r) => isCoreCmd(r?.CommandLine, '\\core\\node\\node.exe')).map((r) => Number(r.ProcessId));
}

function listCore() {
  if (WIN) {
    const ps = 'Get-CimInstance Win32_Process -Filter "Name=\'node.exe\'" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress';
    return coreProcessesWin(execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }));
  }
  return coreProcesses(execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }));
}

async function probe() {
  for (const port of CORE_PORTS) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`, { redirect: 'manual', signal: AbortSignal.timeout(1500) });
      if (isHostCore(r.status, r.headers)) return port;
    } catch { /* not listening yet */ }
  }
  return null;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const exe = resolve(process.argv[2] ?? '');
  const data = mkdtempSync(join(tmpdir(), 'llmide-smoke-app-'));
  const log = join(data, 'app.log');
  const env = { ...process.env, LLMIDE_KEYCHAIN_BACKEND: 'memory', LLMIDE_DESKTOP_DATA_DIR: data };
  for (const k of ['LLMIDE_ADOPT_CORE', 'LLMIDE_POC_BUNDLED', 'LLMIDE_REPO_ROOT', 'LLMIDE_NODE_BIN']) delete env[k];
  if (listCore().length) { console.error('FAIL a core process is already running before launch'); process.exit(1); }
  const fd = openSync(log, 'a');
  const app = spawn(exe, [], { env, stdio: ['ignore', fd, fd] });
  let port = null;
  const t0 = Date.now();
  while (Date.now() - t0 < START_MS && port === null && app.exitCode === null) { port = await probe(); if (port === null) await sleep(1000); }
  const fail = (m) => { console.error(`FAIL ${m}\n--- app log ---\n${readFileSync(log, 'utf8').slice(-4000)}`); try { app.kill('SIGKILL'); } catch {} process.exit(1); };
  if (port === null) fail(`no app-spawned core answered /health on ${CORE_PORTS.join('/')} within ${START_MS / 1000}s (app exit ${app.exitCode})`);
  console.log(`OK   core healthy on :${port} after ${Date.now() - t0} ms`);
  const pids = listCore();
  if (!pids.length) fail('core healthy but no bundled-node server.mjs process matched; update coreProcesses() for this layout');
  console.log(`OK   core process(es): ${pids.join(', ')}`);
  // Windows: kill the host alone (no /T); the Job Object (KILL_ON_JOB_CLOSE) must take the core with it.
  if (WIN) execFileSync('taskkill', ['/PID', String(app.pid), '/F'], { stdio: 'ignore' });
  else app.kill('SIGTERM');
  const t1 = Date.now();
  while (Date.now() - t1 < STOP_MS && (listCore().length || (await probe()) !== null)) await sleep(500);
  const left = listCore();
  if (left.length) fail(`core survived the app: ${left.join(', ')}`);
  if ((await probe()) !== null) fail('a core still answers /health after the app stopped');
  console.log(`OK   app stopped, no core left after ${Date.now() - t1} ms`);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd desktop && node --test scripts/smoke-app.test.mjs`
Expected: PASS (3 tests). Manual check on this Mac (outside the agent sandbox, which blocks loopback listen): `scripts/build-desktop-mac.sh && node desktop/scripts/smoke-app.mjs desktop/src-tauri/target/release/bundle/macos/LLM-IDE.app/Contents/MacOS/llmide-desktop-poc` prints three `OK` lines.

- [ ] **Step 5: Commit**

```bash
git add desktop/scripts/smoke-app.mjs desktop/scripts/smoke-app.test.mjs
git commit -m "test(desktop): smoke-test the packaged app start and clean quit"
```

---

### Task 5: Restructure the release workflow (dry run: unsigned, all OSes, collected, smoked)

Today's draft has never run on a runner (MASTER-PLAN S10) and would fail: `npm run build` (Tauri `beforeBuildCommand`) needs the graph-kit submodule and the `ui/kit`, `web` and graph-kit web installs that `desktop-ci.yml` does. This task makes the dry run real. Signing comes in Tasks 6 and 7, publishing in Task 11.

**Files:**
- Modify: `.github/workflows/desktop-release.yml` (full rewrite below)
- Create: `desktop/scripts/desktop-release-workflow.test.mjs`

**Interfaces:**
- Consumes: `release-version.mjs` (Task 1), `collect-release.mjs` (Task 2), `update-manifest.mjs` sums only via `sha256Sums` CLI path later, `smoke-app.mjs` (Task 4), existing `stage-core.mjs`, `check-core-deps.mjs`, `smoke-core.mjs`, `verify-bundle.mjs`, `sdk-binary.mjs`.
- Produces: job ids `preflight`, `bundle`, `publish`; matrix field `target` (`darwin-arm64`, `darwin-x64`, `win32-x64`, `linux-x64`); env `SIGNED` (`'true'`/`'false'`); artifact name `llmide-desktop-<target>` holding `dist-<target>/`.

- [ ] **Step 1: Write the failing workflow test**

```js
// desktop/scripts/desktop-release-workflow.test.mjs
// Text asserts on the desktop release workflows (house pattern: extension/tests/scripts-build-number.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const WF = join(import.meta.dirname, '..', '..', '.github', 'workflows');
const rel = () => readFileSync(join(WF, 'desktop-release.yml'), 'utf8');

test('dry run: manual dispatch with a signed input defaulting to false', () => {
  const wf = rel();
  assert.match(wf, /workflow_dispatch:\s*\n\s+inputs:\s*\n\s+signed:/);
  assert.match(wf, /default: false/);
});

test('the bundle matrix covers four targets and stages each on a native runner', () => {
  const wf = rel();
  for (const t of ['darwin-arm64', 'darwin-x64', 'win32-x64', 'linux-x64']) assert.match(wf, new RegExp(`target: ${t}`));
  assert.match(wf, /LLMIDE_STAGE_RELEASE: '1'/);
  assert.doesNotMatch(wf, /LLMIDE_STAGE_ALLOW_SDK_BINARY/);
});

test('the frontend build has what desktop-ci gives it', () => {
  const wf = rel();
  assert.match(wf, /git submodule update --init mac\/LocalPackages\/graph-kit/);
  for (const d of ['ui/kit', 'web', 'mac/LocalPackages/graph-kit/web']) assert.match(wf, new RegExp(`npm ci --prefix ${d.replaceAll('/', '\\/')}`));
});

test('every bundle is collected, re-checked for the SDK claude binary and smoked as a packaged app', () => {
  const wf = rel();
  assert.match(wf, /collect-release\.mjs --target \$\{\{ matrix\.target \}\}/);
  assert.match(wf, /smoke-app\.mjs/);
  assert.match(wf, /xvfb-run/);
  assert.match(wf, /verify-bundle\.mjs/);
});

test('permissions default to read; nothing but publish can write', () => {
  const wf = rel();
  assert.match(wf, /^permissions:\s*\n\s+contents: read/m);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd desktop && node --test scripts/desktop-release-workflow.test.mjs`
Expected: FAIL on the dispatch input, collect and smoke asserts.

- [ ] **Step 3: Rewrite the workflow**

Replace `.github/workflows/desktop-release.yml` with:

```yaml
name: desktop-release

# Release pipeline for the Tauri desktop app (desktop/). See docs/how-to/desktop-release.md.
# - workflow_dispatch: dry run. Unsigned unless `signed: true` (then every signing secret is required and the
#   artifacts are signed, but nothing is published). Artifacts live 7 days and must not be distributed.
# - push of a desktop-vX.Y.Z tag (added in Task 11): signed, notarized, updater artifacts, DRAFT GitHub Release.
# Secrets are listed in the preflight job; a signed run fails there, before any build, if one is missing.

on:
  workflow_dispatch:
    inputs:
      signed:
        description: 'Sign and notarize (needs every signing secret); never publishes'
        type: boolean
        default: false

permissions:
  contents: read

concurrency:
  group: desktop-release-${{ github.ref }}
  cancel-in-progress: false

env:
  SIGNED: ${{ startsWith(github.ref, 'refs/tags/desktop-v') || inputs.signed == true }}

jobs:
  preflight:
    name: Preflight
    runs-on: ubuntu-latest
    outputs:
      version: ${{ steps.v.outputs.version }}
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v6
        with:
          node-version: 22
      - name: Version
        id: v
        run: |
          if [ "$SIGNED" = "true" ] && [[ "$GITHUB_REF" == refs/tags/* ]]; then
            node desktop/scripts/release-version.mjs "$GITHUB_REF_NAME" >> "$GITHUB_OUTPUT"
          else
            echo "version=$(node -p "require('./desktop/src-tauri/tauri.conf.json').version")" >> "$GITHUB_OUTPUT"
          fi

  bundle:
    name: Bundle (${{ matrix.target }})
    needs: preflight
    runs-on: ${{ matrix.os }}
    timeout-minutes: 75
    strategy:
      fail-fast: false
      matrix:
        include:
          - { target: darwin-arm64, os: macos-latest, bundles: 'app,dmg' }
          - { target: darwin-x64, os: macos-15-intel, bundles: 'app,dmg' }
          - { target: win32-x64, os: windows-latest, bundles: nsis }
          - { target: linux-x64, os: ubuntu-latest, bundles: 'deb,appimage' }
    defaults:
      run:
        shell: bash
    env:
      VERSION: ${{ needs.preflight.outputs.version }}
      BUNDLE: desktop/src-tauri/target/release/bundle
    steps:
      - uses: actions/checkout@v7
      - name: Check out graph-kit submodule (System page web source)
        run: git submodule update --init mac/LocalPackages/graph-kit
      - uses: actions/setup-node@v6
        with:
          node-version: 22
          cache: npm
          cache-dependency-path: desktop/package-lock.json
      - name: Install Linux system dependencies
        if: runner.os == 'Linux'
        run: |
          sudo apt-get update
          sudo apt-get install -y --no-install-recommends \
            build-essential pkg-config file xvfb \
            libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev \
            libayatana-appindicator3-dev librsvg2-dev libssl-dev libxdo-dev
      - name: Install Rust (stable)
        run: |
          rustup toolchain install stable --profile minimal
          rustup default stable
      - name: Install npm dependencies
        run: |
          npm ci --prefix desktop
          npm ci --prefix extension
          npm ci --prefix ui/kit
          npm ci --prefix web
          npm ci --prefix mac/LocalPackages/graph-kit/web
      # Pinned official Node for this runner's target, SHA-256 checked against the repo pin and nodejs.org,
      # production deps only, the SDK's claude binary removed and re-verified (MASTER-PLAN S2 condition 2).
      - name: Stage the Node core
        env:
          LLMIDE_STAGE_RELEASE: '1'
        run: node desktop/scripts/stage-core.mjs
      - name: Smoke-test the staged core
        run: |
          node desktop/scripts/check-core-deps.mjs
          node desktop/scripts/smoke-core.mjs
      # (Task 6 inserts macOS signing here; Task 7 inserts Windows signing here.)
      - name: Build bundles
        working-directory: desktop
        env:
          LLMIDE_OMIT_SOURCE_ROOT: '1'
        run: npm run tauri build -- --bundles ${{ matrix.bundles }}
      - name: Verify the macOS bundle
        if: runner.os == 'macOS'
        run: node desktop/scripts/verify-bundle.mjs "$BUNDLE/macos/LLM-IDE.app"
      - name: Smoke-test the packaged app (macOS)
        if: runner.os == 'macOS'
        run: |
          exe="$BUNDLE/macos/LLM-IDE.app/Contents/MacOS/$(plutil -extract CFBundleExecutable raw "$BUNDLE/macos/LLM-IDE.app/Contents/Info.plist")"
          LLMIDE_CORE_DIR="$BUNDLE/macos/LLM-IDE.app/Contents/Resources/core" node desktop/scripts/smoke-core.mjs
          node desktop/scripts/smoke-app.mjs "$exe"
      - name: Install, smoke-test and uninstall (Windows)
        if: runner.os == 'Windows'
        shell: pwsh
        run: |
          $setup = Get-ChildItem "$env:BUNDLE/nsis/*-setup.exe" | Select-Object -First 1
          Start-Process -Wait -FilePath $setup.FullName -ArgumentList '/S'
          $dir = Join-Path $env:LOCALAPPDATA 'LLM-IDE'
          $exe = Get-ChildItem "$dir/*.exe" | Where-Object { $_.Name -notlike 'uninstall*' } | Select-Object -First 1
          node desktop/scripts/smoke-app.mjs $exe.FullName
          if ($LASTEXITCODE -ne 0) { exit 1 }
          Start-Process -Wait -FilePath (Join-Path $dir 'uninstall.exe') -ArgumentList '/S'
      - name: Smoke-test the packaged app (Linux AppImage)
        if: runner.os == 'Linux'
        env:
          APPIMAGE_EXTRACT_AND_RUN: '1'
        run: |
          app=$(ls "$BUNDLE"/appimage/*.AppImage | head -n1)
          chmod +x "$app"
          xvfb-run -a node desktop/scripts/smoke-app.mjs "$app"
      - name: Collect release files
        run: |
          signed=""; [ "$SIGNED" = "true" ] && signed="--signed"
          node desktop/scripts/collect-release.mjs --target ${{ matrix.target }} --version "$VERSION" $signed "$BUNDLE" "dist-${{ matrix.target }}"
      - uses: actions/upload-artifact@v7
        with:
          name: llmide-desktop-${{ matrix.target }}
          path: dist-${{ matrix.target }}/
          if-no-files-found: error
          retention-days: 7

  publish:
    name: Checksums and SBOM
    needs: [preflight, bundle]
    runs-on: ubuntu-latest
    env:
      VERSION: ${{ needs.preflight.outputs.version }}
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v6
        with:
          node-version: 22
      - uses: actions/download-artifact@v7
        with:
          pattern: llmide-desktop-*
          path: dist
          merge-multiple: true
      - name: SHA256SUMS
        run: (cd dist && sha256sum $(ls | grep -v '\.sig$' | sort) > SHA256SUMS && cat SHA256SUMS)
      - name: SBOM of the shipped Node core and the desktop frontend (CycloneDX)
        run: |
          npm ci --prefix extension --omit dev --ignore-scripts
          npm sbom --prefix extension --omit dev --sbom-format cyclonedx > "dist/LLM-IDE_${VERSION}_core.cdx.json"
          npm sbom --prefix desktop --omit dev --sbom-format cyclonedx > "dist/LLM-IDE_${VERSION}_frontend.cdx.json"
      - uses: actions/upload-artifact@v7
        with:
          name: llmide-desktop-release-${{ needs.preflight.outputs.version }}
          path: dist/
          retention-days: 7
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd desktop && node --test scripts/desktop-release-workflow.test.mjs`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit, then dry-run on GitHub (night push window)**

```bash
git add .github/workflows/desktop-release.yml desktop/scripts/desktop-release-workflow.test.mjs
git commit -m "ci(desktop): make the release dry run real on all four targets"
```

After the push: `gh workflow run desktop-release.yml` then `gh run watch`. Expected: four green bundle jobs and a green publish job. Record in `desktop/PACKAGING.md` (Task 13) the installer sizes printed by the collect step and the smoke timings. If `collect-release` reports a missing file, its message lists what Tauri actually produced: fix the regexes in `TARGETS` and their test to match, never loosen them to "any file". If an installer is over 150 MB (most likely the AppImage, which carries GTK/WebKit libraries), stop and raise it with the user (decision D2) rather than raising the budget.

---

### Task 6: macOS Developer ID signing and notarization

Reuses the Mac app's secrets (`mac-release.yml`). The bundled node and every native `.node` must carry a Developer ID signature with the hardened runtime and a timestamp, or notarization rejects the app (PACKAGING.md "macOS app build"). Tauri signs the app and notarizes it when `APPLE_SIGNING_IDENTITY` + `APPLE_ID`/`APPLE_PASSWORD`/`APPLE_TEAM_ID` are set; the nested core binaries are signed first by our script, the dmg is notarized and stapled after.

**Files:**
- Create: `desktop/release/node-entitlements.plist`, `desktop/release/macos-sign-nested.sh`
- Modify: `.github/workflows/desktop-release.yml` (preflight secret check, three macOS steps, Tauri env)
- Modify: `desktop/scripts/desktop-release-workflow.test.mjs`

**Interfaces:**
- Consumes: secrets `MAC_CERT_P12_BASE64`, `MAC_CERT_PASSWORD`, `MAC_CI_KEYCHAIN_PASSWORD`, `MAC_SIGN_IDENTITY`, `MAC_NOTARY_APPLE_ID`, `MAC_NOTARY_PASSWORD`, `MAC_NOTARY_TEAM_ID` (same names and meanings as `mac-release.yml`).
- Produces: `desktop/release/macos-sign-nested.sh <coreDir> <identity | --list>`.

- [ ] **Step 1: Add failing workflow asserts**

Append to `desktop/scripts/desktop-release-workflow.test.mjs`:

```js
const MAC_SECRETS = ['MAC_CERT_P12_BASE64', 'MAC_CERT_PASSWORD', 'MAC_CI_KEYCHAIN_PASSWORD', 'MAC_SIGN_IDENTITY', 'MAC_NOTARY_APPLE_ID', 'MAC_NOTARY_PASSWORD', 'MAC_NOTARY_TEAM_ID'];

test('a signed run checks every macOS secret before building', () => {
  const wf = rel();
  const check = wf.slice(wf.indexOf('Check required secrets'), wf.indexOf('bundle:'));
  for (const s of MAC_SECRETS) assert.match(check, new RegExp(`\\b${s}\\b`));
});

test('macOS: nested binaries signed before the build, dmg notarized and stapled, Gatekeeper checked', () => {
  const wf = rel();
  assert.ok(wf.indexOf('macos-sign-nested.sh') < wf.indexOf('npm run tauri build'));
  assert.match(wf, /xcrun notarytool submit .*--wait/);
  assert.match(wf, /xcrun stapler staple/);
  assert.match(wf, /spctl -a -vvv -t exec/);
  assert.match(wf, /security delete-keychain/);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd desktop && node --test scripts/desktop-release-workflow.test.mjs`
Expected: FAIL on the two new tests.

- [ ] **Step 3: Write the entitlements and the nested-signing script**

```xml
<!-- desktop/release/node-entitlements.plist -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <!-- V8 JIT in the bundled node under the hardened runtime. better_sqlite3.node is signed with the same team
       identity, so library validation passes without disable-library-validation. Add an entitlement only when
       the signed smoke test proves it is needed, and record why here. -->
  <key>com.apple.security.cs.allow-jit</key>
  <true/>
</dict>
</plist>
```

```bash
#!/usr/bin/env bash
# desktop/release/macos-sign-nested.sh <coreDir> <identity|--list>
# Signs every Mach-O file in the staged core (node, *.node prebuilds, any vendored helper) with the Developer ID,
# hardened runtime and a secure timestamp; node also gets node-entitlements.plist. --list only prints them.
set -euo pipefail
core="${1:?core dir}"; identity="${2:?identity or --list}"
ent="$(cd "$(dirname "$0")" && pwd)/node-entitlements.plist"
[ -f "$core/node/node" ] || { echo "no bundled node at $core/node/node (run stage-core.mjs)" >&2; exit 1; }
count=0
while IFS= read -r -d '' f; do
  file -b "$f" | grep -q 'Mach-O' || continue
  count=$((count + 1))
  if [ "$identity" = "--list" ]; then echo "$f"; continue; fi
  if [ "$f" = "$core/node/node" ]; then
    codesign --force --timestamp --options runtime --entitlements "$ent" --sign "$identity" "$f"
  else
    codesign --force --timestamp --options runtime --sign "$identity" "$f"
  fi
  codesign --verify --strict "$f"
done < <(find "$core" -type f -print0)
echo "Mach-O files: $count"
```

Run locally: `chmod +x desktop/release/macos-sign-nested.sh && node desktop/scripts/stage-core.mjs && desktop/release/macos-sign-nested.sh desktop/resources/core --list`
Expected: the list includes `desktop/resources/core/node/node` and the `better_sqlite3.node` prebuild, and ends with `Mach-O files: N`.

- [ ] **Step 4: Wire it into the workflow**

In `preflight`, after the Version step, add (the Windows and updater names are appended in Tasks 7 and 11):

```yaml
      - name: Check required secrets (signed runs)
        if: env.SIGNED == 'true'
        env:
          MAC_CERT_P12_BASE64: ${{ secrets.MAC_CERT_P12_BASE64 }}
          MAC_CERT_PASSWORD: ${{ secrets.MAC_CERT_PASSWORD }}
          MAC_CI_KEYCHAIN_PASSWORD: ${{ secrets.MAC_CI_KEYCHAIN_PASSWORD }}
          MAC_SIGN_IDENTITY: ${{ secrets.MAC_SIGN_IDENTITY }}
          MAC_NOTARY_APPLE_ID: ${{ secrets.MAC_NOTARY_APPLE_ID }}
          MAC_NOTARY_PASSWORD: ${{ secrets.MAC_NOTARY_PASSWORD }}
          MAC_NOTARY_TEAM_ID: ${{ secrets.MAC_NOTARY_TEAM_ID }}
        run: |
          missing=()
          for n in MAC_CERT_P12_BASE64 MAC_CERT_PASSWORD MAC_CI_KEYCHAIN_PASSWORD MAC_SIGN_IDENTITY \
                   MAC_NOTARY_APPLE_ID MAC_NOTARY_PASSWORD MAC_NOTARY_TEAM_ID; do
            [ -z "${!n}" ] && missing+=("$n")
          done
          if [ ${#missing[@]} -gt 0 ]; then
            echo "::error::Missing required secrets: ${missing[*]} (see docs/how-to/desktop-release.md)"
            exit 1
          fi
```

Name the step exactly `Check required secrets (signed runs)` (the test slices from `Check required secrets`).

In `bundle`, add `KEYCHAIN_NAME: desktop-release-ci.keychain-db` to the job `env`, and insert before `Build bundles`:

```yaml
      - name: Import the Developer ID certificate into an ephemeral keychain
        if: runner.os == 'macOS' && env.SIGNED == 'true'
        env:
          CERT_P12_BASE64: ${{ secrets.MAC_CERT_P12_BASE64 }}
          CERT_PASSWORD: ${{ secrets.MAC_CERT_PASSWORD }}
          KEYCHAIN_PASSWORD: ${{ secrets.MAC_CI_KEYCHAIN_PASSWORD }}
        run: |
          security create-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN_NAME"
          security set-keychain-settings -lut 3600 "$KEYCHAIN_NAME"
          security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN_NAME"
          p12="$RUNNER_TEMP/cert.p12"
          echo "$CERT_P12_BASE64" | base64 --decode > "$p12"
          security import "$p12" -k "$KEYCHAIN_NAME" -P "$CERT_PASSWORD" -T /usr/bin/codesign -T /usr/bin/security
          security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$KEYCHAIN_PASSWORD" "$KEYCHAIN_NAME"
          security list-keychains -d user -s "$KEYCHAIN_NAME" $(security list-keychains -d user | tr -d '"')
          rm -f "$p12"
      - name: Sign the core's nested binaries (Developer ID, hardened runtime)
        if: runner.os == 'macOS' && env.SIGNED == 'true'
        env:
          IDENTITY: ${{ secrets.MAC_SIGN_IDENTITY }}
        run: |
          desktop/release/macos-sign-nested.sh desktop/resources/core "$IDENTITY"
          # The hardened-runtime node must still run the core (JIT entitlement check).
          node desktop/scripts/check-core-deps.mjs
          node desktop/scripts/smoke-core.mjs
```

Extend the `Build bundles` step `env` with (Tauri signs and notarizes the app only when these are non-empty; in an unsigned run they are empty and the build stays ad-hoc):

```yaml
          APPLE_SIGNING_IDENTITY: ${{ env.SIGNED == 'true' && runner.os == 'macOS' && secrets.MAC_SIGN_IDENTITY || '' }}
          APPLE_ID: ${{ env.SIGNED == 'true' && runner.os == 'macOS' && secrets.MAC_NOTARY_APPLE_ID || '' }}
          APPLE_PASSWORD: ${{ env.SIGNED == 'true' && runner.os == 'macOS' && secrets.MAC_NOTARY_PASSWORD || '' }}
          APPLE_TEAM_ID: ${{ env.SIGNED == 'true' && runner.os == 'macOS' && secrets.MAC_NOTARY_TEAM_ID || '' }}
```

After `Build bundles`, insert:

```yaml
      - name: Sign, notarize and staple the dmg; Gatekeeper check
        if: runner.os == 'macOS' && env.SIGNED == 'true'
        env:
          IDENTITY: ${{ secrets.MAC_SIGN_IDENTITY }}
          NOTARY_APPLE_ID: ${{ secrets.MAC_NOTARY_APPLE_ID }}
          NOTARY_PASSWORD: ${{ secrets.MAC_NOTARY_PASSWORD }}
          NOTARY_TEAM_ID: ${{ secrets.MAC_NOTARY_TEAM_ID }}
        run: |
          app="$BUNDLE/macos/LLM-IDE.app"
          codesign --verify --deep --strict --verbose=2 "$app"
          spctl -a -vvv -t exec "$app"
          dmg=$(ls "$BUNDLE"/dmg/*.dmg | head -n1)
          codesign --force --timestamp --sign "$IDENTITY" "$dmg"
          xcrun notarytool submit "$dmg" --apple-id "$NOTARY_APPLE_ID" --password "$NOTARY_PASSWORD" --team-id "$NOTARY_TEAM_ID" --wait
          xcrun stapler staple "$dmg"
          xcrun stapler validate "$dmg"
          spctl -a -vvv -t open --context context:primary-signature "$dmg"
      - name: Clean up the ephemeral keychain
        if: always() && runner.os == 'macOS'
        run: security delete-keychain "$KEYCHAIN_NAME" || true
```

The existing macOS smoke step then runs against the signed, hardened app: that is the real entitlement test.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd desktop && node --test scripts/desktop-release-workflow.test.mjs`
Expected: PASS.

- [ ] **Step 6: Commit; signed dry run once the secrets exist (UN-071)**

```bash
git add desktop/release/node-entitlements.plist desktop/release/macos-sign-nested.sh .github/workflows/desktop-release.yml desktop/scripts/desktop-release-workflow.test.mjs
git commit -m "ci(desktop): sign and notarize the macOS bundle with the Mac app's Developer ID"
```

With the secrets set: `gh workflow run desktop-release.yml -f signed=true`. Expected for both macOS jobs: notarization `status: Accepted`, `spctl` `accepted source=Notarized Developer ID`, signed smoke `OK` x3. If the signed smoke fails with a V8 `CodeRange` / executable-memory error, add `com.apple.security.cs.allow-unsigned-executable-memory` to the plist with a comment and re-run. (Until Task 7 lands, Windows and Linux jobs in a `signed=true` run build unsigned; that is expected.)

---

### Task 7: Windows Authenticode signing (Azure Artifact Signing default)

Tauri runs `bundle.windows.signCommand` on the app exe and on the NSIS installer. The command comes from a generated `--config` overlay, so `tauri.conf.json` and local builds never carry it. Default provider: Azure Artifact Signing (formerly Trusted Signing) with Microsoft's own dlib and the Windows SDK `signtool`. Unsigned PE files inside the core (`better_sqlite3.node`, any vendored `.exe`) are signed with the same command first; the official `node.exe` keeps its OpenJS Foundation signature.

**Files:**
- Create: `desktop/scripts/release-config.mjs`, `desktop/scripts/release-config.test.mjs`
- Modify: `.github/workflows/desktop-release.yml`, `desktop/scripts/desktop-release-workflow.test.mjs`

**Interfaces:**
- Consumes: secrets `DESKTOP_WIN_AZURE_CLIENT_ID`, `DESKTOP_WIN_AZURE_CLIENT_SECRET`, `DESKTOP_WIN_AZURE_TENANT_ID`, `DESKTOP_WIN_SIGN_ENDPOINT`, `DESKTOP_WIN_SIGN_ACCOUNT`, `DESKTOP_WIN_SIGN_PROFILE`.
- Produces: `releaseConfig({ windowsSign?: { signtool, dlib, metadata }, updater?: { pubkey } }) -> object` (a Tauri config merge patch); `windowsSignArgs({ dlib, metadata }) -> string[]` (args without the file); CLI `node desktop/scripts/release-config.mjs [--windows-sign] [--updater <pubkeyFile>] > overlay.json` reading `WIN_SIGNTOOL`, `WIN_DLIB`, `WIN_METADATA` from the environment. Task 11 adds the `updater` part.

- [ ] **Step 1: Write the failing test**

```js
// desktop/scripts/release-config.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { releaseConfig, windowsSignArgs } from './release-config.mjs';

const W = { signtool: 'C:\\sdk\\x64\\signtool.exe', dlib: 'C:\\as\\bin\\x64\\Azure.CodeSigning.Dlib.dll', metadata: 'C:\\t\\metadata.json' };

test('empty overlay when nothing is asked', () => {
  assert.deepEqual(releaseConfig({}), {});
});

test('windows signCommand: object form, SHA-256, Microsoft timestamp, dlib + metadata, %1 last', () => {
  const c = releaseConfig({ windowsSign: W });
  const sc = c.bundle.windows.signCommand;
  assert.equal(sc.cmd, W.signtool);
  assert.deepEqual(sc.args, ['sign', ...windowsSignArgs(W), '%1']);
  assert.deepEqual(windowsSignArgs(W), ['/v', '/fd', 'SHA256', '/tr', 'http://timestamp.acs.microsoft.com', '/td', 'SHA256', '/dlib', W.dlib, '/dmdf', W.metadata]);
});

test('missing windows inputs throw instead of producing an unsigned config', () => {
  assert.throws(() => releaseConfig({ windowsSign: { ...W, dlib: '' } }), /dlib/);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd desktop && node --test scripts/release-config.test.mjs`
Expected: FAIL, module not found.

- [ ] **Step 3: Write the implementation**

```js
// desktop/scripts/release-config.mjs
// Generates the release-only Tauri config overlay passed as `tauri build --config <file>` (a JSON merge patch on
// tauri.conf.json). Local and dry-run builds never get it: no sign command, no updater, no updater artifacts.
//   WIN_SIGNTOOL=... WIN_DLIB=... WIN_METADATA=... node scripts/release-config.mjs --windows-sign > overlay.json
import { resolve } from 'node:path';

export const windowsSignArgs = ({ dlib, metadata }) =>
  ['/v', '/fd', 'SHA256', '/tr', 'http://timestamp.acs.microsoft.com', '/td', 'SHA256', '/dlib', dlib, '/dmdf', metadata];

export function releaseConfig({ windowsSign, updater } = {}) {
  const c = {};
  if (windowsSign) {
    for (const k of ['signtool', 'dlib', 'metadata']) if (!windowsSign[k]) throw new Error(`windows signing: ${k} is empty`);
    c.bundle = { ...(c.bundle ?? {}), windows: { signCommand: { cmd: windowsSign.signtool, args: ['sign', ...windowsSignArgs(windowsSign), '%1'] } } };
  }
  return c;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const a = process.argv.slice(2);
  const windowsSign = a.includes('--windows-sign') ? { signtool: process.env.WIN_SIGNTOOL, dlib: process.env.WIN_DLIB, metadata: process.env.WIN_METADATA } : undefined;
  process.stdout.write(JSON.stringify(releaseConfig({ windowsSign }), null, 2) + '\n');
}
```

(`updater` is accepted and ignored here; Task 11 implements it.)

- [ ] **Step 4: Run it to verify it passes**

Run: `cd desktop && node --test scripts/release-config.test.mjs`
Expected: PASS.

- [ ] **Step 5: Add failing workflow asserts**

```js
const WIN_SECRETS = ['DESKTOP_WIN_AZURE_CLIENT_ID', 'DESKTOP_WIN_AZURE_CLIENT_SECRET', 'DESKTOP_WIN_AZURE_TENANT_ID', 'DESKTOP_WIN_SIGN_ENDPOINT', 'DESKTOP_WIN_SIGN_ACCOUNT', 'DESKTOP_WIN_SIGN_PROFILE'];

test('a signed run checks every Windows signing secret', () => {
  const wf = rel();
  const check = wf.slice(wf.indexOf('Check required secrets'), wf.indexOf('bundle:'));
  for (const s of WIN_SECRETS) assert.match(check, new RegExp(`\\b${s}\\b`));
});

test('Windows: pinned Artifact Signing client, overlay passed to tauri build, signatures verified', () => {
  const wf = rel();
  assert.match(wf, /Microsoft\.ArtifactSigning\.Client -Version \$env:AS_CLIENT_VERSION/);
  assert.match(wf, /AS_CLIENT_VERSION: '\d+\.\d+\.\d+/);
  assert.match(wf, /flags="--windows-sign"/);
  assert.match(wf, /release-config\.mjs \$flags/);
  assert.match(wf, /--config \\?"\$RUNNER_TEMP\/release\.conf\.json/);
  assert.match(wf, /Get-AuthenticodeSignature/);
});
```

Run: `cd desktop && node --test scripts/desktop-release-workflow.test.mjs`
Expected: FAIL on the two new tests.

- [ ] **Step 6: Wire it into the workflow**

Pin the client: open https://www.nuget.org/packages/Microsoft.ArtifactSigning.Client, take the newest version released at least two weeks ago, and write it as `AS_CLIENT_VERSION` in the `bundle` job `env` (for example `AS_CLIENT_VERSION: '1.0.115'` if that is the one; the test requires a literal X.Y.Z).

Extend the preflight secret step: add the six `DESKTOP_WIN_*` names to its `env:` block (each `${{ secrets.NAME }}`) and to the `for n in ...` list.

Insert in `bundle` before `Build bundles`:

```yaml
      - name: Prepare Windows signing (Artifact Signing dlib, signtool, overlay)
        if: runner.os == 'Windows' && env.SIGNED == 'true'
        shell: pwsh
        env:
          SIGN_ENDPOINT: ${{ secrets.DESKTOP_WIN_SIGN_ENDPOINT }}
          SIGN_ACCOUNT: ${{ secrets.DESKTOP_WIN_SIGN_ACCOUNT }}
          SIGN_PROFILE: ${{ secrets.DESKTOP_WIN_SIGN_PROFILE }}
        run: |
          $as = Join-Path $env:RUNNER_TEMP 'artifact-signing'
          nuget install Microsoft.ArtifactSigning.Client -Version $env:AS_CLIENT_VERSION -x -OutputDirectory $as
          $dlib = Get-ChildItem -Recurse "$as" -Filter Azure.CodeSigning.Dlib.dll | Where-Object { $_.FullName -match '\\x64\\' } | Select-Object -First 1
          $signtool = Get-ChildItem 'C:\Program Files (x86)\Windows Kits\10\bin\*\x64\signtool.exe' | Sort-Object FullName | Select-Object -Last 1
          $meta = Join-Path $env:RUNNER_TEMP 'metadata.json'
          @{ Endpoint = $env:SIGN_ENDPOINT; CodeSigningAccountName = $env:SIGN_ACCOUNT; CertificateProfileName = $env:SIGN_PROFILE; ExcludeCredentials = @('ManagedIdentityCredential') } | ConvertTo-Json | Set-Content $meta
          "WIN_SIGNTOOL=$($signtool.FullName)" >> $env:GITHUB_ENV
          "WIN_DLIB=$($dlib.FullName)" >> $env:GITHUB_ENV
          "WIN_METADATA=$meta" >> $env:GITHUB_ENV
      - name: Write the release config overlay
        if: env.SIGNED == 'true'
        run: |
          flags=""
          [ "$RUNNER_OS" = "Windows" ] && flags="--windows-sign"
          node desktop/scripts/release-config.mjs $flags > "$RUNNER_TEMP/release.conf.json"
          cat "$RUNNER_TEMP/release.conf.json"
      - name: Sign unsigned PE files inside the core (Windows)
        if: runner.os == 'Windows' && env.SIGNED == 'true'
        shell: pwsh
        env:
          AZURE_CLIENT_ID: ${{ secrets.DESKTOP_WIN_AZURE_CLIENT_ID }}
          AZURE_CLIENT_SECRET: ${{ secrets.DESKTOP_WIN_AZURE_CLIENT_SECRET }}
          AZURE_TENANT_ID: ${{ secrets.DESKTOP_WIN_AZURE_TENANT_ID }}
        run: |
          Get-ChildItem -Recurse desktop/resources/core -Include *.exe,*.dll,*.node | ForEach-Object {
            if ((Get-AuthenticodeSignature $_.FullName).Status -ne 'Valid') {
              & $env:WIN_SIGNTOOL sign /v /fd SHA256 /tr http://timestamp.acs.microsoft.com /td SHA256 /dlib $env:WIN_DLIB /dmdf $env:WIN_METADATA $_.FullName
              if ($LASTEXITCODE -ne 0) { exit 1 }
            }
          }
```

Change the `Build bundles` step to pass the overlay in signed runs and give `signtool` its credentials:

```yaml
      - name: Build bundles
        working-directory: desktop
        env:
          LLMIDE_OMIT_SOURCE_ROOT: '1'
          AZURE_CLIENT_ID: ${{ env.SIGNED == 'true' && runner.os == 'Windows' && secrets.DESKTOP_WIN_AZURE_CLIENT_ID || '' }}
          AZURE_CLIENT_SECRET: ${{ env.SIGNED == 'true' && runner.os == 'Windows' && secrets.DESKTOP_WIN_AZURE_CLIENT_SECRET || '' }}
          AZURE_TENANT_ID: ${{ env.SIGNED == 'true' && runner.os == 'Windows' && secrets.DESKTOP_WIN_AZURE_TENANT_ID || '' }}
          # (keep the four APPLE_* lines from Task 6 here)
        run: |
          cfg=""
          [ "$SIGNED" = "true" ] && cfg="--config \"$RUNNER_TEMP/release.conf.json\""
          eval npm run tauri build -- --bundles ${{ matrix.bundles }} $cfg
```

After `Build bundles`, before the Windows smoke step:

```yaml
      - name: Verify Authenticode signatures (Windows)
        if: runner.os == 'Windows' && env.SIGNED == 'true'
        shell: pwsh
        run: |
          $files = @(Get-ChildItem "$env:BUNDLE/nsis/*-setup.exe") + @(Get-ChildItem desktop/src-tauri/target/release/*.exe)
          foreach ($f in $files) {
            $s = Get-AuthenticodeSignature $f.FullName
            Write-Host "$($f.Name): $($s.Status) $($s.SignerCertificate.Subject)"
            if ($s.Status -ne 'Valid') { exit 1 }
          }
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd desktop && node --test scripts/desktop-release-workflow.test.mjs scripts/release-config.test.mjs`
Expected: PASS.

- [ ] **Step 8: Commit; signed dry run once the account exists (UN-072)**

```bash
git add desktop/scripts/release-config.mjs desktop/scripts/release-config.test.mjs .github/workflows/desktop-release.yml desktop/scripts/desktop-release-workflow.test.mjs
git commit -m "ci(desktop): sign the Windows app and installer with Azure Artifact Signing"
```

With the secrets: `gh workflow run desktop-release.yml -f signed=true`. Expected: the verify step prints `Valid` with the publisher subject for the setup exe and the app exe; the install/smoke/uninstall step stays green. If the user chose an OV/EV certificate in a cloud HSM instead (decision D1), only `Prepare Windows signing` and `windowsSignArgs` change (to that vendor's signtool/KSP arguments); the overlay mechanism stays.

---

### Task 8: Linux package checks and the tray runtime dependency

> Starts only after the relay work in `desktop/src-tauri` is committed (edits `tauri.conf.json`).

The tray needs `libayatana-appindicator3` at runtime (PACKAGING.md "Project open, tray and notifications"). Declare it on the deb explicitly instead of relying on the bundler, and check the deb and AppImage contents in CI.

**Files:**
- Create: `desktop/scripts/verify-linux-bundle.mjs`, `desktop/scripts/verify-linux-bundle.test.mjs`
- Modify: `desktop/src-tauri/tauri.conf.json` (`bundle.linux`)
- Modify: `.github/workflows/desktop-release.yml` (one Linux step)

**Interfaces:**
- Consumes: `verifyNoSdkBinary(dir)` from `desktop/scripts/sdk-binary.mjs`, `verifyStagedCore(dir)` from `desktop/scripts/stage-filter.mjs` (both return `string[]` problems).
- Produces: `REQUIRED_DEPENDS = ['libwebkit2gtk-4.1-0', 'libgtk-3-0', 'libayatana-appindicator3-1']`; `missingDepends(field: string) -> string[]`; `listingProblems(paths: string[]) -> string[]`; CLI `node desktop/scripts/verify-linux-bundle.mjs <deb> <AppImage>`.

- [ ] **Step 1: Write the failing test**

```js
// desktop/scripts/verify-linux-bundle.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { missingDepends, listingProblems } from './verify-linux-bundle.mjs';

test('Depends must name webkit, gtk and the appindicator runtime (alternatives and versions allowed)', () => {
  assert.deepEqual(missingDepends('libwebkit2gtk-4.1-0, libgtk-3-0 (>= 3.24), libayatana-appindicator3-1 | libappindicator3-1'), []);
  assert.deepEqual(missingDepends('libwebkit2gtk-4.1-0, libgtk-3-0'), ['libayatana-appindicator3-1']);
  assert.deepEqual(missingDepends(''), ['libwebkit2gtk-4.1-0', 'libgtk-3-0', 'libayatana-appindicator3-1']);
});

test('deb listing: core node and server present, no SDK platform package', () => {
  const ok = ['./usr/bin/llmide-desktop-poc', './usr/lib/LLM-IDE/core/node/node', './usr/lib/LLM-IDE/core/root/extension/server.mjs'];
  assert.deepEqual(listingProblems(ok), []);
  assert.match(listingProblems(ok.slice(0, 2)).join(), /server\.mjs/);
  assert.match(listingProblems([...ok, './usr/lib/LLM-IDE/core/root/extension/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude']).join(), /claude/);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd desktop && node --test scripts/verify-linux-bundle.test.mjs`
Expected: FAIL, module not found.

- [ ] **Step 3: Write the implementation**

```js
// desktop/scripts/verify-linux-bundle.mjs
// Checks the Linux bundles without installing them: the deb's Depends (incl. the tray's appindicator runtime),
// the deb's contents, and the AppImage's extracted core (staged-tree verifier + no SDK claude binary).
//   node scripts/verify-linux-bundle.mjs <file.deb> <file.AppImage>
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { verifyNoSdkBinary } from './sdk-binary.mjs';
import { verifyStagedCore } from './stage-filter.mjs';

export const REQUIRED_DEPENDS = ['libwebkit2gtk-4.1-0', 'libgtk-3-0', 'libayatana-appindicator3-1'];

export function missingDepends(field) {
  const names = field.split(',').flatMap((d) => d.split('|')).map((d) => d.trim().split(/[\s(]/)[0]).filter(Boolean);
  return REQUIRED_DEPENDS.filter((r) => !names.includes(r));
}

export function listingProblems(paths) {
  const p = [];
  if (!paths.some((x) => x.endsWith('/core/node/node'))) p.push('deb has no core/node/node');
  if (!paths.some((x) => x.endsWith('/core/root/extension/server.mjs'))) p.push('deb has no core/root/extension/server.mjs');
  for (const x of paths) if (/@anthropic-ai\/claude-agent-sdk-linux/.test(x) || /\/claude$/.test(x)) p.push(`deb ships an SDK claude binary: ${x}`);
  return p;
}

function findCore(dir) {
  for (const n of readdirSync(dir, { withFileTypes: true })) {
    if (!n.isDirectory()) continue;
    const p = join(dir, n.name);
    if (n.name === 'core' && readdirSync(p).includes('node')) return p;
    const f = findCore(p);
    if (f) return f;
  }
  return null;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const [deb, appimage] = process.argv.slice(2).map((x) => resolve(x));
  const p = [];
  p.push(...missingDepends(execFileSync('dpkg-deb', ['-f', deb, 'Depends'], { encoding: 'utf8' })).map((d) => `deb Depends lacks ${d}`));
  const listing = execFileSync('dpkg-deb', ['-c', deb], { encoding: 'utf8' }).split('\n').map((l) => l.trim().split(/\s+/).pop()).filter(Boolean);
  p.push(...listingProblems(listing));
  const tmp = mkdtempSync(join(tmpdir(), 'appimage-'));
  execFileSync(appimage, ['--appimage-extract'], { cwd: tmp, stdio: 'ignore' });
  const core = findCore(join(tmp, 'squashfs-root'));
  if (!core) p.push('AppImage has no core/ folder');
  else p.push(...verifyNoSdkBinary(core), ...verifyStagedCore(core).map((x) => `AppImage staged-tree verifier: ${x}`));
  if (p.length) { for (const x of p) console.error(`::error::${x}`); process.exit(1); }
  console.log('Linux bundles OK');
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd desktop && node --test scripts/verify-linux-bundle.test.mjs`
Expected: PASS.

- [ ] **Step 5: Declare the runtime dependency and wire the check**

In `desktop/src-tauri/tauri.conf.json`, inside `"bundle"` next to `"macOS"`, add:

```json
    "linux": {
      "deb": {
        "depends": ["libayatana-appindicator3-1"]
      }
    },
```

In `.github/workflows/desktop-release.yml`, before `Smoke-test the packaged app (Linux AppImage)`:

```yaml
      - name: Verify the Linux bundles
        if: runner.os == 'Linux'
        run: node desktop/scripts/verify-linux-bundle.mjs "$(ls "$BUNDLE"/deb/*.deb | head -n1)" "$(ls "$BUNDLE"/appimage/*.AppImage | head -n1)"
```

Run: `cd desktop && npm test && npm run check:security` (unchanged gates still pass; `tauri.conf.json` is valid JSON for `tauri-build`). Then `cd desktop/src-tauri && cargo check --locked` (the conf is parsed at build time).

- [ ] **Step 6: Commit**

```bash
git add desktop/scripts/verify-linux-bundle.mjs desktop/scripts/verify-linux-bundle.test.mjs desktop/src-tauri/tauri.conf.json .github/workflows/desktop-release.yml
git commit -m "feat(desktop): declare the tray runtime dependency and verify the Linux bundles"
```

---

### Task 9: Host updater (Rust): config gate, status, check, install

> Starts only after the relay work in `desktop/src-tauri` is committed (edits `Cargo.toml`, `Cargo.lock`, `lib.rs`, `build.rs`, `capabilities/default.json`).

The plugin is used from Rust only; the webview gets three narrow host commands, never the plugin's own JS permissions. The plugin is registered only when the build carries a valid `plugins.updater` section (the release overlay, Task 11), so local and dry-run builds have no updater and Settings says so. The update is downloaded (and its signature verified by the plugin) **before** the core is stopped; the core is stopped before install so the Windows installer never meets a running `node.exe`.

**Files:**
- Create: `desktop/src-tauri/src/updater.rs`
- Modify: `desktop/src-tauri/Cargo.toml` (one dependency line), `desktop/src-tauri/Cargo.lock` (by cargo), `desktop/src-tauri/src/lib.rs` (module, context, plugin, 3 commands, background start), `desktop/src-tauri/build.rs` (`COMMANDS`), `desktop/src-tauri/capabilities/default.json` (3 grants + description)

**Interfaces:**
- Consumes: `confirm::ask(title, description, accept, warn) -> bool`, `confirm::herr(code, message) -> FsError`, `confirm::sanitize_line(s, max) -> String`, `fs_ops::FsError`, `core_host::CoreHost::{shutdown, start}`, `pty::kill_all()`, `prefs::stored().update_checks` (Task 10 adds the field; until then use `true` — see Step 6).
- Produces: `pub const CHANNEL_URL: &str = "https://github.com/dnsmalla/llm-ide/releases/download/desktop-stable/latest.json"`; `pub fn config_problem(cfg: Option<&serde_json::Value>) -> Option<&'static str>` (`None` = valid; codes `no_update_config`, `no_update_key`, `bad_update_endpoint`); `pub enum InstallKind { SelfUpdate, PackageManaged }`; `pub fn install_kind(os: &str, appimage: Option<&str>) -> InstallKind`; `pub fn notes_text(body: Option<&str>) -> String` (≤ 2000 chars, control chars removed); `#[derive(Serialize)] #[serde(rename_all = "camelCase")] pub struct UpdateStatus { configured: bool, reason: Option<&'static str>, install_kind: &'static str /* "self" | "package" */, available: Option<AvailableUpdate>, last_checked_ms: Option<u64>, error: Option<String> }`; `pub struct AvailableUpdate { version: String, notes: String }` (camelCase); commands `update_status() -> UpdateStatus`, `update_check(app) -> Result<UpdateStatus, FsError>`, `update_install(app, host) -> Result<bool, FsError>`; `pub fn start_background(app: tauri::AppHandle)`.

- [ ] **Step 1: Add the dependency**

Pick the newest `tauri-plugin-updater` 2.x release that is at least two weeks old and resolves with `tauri =2.11.6`:

Run: `cd desktop/src-tauri && cargo add tauri-plugin-updater@2 --dry-run 2>&1 | head -5` and check its date on crates.io. Then add to `[dependencies]` in `Cargo.toml`, after `tauri-plugin-notification`, the exact pin with a comment:

```toml
# Signed auto-update (Ed25519/minisign, verified against the key in the release overlay); used from Rust only,
# the webview gets update_status/update_check/update_install and no plugin permission. See updater.rs.
tauri-plugin-updater = "=<the version chosen above>"
```

Run: `cargo check --locked` → fails (lock outdated), then `cargo check` (updates `Cargo.lock` with only the plugin and its new transitive crates) → OK. Review `git diff --stat Cargo.lock`: only additions for the updater tree.

- [ ] **Step 2: Write the failing unit tests**

Create `desktop/src-tauri/src/updater.rs` with the tests module first:

```rust
//! Signed auto-update. The plugin is registered only when the build carries a valid `plugins.updater` section
//! (the release overlay written by desktop/scripts/release-config.mjs); local builds report `no_update_config`.
//! Flow: check (network, on request or once a day when the pref is on) -> the user presses Install -> native
//! Cancel-first confirm -> download (the plugin verifies the signature against the embedded key) -> stop the core
//! and terminals -> install -> restart. A .deb install is package-managed and never self-updates.

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const KEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEFCQ0QKUldTMTIzNDU2Nzg5MAo=";

    #[test]
    fn config_is_valid_only_with_a_key_and_exactly_the_channel_url() {
        assert_eq!(config_problem(None), Some("no_update_config"));
        assert_eq!(config_problem(Some(&json!({"endpoints": [CHANNEL_URL]}))), Some("no_update_key"));
        assert_eq!(config_problem(Some(&json!({"pubkey": "  ", "endpoints": [CHANNEL_URL]}))), Some("no_update_key"));
        assert_eq!(config_problem(Some(&json!({"pubkey": KEY, "endpoints": ["http://github.com/x"]}))), Some("bad_update_endpoint"));
        assert_eq!(config_problem(Some(&json!({"pubkey": KEY, "endpoints": [CHANNEL_URL, "https://evil.example/l.json"]}))), Some("bad_update_endpoint"));
        assert_eq!(config_problem(Some(&json!({"pubkey": KEY, "endpoints": [CHANNEL_URL]}))), None);
    }

    #[test]
    fn linux_without_appimage_is_package_managed() {
        assert_eq!(install_kind("linux", None), InstallKind::PackageManaged);
        assert_eq!(install_kind("linux", Some("")), InstallKind::PackageManaged);
        assert_eq!(install_kind("linux", Some("/home/u/LLM-IDE.AppImage")), InstallKind::SelfUpdate);
        assert_eq!(install_kind("macos", None), InstallKind::SelfUpdate);
        assert_eq!(install_kind("windows", None), InstallKind::SelfUpdate);
    }

    #[test]
    fn notes_are_capped_and_stripped() {
        assert_eq!(notes_text(None), "");
        assert_eq!(notes_text(Some("a\u{0007}b\nc")), "ab\nc");
        assert_eq!(notes_text(Some(&"x".repeat(5000))).chars().count(), NOTES_MAX);
    }

    #[test]
    fn status_without_config_says_why_and_is_never_available() {
        let s = status_from(Some("no_update_config"), InstallKind::SelfUpdate, None, None, None);
        assert!(!s.configured);
        assert_eq!(s.reason, Some("no_update_config"));
        assert!(s.available.is_none());
        assert_eq!(s.install_kind, "self");
    }
}
```

- [ ] **Step 3: Run them to verify they fail**

Add `mod updater;` next to the other `mod` lines at the top of `src/lib.rs`, then:
Run: `cd desktop/src-tauri && cargo test --lib updater::`
Expected: FAIL to compile (`config_problem` etc. not found).

- [ ] **Step 4: Write the pure part**

Above the tests module in `updater.rs`:

```rust
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;

use crate::confirm::{self, herr};
use crate::fs_ops::FsError;

/// The one allowed endpoint: a fixed channel release that desktop-promote.yml updates. Keep in step with
/// desktop/scripts/release-config.mjs (a drift test there reads this line).
pub const CHANNEL_URL: &str = "https://github.com/dnsmalla/llm-ide/releases/download/desktop-stable/latest.json";
pub const NOTES_MAX: usize = 2000;
const FIRST_CHECK_DELAY: Duration = Duration::from_secs(60);
const CHECK_EVERY: Duration = Duration::from_secs(24 * 60 * 60);
const MANUAL_GAP_MS: u64 = 30_000;

/// None = valid. A missing section must read as a problem (never use `cfg?`, which would return None = valid).
pub fn config_problem(cfg: Option<&serde_json::Value>) -> Option<&'static str> {
    let Some(c) = cfg.and_then(|v| v.as_object()) else { return Some("no_update_config") };
    if c.get("pubkey").and_then(|v| v.as_str()).map_or(true, |k| k.trim().len() < 40) {
        return Some("no_update_key");
    }
    match c.get("endpoints").and_then(|v| v.as_array()) {
        Some(a) if a.len() == 1 && a[0].as_str() == Some(CHANNEL_URL) => None,
        _ => Some("bad_update_endpoint"),
    }
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum InstallKind { SelfUpdate, PackageManaged }

pub fn install_kind(os: &str, appimage: Option<&str>) -> InstallKind {
    if os == "linux" && appimage.map_or(true, |p| p.trim().is_empty()) { InstallKind::PackageManaged } else { InstallKind::SelfUpdate }
}

pub fn notes_text(body: Option<&str>) -> String {
    body.unwrap_or("").chars().filter(|c| *c == '\n' || !c.is_control()).take(NOTES_MAX).collect()
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AvailableUpdate { pub version: String, pub notes: String }

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub configured: bool,
    pub reason: Option<&'static str>,
    pub install_kind: &'static str,
    pub available: Option<AvailableUpdate>,
    pub last_checked_ms: Option<u64>,
    pub error: Option<String>,
}

pub(crate) fn status_from(reason: Option<&'static str>, kind: InstallKind, available: Option<AvailableUpdate>, last: Option<u64>, error: Option<String>) -> UpdateStatus {
    UpdateStatus {
        configured: reason.is_none(),
        reason,
        install_kind: if kind == InstallKind::SelfUpdate { "self" } else { "package" },
        available: if reason.is_none() { available } else { None },
        last_checked_ms: last,
        error,
    }
}
```

Run: `cargo test --lib updater::`
Expected: PASS (4 tests).

- [ ] **Step 5: Write the runtime part (state, commands, background)**

Append to `updater.rs` (above the tests):

```rust
use tauri_plugin_updater::{Update, UpdaterExt};

#[derive(Default)]
struct Inner {
    reason: Option<&'static str>,
    pending: Option<Update>,
    last_checked_ms: Option<u64>,
    error: Option<String>,
    checking: bool,
}
static STATE: Mutex<Option<Inner>> = Mutex::new(None);

fn with<R>(f: impl FnOnce(&mut Inner) -> R) -> R {
    let mut g = STATE.lock().unwrap_or_else(|e| e.into_inner());
    f(g.get_or_insert_with(|| Inner { reason: Some("no_update_config"), ..Default::default() }))
}

fn kind() -> InstallKind { install_kind(std::env::consts::OS, std::env::var("APPIMAGE").ok().as_deref()) }

/// Called once from `run()` with the result of `config_problem` on the build's config.
pub fn init(reason: Option<&'static str>) { with(|s| s.reason = reason); }

fn snapshot() -> UpdateStatus {
    with(|s| status_from(
        s.reason, kind(),
        s.pending.as_ref().map(|u| AvailableUpdate { version: u.version.clone(), notes: notes_text(u.body.as_deref()) }),
        s.last_checked_ms, s.error.clone(),
    ))
}

async fn check_now(app: &tauri::AppHandle) -> Result<UpdateStatus, FsError> {
    if let Some(r) = with(|s| s.reason) { return Err(herr(r, "This build has no update channel.")); }
    let busy = with(|s| {
        let now = confirm::now_ms();
        let too_soon = s.last_checked_ms.is_some_and(|t| now.saturating_sub(t) < MANUAL_GAP_MS);
        if s.checking || too_soon { true } else { s.checking = true; false }
    });
    if busy { return Ok(snapshot()); }
    let result = match app.updater() {
        Ok(u) => u.check().await.map_err(|e| e.to_string()),
        Err(e) => Err(e.to_string()),
    };
    with(|s| {
        s.checking = false;
        s.last_checked_ms = Some(confirm::now_ms());
        match result {
            Ok(found) => { s.pending = found; s.error = None; }
            Err(e) => s.error = Some(confirm::sanitize_line(&e, 200)),
        }
    });
    Ok(snapshot())
}

#[tauri::command]
pub fn update_status() -> UpdateStatus { snapshot() }

#[tauri::command]
pub async fn update_check(app: tauri::AppHandle) -> Result<UpdateStatus, FsError> { check_now(&app).await }

/// Ok(false) = the user cancelled. Never returns Ok(true): a successful install restarts the app.
#[tauri::command]
pub async fn update_install(app: tauri::AppHandle, host: tauri::State<'_, crate::core_host::CoreHost>) -> Result<bool, FsError> {
    if let Some(r) = with(|s| s.reason) { return Err(herr(r, "This build has no update channel.")); }
    if kind() == InstallKind::PackageManaged {
        return Err(herr("package_managed", "This copy was installed from a package. Update it with your package manager."));
    }
    let update = with(|s| s.pending.clone()).ok_or_else(|| herr("no_update", "Check for updates first."))?;
    let text = format!("Install LLM-IDE {}?\n\nThe app downloads the update, checks its signature, closes, installs it and opens again. Unsaved terminal output is lost.", confirm::sanitize_line(&update.version, 40));
    let ok = tauri::async_runtime::spawn_blocking(move || confirm::ask("Install update", &text, "Install and Restart", false)).await.unwrap_or(false);
    if !ok { return Ok(false); }
    // The plugin verifies the signature here; nothing is stopped until a verified payload is on disk.
    let bytes = update.download(|_, _| {}, || {}).await.map_err(|e| herr("download_failed", confirm::sanitize_line(&e.to_string(), 200)))?;
    host.shutdown();
    crate::pty::kill_all();
    if let Err(e) = update.install(bytes) {
        let _ = host.start();
        return Err(herr("install_failed", confirm::sanitize_line(&e.to_string(), 200)));
    }
    app.restart();
}

/// Once a minute after launch, then daily, while the pref is on. Check only: never installs.
pub fn start_background(app: tauri::AppHandle) {
    if with(|s| s.reason).is_some() { return; }
    std::thread::spawn(move || {
        std::thread::sleep(FIRST_CHECK_DELAY);
        loop {
            if crate::prefs::stored().update_checks {
                let _ = tauri::async_runtime::block_on(check_now(&app));
            }
            std::thread::sleep(CHECK_EVERY);
        }
    });
}
```

If `Update` is not `Clone` in the chosen plugin version, keep `pending` as `Option<Update>` and `take()` it in `update_install` (put it back on a cancelled dialog). If `confirm::now_ms` / `sanitize_line` are not `pub(crate)` at use time, they are today (confirm.rs lines 25 and 132).

- [ ] **Step 6: Register it (lib.rs, build.rs, capability)**

In `src/lib.rs` `run()`:
1. Before `let app = tauri::Builder::default()`, add:
```rust
    let context = tauri::generate_context!();
    let update_problem = updater::config_problem(context.config().plugins.0.get("updater"));
    updater::init(update_problem);
```
2. Change `.build(tauri::generate_context!())` to `.build(context)`.
3. Register the plugin only when valid. Split the builder chain right after `.plugin(tauri_plugin_notification::init())`:
```rust
    let builder = /* the existing chain up to and including */ .plugin(tauri_plugin_notification::init());
    let builder = if update_problem.is_none() { builder.plugin(tauri_plugin_updater::Builder::new().build()) } else { builder };
    let app = builder /* the rest of the existing chain: .setup(...) ... */ .build(context)
```
4. Add `updater::update_status, updater::update_check, updater::update_install,` to the always-on command list next to `prefs::get_prefs`.
5. In `.setup(move |app| { ... })`, after the core is started, add `updater::start_background(app.handle().clone());`.

Until Task 10 lands, `prefs::stored().update_checks` does not exist: land Task 9 and Task 10's Rust part in the same commit, or temporarily read `true` in `start_background` and replace it in Task 10 Step 3. Prefer the former: do Task 10 Steps 1 to 4 before committing Task 9.

In `build.rs` `COMMANDS`, add after `"set_prefs"`: `"update_status", "update_check", "update_install",`.

In `capabilities/default.json` `permissions`, add `"allow-update-status", "allow-update-check", "allow-update-install"`, and append to its `description`: `, update_status/update_check/update_install (host-run signed updater; no updater plugin permission)`.

- [ ] **Step 7: Verify**

Run:
```bash
cd desktop/src-tauri && cargo test --locked --lib && cargo check --locked --all-targets
cd .. && npm run check:security && npm run check:security:product
```
Expected: all pass; `check-capabilities` accepts the three new grants (each command has exactly one `allow-*`) and reports no `updater:` plugin permission. A local `npm run tauri dev` shows no updater registered (`update_status` returns `configured: false, reason: "no_update_config"`).

- [ ] **Step 8: Commit**

```bash
git add desktop/src-tauri/Cargo.toml desktop/src-tauri/Cargo.lock desktop/src-tauri/src/updater.rs desktop/src-tauri/src/lib.rs desktop/src-tauri/build.rs desktop/src-tauri/capabilities/default.json desktop/src-tauri/permissions
git commit -m "feat(desktop): host-run signed updater behind a release-only config gate"
```

---

### Task 10: "Check for updates" pref and the Updates & About settings group

> Starts only after the relay work in `desktop/src-tauri` is committed (edits `prefs.rs`).

Adds the opt-out switch to the existing Mac-mirrored group `updates` ("Updates & About", `ui/screens/settings/groups.ts:33`, rendered by `sections/UpdatesSection.tsx`). The switch applies at once (the background loop reads the stored pref), so it is excluded from `restart_needed`. "Check now" works even with the switch off (an explicit user action).

**Files:**
- Modify: `desktop/src-tauri/src/prefs.rs`
- Modify: `ui/screens/shell/host-prefs.ts`, `ui/screens/shell/settings-adapter.ts`, `ui/screens/shell/tests/host-prefs.test.mjs`
- Modify: `ui/screens/settings/host.ts`, `ui/screens/settings/sections/UpdatesSection.tsx`, `ui/screens/settings/notices.ts`
- Create: `ui/screens/settings/updates-model.ts`, `ui/screens/settings/tests/updates-model.test.ts`

**Interfaces:**
- Consumes: Task 9 commands `update_status`, `update_check`, `update_install` and `UpdateStatus` JSON (`configured`, `reason`, `installKind`, `available {version, notes}`, `lastCheckedMs`, `error`).
- Produces: Rust `Prefs.update_checks: bool` (JSON `updateChecks`, default `true`), `PrefsPatch.update_checks: Option<bool>`; TS `HostPrefs.updateChecks: boolean`; `SettingsHost.getUpdateChecks?(): Promise<boolean>`, `setUpdateChecks?(on: boolean): Promise<boolean>`, `updateStatus?(): Promise<UpdateStatusView>`, `checkForUpdate?(): Promise<UpdateStatusView>`, `installUpdate?(): Promise<boolean>`; `decodeUpdateStatus(raw: unknown): UpdateStatusView | null`, `updateSummary(s: UpdateStatusView | null): string`.

- [ ] **Step 1: Write the failing Rust test**

Add to the `tests` module in `prefs.rs`:

```rust
    #[test]
    fn update_checks_default_on_patchable_and_never_need_a_restart() {
        assert!(Prefs::default().update_checks);
        let off = Prefs::default().patched(&PrefsPatch { update_checks: Some(false), ..Default::default() });
        assert!(!off.update_checks);
        assert!(!parse(&serde_json::to_string(&off).unwrap()).update_checks);
        // An old file without the key keeps the default.
        assert!(parse(r#"{"ltaMode":"off"}"#).update_checks);
    }
```

Run: `cd desktop/src-tauri && cargo test --lib prefs::`
Expected: FAIL to compile (`update_checks` unknown).

- [ ] **Step 2: Implement in `prefs.rs`**

- `Prefs`: add after `graph_auto_update_minutes`:
```rust
    /// Look for a signed update once a day (check only; installing always asks). Applies at once.
    pub update_checks: bool,
```
- `Default for Prefs`: add `update_checks: true,`.
- `PrefsPatch`: add `pub update_checks: Option<bool>,`.
- `patched`: add `if let Some(v) = p.update_checks { n.update_checks = v; }`.
- `parse`: add `update_checks: Some(p.update_checks),` to the `PrefsPatch` literal.
- `view`: add `update_checks: launch.update_checks,` to the `Prefs { theme: ..., ..stored.clone() }` literal so it never sets `restart_needed`.
- Every other `PrefsPatch { ... }` literal in the crate that lists all fields (grep `PrefsPatch {` in `src/`) gets `update_checks: None` or uses `..Default::default()`.

Run: `cargo test --lib prefs::`
Expected: PASS. Then `cargo test --locked --lib` (all).

- [ ] **Step 3: Write the failing TS model test**

```ts
// ui/screens/settings/tests/updates-model.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeUpdateStatus, updateSummary } from "../updates-model.ts";

const base = { configured: true, reason: null, installKind: "self", available: null, lastCheckedMs: null, error: null };

test("decode rejects junk and keeps only known fields", () => {
  assert.equal(decodeUpdateStatus(null), null);
  assert.equal(decodeUpdateStatus({ configured: "yes" }), null);
  const s = decodeUpdateStatus({ ...base, available: { version: "0.3.0", notes: "x".repeat(5000) }, extra: 1 });
  assert.equal(s?.available?.version, "0.3.0");
  assert.equal(s?.available?.notes.length, 2000);
  assert.equal("extra" in (s as object), false);
});

test("summary text for each state", () => {
  assert.match(updateSummary(decodeUpdateStatus({ ...base, configured: false, reason: "no_update_config" })), /no update channel/i);
  assert.match(updateSummary(decodeUpdateStatus({ ...base, installKind: "package" })), /package manager/i);
  assert.match(updateSummary(decodeUpdateStatus(base)), /not checked yet/i);
  assert.match(updateSummary(decodeUpdateStatus({ ...base, lastCheckedMs: 1 })), /up to date/i);
  assert.match(updateSummary(decodeUpdateStatus({ ...base, lastCheckedMs: 1, available: { version: "0.3.0", notes: "" } })), /0\.3\.0 is available/);
  assert.match(updateSummary(decodeUpdateStatus({ ...base, error: "offline" })), /could not check/i);
  assert.match(updateSummary(null), /reading/i);
});
```

Run: `cd desktop && node --test --experimental-strip-types ../ui/screens/settings/tests/updates-model.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 4: Implement the model**

```ts
// ui/screens/settings/updates-model.ts
// The host updater's status (desktop/src-tauri/src/updater.rs UpdateStatus), decoded defensively, and its one-line text.
export interface UpdateStatusView {
  configured: boolean;
  reason: string | null;
  installKind: "self" | "package";
  available: { version: string; notes: string } | null;
  lastCheckedMs: number | null;
  error: string | null;
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : null);

export function decodeUpdateStatus(raw: unknown): UpdateStatusView | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.configured !== "boolean") return null;
  const a = r.available as Record<string, unknown> | null | undefined;
  const version = a ? str(a.version, 40) : null;
  return {
    configured: r.configured,
    reason: str(r.reason, 40),
    installKind: r.installKind === "package" ? "package" : "self",
    available: version ? { version, notes: str(a!.notes, 2000) ?? "" } : null,
    lastCheckedMs: typeof r.lastCheckedMs === "number" && Number.isFinite(r.lastCheckedMs) ? r.lastCheckedMs : null,
    error: str(r.error, 200),
  };
}

export function updateSummary(s: UpdateStatusView | null): string {
  if (!s) return "Reading the update status...";
  if (!s.configured) return "This build has no update channel (a local or test build). Release builds update themselves.";
  if (s.installKind === "package") return "Installed from a package: update LLM-IDE with your package manager.";
  if (s.error) return `Could not check for updates: ${s.error}`;
  if (s.available) return `LLM-IDE ${s.available.version} is available.`;
  if (s.lastCheckedMs === null) return "Not checked yet.";
  return `Up to date (checked ${new Date(s.lastCheckedMs).toLocaleString()}).`;
}
```

Run the test again. Expected: PASS.

- [ ] **Step 5: Plumb host prefs and the host commands**

- `ui/screens/shell/host-prefs.ts`: add `updateChecks: boolean;` to `HostPrefs` (after `graphAutoUpdateMinutes`, with the comment `/** Daily signed-update check; applies at once. */`); in `decodePrefs` add `const updateChecks = raw.updateChecks !== false;` and include `updateChecks` in the returned object.
- `ui/screens/shell/tests/host-prefs.test.mjs`: add `updateChecks: true` to the `P` fixture, and a test:
```js
test("updateChecks decodes, defaults on for older files, and is written through set_prefs", async () => {
  assert.equal(m.decodePrefs({ ...P, updateChecks: false }).updateChecks, false);
  const { updateChecks, ...old } = P;
  assert.equal(m.decodePrefs(old).updateChecks, true);
});
```
- `ui/screens/settings/host.ts` `SettingsHost`, after `setGraphAutoUpdate?`:
```ts
  /** Daily signed-update check (host pref, applies at once). */
  getUpdateChecks?(): Promise<boolean>;
  setUpdateChecks?(on: boolean): Promise<boolean>;
  /** The host updater: cached status, a network check, and install (native confirm, then restart). */
  updateStatus?(): Promise<UpdateStatusView>;
  checkForUpdate?(): Promise<UpdateStatusView>;
  /** false = the user cancelled the native dialog. */
  installUpdate?(): Promise<boolean>;
```
with `import type { UpdateStatusView } from "./updates-model.ts";` at the top.
- `ui/screens/shell/settings-adapter.ts`, next to `getGraphAutoUpdate`:
```ts
        getUpdateChecks: async () => (await readPrefs()).stored.updateChecks,
        setUpdateChecks: async (updateChecks) => (await writePrefs({ updateChecks })).stored.updateChecks,
        updateStatus: async () => mustDecode(decodeUpdateStatus(await d.invoke<unknown>("update_status"))),
        checkForUpdate: async () => mustDecode(decodeUpdateStatus(await d.invoke<unknown>("update_check"))),
        installUpdate: async () => (await d.invoke<unknown>("update_install")) === true,
```
with `import { decodeUpdateStatus, type UpdateStatusView } from "../settings/updates-model";` and a local `const mustDecode = (v: UpdateStatusView | null): UpdateStatusView => { if (!v) throw new Error("bad update status from host"); return v; };`. Match the import path style already used in that file for `../settings/...` modules.

- [ ] **Step 6: Render the group**

Replace `ui/screens/settings/sections/UpdatesSection.tsx`:

```tsx
import { useEffect, useState } from "react";
import AboutSection from "./AboutSection.tsx";
import { PartialNote } from "./NoticeSections.tsx";
import { useEnv } from "../context.tsx";
import { Switch, ErrorText } from "../ui.tsx";
import { updateSummary, type UpdateStatusView } from "../updates-model.ts";

/** The Mac's "Updates & About" group: the signed-update switch, Check now and Install, then version and diagnostics. */
export default function UpdatesSection() {
  const { host } = useEnv();
  const [on, setOn] = useState<boolean | null>(null);
  const [status, setStatus] = useState<UpdateStatusView | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    host.getUpdateChecks?.().then((v) => { if (live) setOn(v); }, () => {});
    host.updateStatus?.().then((s) => { if (live) setStatus(s); }, () => {});
    return () => { live = false; };
  }, [host]);
  const run = async (f: () => Promise<void>) => {
    setBusy(true); setErr(null);
    try { await f(); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  const usable = status?.configured === true && status.installKind === "self";
  return (
    <div className="st-stack">
      {host.updateStatus ? (
        <div className="st-stack">
          <p className="st-hint" role="status">{updateSummary(status)}</p>
          {host.getUpdateChecks && host.setUpdateChecks && on !== null && status?.configured ? (
            <Switch label="Check for updates automatically" hint="Once a day. Only signed LLM-IDE releases are offered, and installing always asks first."
              checked={on} onChange={(v) => void run(async () => { setOn(await host.setUpdateChecks!(v)); })} />
          ) : null}
          {usable ? (
            <div className="st-row">
              <button type="button" disabled={busy} onClick={() => void run(async () => setStatus(await host.checkForUpdate!()))}>Check Now</button>
              {status?.available ? (
                <button type="button" disabled={busy} onClick={() => void run(async () => { await host.installUpdate!(); })}>Install {status.available.version} and Restart</button>
              ) : null}
            </div>
          ) : null}
          {status?.available?.notes ? <pre className="st-hint">{status.available.notes}</pre> : null}
          {err ? <ErrorText text={err} /> : null}
        </div>
      ) : null}
      <AboutSection />
      <PartialNote id="updates" />
    </div>
  );
}
```

Use the exact export names of `Switch` and `ErrorText` from the module `GeneralSection.tsx` imports them from (check its import lines; adjust the import path if they live elsewhere). Notes render as plain text in a `<pre>`, never as HTML.

In `ui/screens/settings/notices.ts`, replace the `updates:` text with:
`"Updates come from signed LLM-IDE releases only: the host checks once a day when the switch is on and never installs without asking. A local or test build has no update channel. A .deb install is updated by the package manager, not here."`

- [ ] **Step 7: Verify**

Run:
```bash
cd desktop && npm test && npx tsc --noEmit && npm run check:security
cd src-tauri && cargo test --locked --lib
```
Expected: all pass (the Settings drift test `groups.test.ts` is unaffected: no group changed). `AccountSection.tsx` is untouched (`git diff --stat` shows no change to it).

- [ ] **Step 8: Commit**

```bash
git add desktop/src-tauri/src/prefs.rs ui/screens/shell/host-prefs.ts ui/screens/shell/settings-adapter.ts ui/screens/shell/tests/host-prefs.test.mjs ui/screens/settings/host.ts ui/screens/settings/updates-model.ts ui/screens/settings/tests/updates-model.test.ts ui/screens/settings/sections/UpdatesSection.tsx ui/screens/settings/notices.ts
git commit -m "feat(settings): add the signed-update switch, Check Now and Install"
```

---

### Task 11: Tag-driven signed release, update manifest, draft release, promote workflow

**Files:**
- Modify: `desktop/scripts/release-config.mjs`, `desktop/scripts/release-config.test.mjs` (updater part + drift test)
- Modify: `.github/workflows/desktop-release.yml` (tag trigger, updater secrets, overlay for every OS, manifest, attestations, draft release)
- Create: `.github/workflows/desktop-promote.yml`
- Modify: `desktop/scripts/desktop-release-workflow.test.mjs`
- (User creates) `desktop/release/updater.pubkey` — UN-112, Task 13

**Interfaces:**
- Consumes: `CHANNEL_URL` (Task 9, `updater.rs`), `update-manifest.mjs` (Task 3), secrets `DESKTOP_UPDATER_PRIVATE_KEY`, `DESKTOP_UPDATER_KEY_PASSWORD`.
- Produces: `releaseConfig({ updater: { pubkey } })` adds `bundle.createUpdaterArtifacts: true` and `plugins.updater: { pubkey, endpoints: [CHANNEL_URL], windows: { installMode: "passive" } }`; exported `CHANNEL_URL` in `release-config.mjs` equal to the Rust constant; the channel release tag `desktop-stable`.

- [ ] **Step 1: Write the failing config tests**

Append to `desktop/scripts/release-config.test.mjs`:

```js
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CHANNEL_URL } from './release-config.mjs';

const KEY = 'dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEFCQ0QKUldTMTIzNDU2Nzg5MAo=';

test('updater overlay: artifacts on, one https channel endpoint, passive Windows install', () => {
  const c = releaseConfig({ updater: { pubkey: KEY } });
  assert.equal(c.bundle.createUpdaterArtifacts, true);
  assert.deepEqual(c.plugins.updater, { pubkey: KEY, endpoints: [CHANNEL_URL], windows: { installMode: 'passive' } });
});

test('windows signing and updater merge into one bundle object', () => {
  const c = releaseConfig({ windowsSign: { signtool: 's', dlib: 'd', metadata: 'm' }, updater: { pubkey: KEY } });
  assert.ok(c.bundle.windows.signCommand);
  assert.equal(c.bundle.createUpdaterArtifacts, true);
});

test('an empty or short pubkey throws', () => {
  assert.throws(() => releaseConfig({ updater: { pubkey: ' ' } }), /pubkey/);
});

test('CHANNEL_URL matches the Rust host constant', () => {
  const rs = readFileSync(join(import.meta.dirname, '..', 'src-tauri', 'src', 'updater.rs'), 'utf8');
  assert.ok(rs.includes(`pub const CHANNEL_URL: &str = "${CHANNEL_URL}";`));
});
```

Run: `cd desktop && node --test scripts/release-config.test.mjs`
Expected: FAIL (no `CHANNEL_URL` export, no updater part).

- [ ] **Step 2: Implement the updater part**

In `release-config.mjs` add:

```js
import { readFileSync } from 'node:fs';
export const CHANNEL_URL = 'https://github.com/dnsmalla/llm-ide/releases/download/desktop-stable/latest.json';
```

and in `releaseConfig`, after the Windows block:

```js
  if (updater) {
    if (!updater.pubkey || updater.pubkey.trim().length < 40) throw new Error('updater: pubkey is empty or short');
    c.bundle = { ...(c.bundle ?? {}), createUpdaterArtifacts: true };
    c.plugins = { updater: { pubkey: updater.pubkey.trim(), endpoints: [CHANNEL_URL], windows: { installMode: 'passive' } } };
  }
```

and in the CLI block:

```js
  const i = a.indexOf('--updater');
  const updater = i >= 0 ? { pubkey: readFileSync(a[i + 1], 'utf8') } : undefined;
  process.stdout.write(JSON.stringify(releaseConfig({ windowsSign, updater }), null, 2) + '\n');
```

Run the tests. Expected: PASS.

- [ ] **Step 3: Write the failing workflow asserts**

```js
const prom = () => readFileSync(join(WF, 'desktop-promote.yml'), 'utf8');

test('tag trigger is desktop-vX.Y.Z only', () => {
  assert.match(rel(), /tags:\s*\n\s+- 'desktop-v\[0-9\]\+\.\[0-9\]\+\.\[0-9\]\+'/);
});

test('signed runs need the updater key, the committed pubkey, and verify every sig before latest.json', () => {
  const wf = rel();
  const check = wf.slice(wf.indexOf('Check required secrets'), wf.indexOf('bundle:'));
  for (const s of ['DESKTOP_UPDATER_PRIVATE_KEY', 'DESKTOP_UPDATER_KEY_PASSWORD']) assert.match(check, new RegExp(`\\b${s}\\b`));
  assert.match(check, /desktop\/release\/updater\.pubkey/);
  assert.match(wf, /TAURI_SIGNING_PRIVATE_KEY: \$\{\{/);
  assert.match(wf, /release-config\.mjs \$flags --updater desktop\/release\/updater\.pubkey/);
  assert.match(wf, /update-manifest\.mjs --version/);
});

test('publish: attestations, a DRAFT release that never becomes Latest, write permission only there', () => {
  const wf = rel();
  const pub = wf.slice(wf.indexOf('  publish:'));
  assert.match(pub, /contents: write/);
  assert.match(pub, /id-token: write/);
  assert.match(pub, /attestations: write/);
  assert.match(pub, /actions\/attest-build-provenance@/);
  assert.match(pub, /gh release create .*--draft/);
  assert.match(pub, /--latest=false/);
});

test('promote: manual, refuses drafts and prereleases, re-checks the manifest, clobbers desktop-stable', () => {
  const wf = prom();
  assert.match(wf, /workflow_dispatch:/);
  assert.doesNotMatch(wf, /\bpush:/);
  assert.match(wf, /isDraft/);
  assert.match(wf, /update-manifest\.mjs --check/);
  assert.match(wf, /gh release upload desktop-stable .*--clobber/);
});
```

Run: `cd desktop && node --test scripts/desktop-release-workflow.test.mjs`
Expected: FAIL on the four new tests.

- [ ] **Step 4: Extend `desktop-release.yml`**

1. Under `on:`, before `workflow_dispatch:`, add:
```yaml
  push:
    tags:
      - 'desktop-v[0-9]+.[0-9]+.[0-9]+'
```
2. Preflight secret step: add `DESKTOP_UPDATER_PRIVATE_KEY` and `DESKTOP_UPDATER_KEY_PASSWORD` to its `env:` and `for` list, and after the loop:
```bash
          [ -s desktop/release/updater.pubkey ] || missing+=("desktop/release/updater.pubkey (committed public key, UN-112)")
```
(place this line before the `if [ ${#missing[@]} -gt 0 ]` check).
3. `Write the release config overlay` step: change its run line to
```bash
          node desktop/scripts/release-config.mjs $flags --updater desktop/release/updater.pubkey > "$RUNNER_TEMP/release.conf.json"
```
4. `Build bundles` env: add
```yaml
          TAURI_SIGNING_PRIVATE_KEY: ${{ env.SIGNED == 'true' && secrets.DESKTOP_UPDATER_PRIVATE_KEY || '' }}
          TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ env.SIGNED == 'true' && secrets.DESKTOP_UPDATER_KEY_PASSWORD || '' }}
```
5. Replace the `publish` job with:
```yaml
  publish:
    name: Manifest, checksums, SBOM, provenance, draft release
    needs: [preflight, bundle]
    runs-on: ubuntu-latest
    permissions:
      contents: write
      id-token: write
      attestations: write
    env:
      VERSION: ${{ needs.preflight.outputs.version }}
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v6
        with:
          node-version: 22
      - uses: actions/download-artifact@v7
        with:
          pattern: llmide-desktop-*
          path: dist
          merge-multiple: true
      - name: SBOM of the shipped Node core and the desktop frontend (CycloneDX)
        run: |
          npm ci --prefix extension --omit dev --ignore-scripts
          npm sbom --prefix extension --omit dev --sbom-format cyclonedx > "dist/LLM-IDE_${VERSION}_core.cdx.json"
          npm sbom --prefix desktop --omit dev --sbom-format cyclonedx > "dist/LLM-IDE_${VERSION}_frontend.cdx.json"
      - name: Update manifest (every signature verified) and SHA256SUMS
        if: env.SIGNED == 'true'
        run: |
          awk "/^## \\[desktop-${VERSION}\\]/{f=1;next}/^## /{f=0}f" CHANGELOG.md > "$RUNNER_TEMP/notes.md"
          node desktop/scripts/update-manifest.mjs --version "$VERSION" --pubkey desktop/release/updater.pubkey --notes "$RUNNER_TEMP/notes.md" dist
      - name: SHA256SUMS (dry run)
        if: env.SIGNED != 'true'
        run: (cd dist && sha256sum $(ls | grep -v '\.sig$' | sort) > SHA256SUMS)
      - name: Build provenance attestations
        if: startsWith(github.ref, 'refs/tags/desktop-v')
        uses: actions/attest-build-provenance@v2
        with:
          subject-path: 'dist/*'
      - name: Create the DRAFT GitHub Release
        if: startsWith(github.ref, 'refs/tags/desktop-v')
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          gh release create "$GITHUB_REF_NAME" --draft --latest=false \
            --title "LLM-IDE Desktop $VERSION" --notes-file "$RUNNER_TEMP/notes.md" dist/*
      - uses: actions/upload-artifact@v7
        with:
          name: llmide-desktop-release-${{ needs.preflight.outputs.version }}
          path: dist/
          retention-days: 7
```
Use the newest major of `actions/attest-build-provenance` listed in its README at implementation time (v2 when this plan was written).

- [ ] **Step 5: Write `desktop-promote.yml`**

```yaml
name: desktop-promote

# Puts a PUBLISHED desktop release on the update channel: copies its latest.json to the fixed release
# `desktop-stable`, the only endpoint installed apps read (desktop/src-tauri/src/updater.rs CHANNEL_URL).
# Run it after you published the draft and finished the real-run checklist (docs/how-to/desktop-release.md).
# Stop a bad release: re-run with the previous good tag (installed apps only move forward; ship a fix as N+1).

on:
  workflow_dispatch:
    inputs:
      tag:
        description: 'Published release tag, e.g. desktop-v0.2.0'
        required: true

permissions:
  contents: write

jobs:
  promote:
    runs-on: ubuntu-latest
    env:
      GH_TOKEN: ${{ github.token }}
      TAG: ${{ inputs.tag }}
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v6
        with:
          node-version: 22
      - name: Refuse a bad tag, a draft or a prerelease
        run: |
          [[ "$TAG" =~ ^desktop-v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "::error::$TAG is not desktop-vX.Y.Z"; exit 1; }
          state=$(gh release view "$TAG" --json isDraft,isPrerelease -q '"\(.isDraft) \(.isPrerelease)"')
          [ "$state" = "false false" ] || { echo "::error::$TAG is a draft or a prerelease ($state); publish it first"; exit 1; }
      - name: Fetch and re-check its manifest
        run: |
          gh release download "$TAG" --pattern latest.json --dir "$RUNNER_TEMP"
          node desktop/scripts/update-manifest.mjs --check "$RUNNER_TEMP/latest.json" --version "${TAG#desktop-v}"
      - name: Point desktop-stable at it
        run: |
          gh release view desktop-stable >/dev/null 2>&1 || \
            gh release create desktop-stable --prerelease --latest=false --title "LLM-IDE Desktop update channel (stable)" \
              --notes "Holds latest.json for the desktop updater. Do not delete. Updated by desktop-promote.yml."
          gh release upload desktop-stable "$RUNNER_TEMP/latest.json" --clobber
          echo "desktop-stable now serves $TAG"
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd desktop && node --test scripts/desktop-release-workflow.test.mjs scripts/release-config.test.mjs`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add desktop/scripts/release-config.mjs desktop/scripts/release-config.test.mjs .github/workflows/desktop-release.yml .github/workflows/desktop-promote.yml desktop/scripts/desktop-release-workflow.test.mjs
git commit -m "ci(desktop): tag-driven signed release with update manifest and a promote step"
```

First real run happens in the user's checklist (Task 13): tag `desktop-v0.1.0` → draft → checklist → publish → promote; then `desktop-v0.1.1` to test the N-1 → N update.

---

### Task 12: Opt-in autobench job (UN-009 helper)

GitHub runners have no GPU, so a runner's graph fps does not satisfy UN-009 (a real Windows machine does); the job is still useful for sidecar start/quit timings and as the exact build recipe for the user's machine.

**Files:**
- Create: `.github/workflows/desktop-autobench.yml`
- Modify: `desktop/scripts/desktop-release-workflow.test.mjs`

**Interfaces:**
- Consumes: the `spike` cargo feature and `LLMIDE_POC_AUTOBENCH=all` (`desktop/src-tauri/src/lib.rs:155-166`, Phase 0 report "Raw data": the app prints `BENCH` lines).

- [ ] **Step 1: Write the failing assert**

```js
test('autobench: manual only, spike feature never in the release workflow', () => {
  const ab = readFileSync(join(WF, 'desktop-autobench.yml'), 'utf8');
  assert.match(ab, /workflow_dispatch:/);
  assert.doesNotMatch(ab, /\bpush:|pull_request:/);
  assert.match(ab, /--features spike/);
  assert.match(ab, /LLMIDE_POC_AUTOBENCH: all/);
  assert.doesNotMatch(rel(), /--features spike/);
});
```

Run: `cd desktop && node --test scripts/desktop-release-workflow.test.mjs`
Expected: FAIL (file missing).

- [ ] **Step 2: Write the workflow**

```yaml
name: desktop-autobench

# Opt-in Phase 0 autobench (UN-009 helper). Builds a SPIKE build (bench commands compiled in; never a release),
# runs LLMIDE_POC_AUTOBENCH=all and keeps the BENCH lines. Runner numbers are indicative only: no GPU, so the
# graph fps gate (>= 30) still needs your Windows machine. Same commands work locally (docs/how-to/desktop-release.md).

on:
  workflow_dispatch:
    inputs:
      os:
        type: choice
        options: [windows-latest, ubuntu-latest, macos-latest]
        default: windows-latest

permissions:
  contents: read

jobs:
  autobench:
    runs-on: ${{ inputs.os }}
    timeout-minutes: 60
    defaults:
      run:
        shell: bash
    steps:
      - uses: actions/checkout@v7
      - run: git submodule update --init mac/LocalPackages/graph-kit
      - uses: actions/setup-node@v6
        with:
          node-version: 22
      - name: Linux system dependencies
        if: runner.os == 'Linux'
        run: |
          sudo apt-get update
          sudo apt-get install -y --no-install-recommends build-essential pkg-config file xvfb \
            libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev libayatana-appindicator3-dev librsvg2-dev libssl-dev libxdo-dev
      - run: rustup toolchain install stable --profile minimal && rustup default stable
      - run: |
          for d in desktop extension ui/kit web mac/LocalPackages/graph-kit/web; do npm ci --prefix "$d"; done
      - name: Stage the core and build the frontend
        env:
          LLMIDE_STAGE_RELEASE: '1'
        run: |
          node desktop/scripts/stage-core.mjs
          npm run build --prefix desktop
      - name: Build the spike binary
        working-directory: desktop/src-tauri
        run: cargo build --release --locked --features spike
      - name: Run the autobench
        env:
          LLMIDE_POC_AUTOBENCH: all
          LLMIDE_POC_BUNDLED: '1'
          LLMIDE_KEYCHAIN_BACKEND: memory
        run: |
          exe=desktop/src-tauri/target/release/llmide-desktop-poc
          [ "$RUNNER_OS" = "Windows" ] && exe="$exe.exe"
          run="$exe"; [ "$RUNNER_OS" = "Linux" ] && run="xvfb-run -a $exe"
          timeout 1500 $run 2>&1 | tee autobench.log || true
          grep '^BENCH' autobench.log > bench.txt || { echo "::error::no BENCH lines"; exit 1; }
          cat bench.txt
      - uses: actions/upload-artifact@v7
        with:
          name: autobench-${{ inputs.os }}
          path: |
            bench.txt
            autobench.log
          retention-days: 30
```

If `LLMIDE_POC_BUNDLED=1` does not make a non-`.app` binary use `desktop/resources/core` on that OS (check `core_host::resolve_runtime`), drop it: a repo-checkout run starts the core from `extension/` with the runner's node, which is fine for a bench.

- [ ] **Step 3: Run the test to verify it passes**

Run: `cd desktop && node --test scripts/desktop-release-workflow.test.mjs`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/desktop-autobench.yml desktop/scripts/desktop-release-workflow.test.mjs
git commit -m "ci(desktop): add an opt-in autobench workflow"
```

---

### Task 13: Release how-to, real-run checklist, decisions doc and tracking

**Files:**
- Create: `docs/how-to/desktop-release.md`
- Modify: `docs/how-to/desktop-signing-decisions.md`, `docs/how-to/release.md` (new "4. Desktop app" section linking to the how-to), `desktop/PACKAGING.md` (sizes and smoke timings from the Task 5 dry run; "Release" pointer), `CHANGELOG.md` (an `## [desktop-0.1.0]` section template is created at first release, see the how-to), `docs/superpowers/MASTER-PLAN.md` (S2 signing line, S10 three lines), `docs/superpowers/USER-NEEDS.md` (UN-071, UN-072 how/links; new UN-111, UN-112, UN-113)

- [ ] **Step 1: Write `docs/how-to/desktop-release.md`**

Sections and content (write them out in full; this is the user's runbook):

1. **What ships** — table: target → files (canonical names from Task 2) → signed by → updates through. macOS arm64/x64: dmg + app.tar.gz, Developer ID + notarized + stapled, updater. Windows x64: `-setup.exe` (NSIS, per-user, no admin), Artifact Signing, updater (passive installer). Linux x64: AppImage (updater) and deb (package manager; Depends include `libayatana-appindicator3-1`). Every release also has `SHA256SUMS`, two CycloneDX SBOMs, `latest.json`, and GitHub provenance attestations (verify with `gh attestation verify <file> --repo dnsmalla/llm-ide`).
2. **One-time setup** — the secrets table (name → what → where it comes from): the seven `MAC_*` (shared with `mac-release.yml`), the six `DESKTOP_WIN_*`, `DESKTOP_UPDATER_PRIVATE_KEY`, `DESKTOP_UPDATER_KEY_PASSWORD`; the updater key: `cd desktop && npx tauri signer generate -w ~/.llmide-desktop-updater.key` (choose a password), commit the `.pub` content as `desktop/release/updater.pubkey`, put the private key file content and password in the two secrets, keep two offline copies (password manager + an encrypted USB stick); losing it means installed apps can never update again.
3. **Dry runs** — `gh workflow run desktop-release.yml` (unsigned) and `-f signed=true` (signed, never published).
4. **Cut a release** — bump `desktop/src-tauri/tauri.conf.json` `version` and `desktop/src-tauri/Cargo.toml` `version` to X.Y.Z, then `cd desktop/src-tauri && cargo update -p llmide-desktop-poc --offline` (refreshes the lock's root entry), add `## [desktop-X.Y.Z] — YYYY-MM-DD` to `CHANGELOG.md` (the publish job uses it as notes), commit `chore(release): desktop-vX.Y.Z`, `git tag desktop-vX.Y.Z && git push origin desktop-vX.Y.Z`. CI produces a **draft** release.
5. **Check, publish, promote** — run the real-run checklist below on the draft's files; publish the draft in the GitHub UI; `gh workflow run desktop-promote.yml -f tag=desktop-vX.Y.Z`. Only then do installed apps see it.
6. **Stop or roll back** — re-run promote with the previous good tag: no further installs of the bad version. Apps that already updated stay on it until N+1 (the updater never downgrades); ship the fix as N+1. Opt-out for a user: Settings → Updates & About → switch off.
7. **Real-run checklist (per OS: macOS arm64, macOS x64 if available, Windows 11 x64, Ubuntu 24.04 x64)** — a checkbox list, each with the expected result:
   - Download from the draft; `sha256sum -c SHA256SUMS --ignore-missing` (Windows: `Get-FileHash`) matches.
   - Install: macOS open dmg, drag to Applications, first open shows no Gatekeeper warning; Windows run setup, SmartScreen shows the publisher name (a "More info / Run anyway" prompt is expected until reputation builds), installs without admin; Linux `sudo apt install ./LLM-IDE_*.deb` pulls the appindicator package; AppImage `chmod +x` and run.
   - First run: welcome screen, sign up on the local core, status bar shows the core healthy, Settings → Server & Backend shows the bundled core (not `:3456`), Settings → Updates & About says "Not checked yet" or "Up to date".
   - Project open: open a scratch folder, Explorer lists files, open and save one file, Search finds a word.
   - Chat: a one-line question gets an answer (needs `claude login` done once in a terminal; with no `claude` installed the error says to install Claude Code); Bypass asks in a native dialog.
   - Terminal: open the dock, run `echo hi` (macOS/Linux) or `echo hi` in the Windows shell; resize the window; close the tab.
   - Tray: icon present (GNOME needs the AppIndicator extension; absent tray is acceptable there), Show and Quit work.
   - Quit: from the tray or the app menu; no `node` process left (`ps aux | grep core/node`, Windows Task Manager).
   - Update N-1 → N: install the previous published version, promote N, Settings → Check Now shows N, Install asks, app restarts on N, chats and projects still there. Also once: switch off "Check for updates automatically", relaunch, confirm no check happens (no "checked" time) until Check Now.
   - Uninstall: macOS drag to Trash; Windows Settings → Apps → Uninstall; Linux `sudo apt remove llm-ide` (check the exact package name with `dpkg -l | grep -i llm`). User data remains: macOS `~/Library/Application Support/llm-ide-desktop`, Windows `%LOCALAPPDATA%\llm-ide-desktop`, Linux `~/.local/share/llm-ide-desktop`; secrets remain in the OS store under `com.llmide.desktop`. Reinstall: the same account and chats are back.
   Record results in USER-NEEDS UN-070 Status with the date and version.
8. **Autobench (UN-009)** — `gh workflow run desktop-autobench.yml -f os=windows-latest` (indicative), and the same steps from the workflow on your Windows machine for the real numbers (graph >= 30 fps, sidecar start/quit, installer size from the release's collect step).

- [ ] **Step 2: Update the decisions doc**

In `docs/how-to/desktop-signing-decisions.md`:
- Top paragraph: the workflow now signs when secrets exist (link `desktop-release.md`); still nothing has run against real certificates until UN-071/UN-072 are done.
- Decision 2: rename to Azure Artifact Signing (formerly Trusted Signing), ~USD 10/month Basic, eligibility (organisations in the USA, Canada, EU, UK with 3+ years of verifiable history; individuals only in the USA and Canada); neither Artifact Signing nor OV gives instant SmartScreen trust (reputation builds over weeks of downloads). Fallback when not eligible: an OV certificate whose key lives in a cloud HSM/signing service that offers a signtool KSP (only `Prepare Windows signing` changes).
- Decision 3: AppImage + deb, rpm and Flatpak deferred (unchanged), the AppImage carries updates, the deb is updated by the package manager.
- Decision 4: GitHub Releases with a fixed `desktop-stable` channel release (not `/releases/latest`, which would pick the newest Mac or extension release in this repo); one key, stable channel only; public key committed at `desktop/release/updater.pubkey`.
- "What you must provide" item 5: replace with "Done: `com.llmide.desktop` and `LLM-IDE` are the production identifier and name (they keep the app separate from the Swift app's `com.llmide.macapp`)."

- [ ] **Step 3: Update tracking**

- MASTER-PLAN S2 signing line (`[~] Signing, notarisation (macOS), Authenticode (Windows), signed updates...`): describe what exists now (pipeline, overlay, updater, promote) and that it waits on UN-071/UN-072/UN-112; keep `(you)`.
- MASTER-PLAN S10: `Tauri release workflow` line → `[~]` with "tag-driven, signed when secrets exist, draft release, smoke on all OSes; first signed run pending"; `Auto-update for Tauri, signed (me)` → `[~]` with "built (updater.rs, release overlay, latest.json verified at publish, desktop-promote.yml); no real N-1 → N run yet"; keep the Windows signing decision line `(you)` and point it to the updated decisions doc.
- USER-NEEDS: UN-071 How → `desktop-release.md` "One-time setup" (note: the existing `MAC_*` secrets are reused, nothing new if they are set); UN-072 How → decisions doc §2 with the eligibility note; add
  - `UN-111` Real-run checklist per OS on the first draft release (Why you: needs the machines and eyes; How: `desktop-release.md` §7; Effort: 45 minutes per OS; Blocks: publishing the first desktop release).
  - `UN-112` Generate the desktop updater key pair, commit the public key, add the two secrets, back up the private key twice offline (How: `desktop-release.md` §2; Effort: 15 minutes; Blocks: any tag release).
  - `UN-113` Decide Windows signing provider by eligibility (Artifact Signing vs OV in a cloud HSM) — or fold into UN-072 if the user prefers one item.
  Then `node scripts/user-needs.mjs --fix` to update the open count.

- [ ] **Step 4: Verify**

Run: `make docs-check` and `node scripts/user-needs.mjs --check`
Expected: both pass (no broken links, count in step).

- [ ] **Step 5: Commit**

```bash
git add docs/how-to/desktop-release.md docs/how-to/desktop-signing-decisions.md docs/how-to/release.md desktop/PACKAGING.md docs/superpowers/MASTER-PLAN.md docs/superpowers/USER-NEEDS.md
git commit -m "docs(desktop): release runbook, real-run checklist and signing decisions update"
```

---

## Decisions for the user (each has a secure, low-cost default; the plan builds the default)

| # | Decision | Default built by this plan |
|---|---|---|
| D1 | Windows signing provider (**superseded by "Release mode"**: Windows unsigned) | Azure Artifact Signing (~USD 10/month) if you are eligible (organisation in US/CA/EU/UK with 3+ years history, or an individual in US/CA); otherwise an OV certificate in a cloud HSM with a signtool KSP. EV is not worth its price now: it no longer buys instant SmartScreen trust. |
| D2 | Linux formats | AppImage (self-updates) + deb (package manager); no rpm, no Flatpak. If the AppImage exceeds the 150 MB budget, ship deb + AppImage anyway with a recorded exception, or deb only. |
| D3 | Update channels | One `stable` channel (`desktop-stable` release), promoted by hand after the checklist; no beta channel. |
| D4 | Production bundle identifier and product name | Keep `com.llmide.desktop` / `LLM-IDE` (already set, distinct from the Swift app). The binary keeps its crate name `llmide-desktop-poc` for now; renaming it (`mainBinaryName`) later changes the Windows exe and Linux binary names and needs a migration note. |
| D5 | arm64 builds | macOS arm64 + x64 yes (already in the matrix); Windows arm64 and Linux arm64 no for now (no node pin, no runner smoke, no demand yet). |
| D6 | Who holds the update private key | You: generated on your Mac, stored as two GitHub secrets for CI, two offline backups (password manager + encrypted USB). The public key is committed so a key change is a reviewed commit. |
| D7 | Notarization credential (**superseded by "Release mode"**: the existing Developer ID and Mac secrets, signed and notarized) | Reuse the Mac app's Apple ID + app-specific password secrets (zero new secrets); move both trains to an App Store Connect API key later. |
| D8 | Automatic update checks | On by default (daily check only, install always asks, signature always verified); a switch in Updates & About turns it off. |

## Release mode (user decisions 2026-11-05)

"I am doing this system for free" and "I already have an Apple Developer ID; Windows signing, no". This overrides D1 and D7 and sets what Tasks 6, 7, 11 and 13 ship by default.

- **macOS: signed and notarized by default.** Task 6 runs on every tag release with the user's existing Developer ID: the `MAC_*` secrets already used by `mac-release.yml` (certificate, identity, notarization Apple ID, app-specific password, team id). No new paid account. The fail-fast secret check applies to the macOS job of every tag release.
- **Windows: unsigned, by decision.** Task 7 is still built but runs only with `windows_signed=true` and its secrets, which the default never sets. The NSIS installer is unsigned; SmartScreen shows "Windows protected your PC" and users choose More info, then Run anyway. No Windows signing cost now or later unless the user changes this decision.
- **Linux: unchanged** (AppImage and deb, normally unsigned); publish the checksums.
- **The updater key stays required, and is free.** Task 3's updater signature check and Task 9's verification are mandatory on every OS: a tag release fails if any updater artifact lacks a valid signature from `desktop/release/updater.pubkey`, and the app never installs an update without one. This keeps auto-update safe on Windows and Linux without paid certificates. D6 (the user holds the key, 2 CI secrets, 2 offline backups) is unchanged.
- **Task 11** publishes the signed and notarized macOS dmg, the unsigned Windows installer and Linux packages, signed updater artifacts, `latest.json`, `SHA256SUMS`, SBOMs and provenance attestations (free on a public repo), as a draft release published by hand.
- **Task 13** adds a short "First launch on Windows" section to the release how-to and release-notes template (More info, Run anyway; how to check `SHA256SUMS`).

## Self-review notes

- Spec coverage: pipeline (Tasks 5, 11), signing macOS/Windows/Linux (6, 7, 8 + attestations/SHA256SUMS in 11), auto-update (3, 9, 10, 11), sidecar per OS + size budget + smoke (2, 4, 5), autobench (12), real-run checklist and decisions (13 + table above).
- Names used across tasks: `CHANNEL_URL` (Tasks 9, 11), `releaseConfig` (7, 11), canonical file names (2 → 3), `UpdateStatus` JSON fields (9 → 10), `update_checks` / `updateChecks` (10 → 9's background loop), job ids `preflight`/`bundle`/`publish` and the step name prefix `Check required secrets` (5, 6, 7, 11 tests).
- Ordering constraint: Tasks 8, 9, 10 edit `desktop/src-tauri` and wait for the relay work; Task 9 and Task 10's Rust part land in one commit (Task 9 Step 6 note). Task 11's drift test reads `updater.rs`, so Task 11 follows Task 9.
