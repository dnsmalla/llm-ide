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

test('the Windows step re-checks the installed core for the SDK binary before smoke-app', () => {
  const wf = rel();
  const i = wf.indexOf('verify-installed-core.mjs');
  assert.ok(i > 0);
  assert.ok(i < wf.indexOf('smoke-app.mjs', wf.indexOf('(Windows)')));
});

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

test('Windows signing is opt-in: unset windows_signed never checks or uses a DESKTOP_WIN_* secret', () => {
  const wf = rel();
  assert.match(wf, /windows_signed:[\s\S]*?default: false/);
  assert.match(wf, /WIN_SIGNED: \$\{\{ inputs\.windows_signed == true \}\}/);
  assert.doesNotMatch(wf, /WIN_SIGNED:.*refs\/tags/);
  // every step that mentions a DESKTOP_WIN_* secret is gated on WIN_SIGNED (the env: expression form is gated inline)
  const steps = wf.split(/\n      - /);
  for (const st of steps.filter((x) => /secrets\.DESKTOP_WIN_/.test(x) && !/name: Build bundles/.test(x))) {
    assert.match(st, /if: (runner\.os == 'Windows' && )?env\.WIN_SIGNED == 'true'/, st.split('\n')[0]);
  }
  const build = steps.find((x) => /name: Build bundles/.test(x));
  for (const s of WIN_SECRETS.slice(0, 3)) assert.match(build, new RegExp(`env\\.WIN_SIGNED == 'true' && runner\\.os == 'Windows' && secrets\\.${s}`));
});

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

test('a tag release never requires or uses a DESKTOP_WIN_* secret and has exactly one SHA256SUMS writer per mode', () => {
  const wf = rel();
  assert.doesNotMatch(wf, /WIN_SIGNED:.*refs\/tags/);
  const pub = wf.slice(wf.indexOf('  publish:'));
  assert.equal((pub.match(/sha256sum /g) ?? []).length, 1);
  assert.match(pub, /name: SHA256SUMS \(unsigned dry run only\)\n\s+if: env\.SIGNED != 'true'/);
});
