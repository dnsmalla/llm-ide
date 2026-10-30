// Least-privilege gate for Tauri capabilities (Phase 0 report "Security notes").
//   - every command in generate_handler! (src-tauri/src/lib.rs) is declared in the
//     AppManifest COMMANDS list (src-tauri/build.rs) and granted in a capability
//   - no wildcard permission, no `core:default`, no fs/shell/opener/http/dialog/
//     process plugin permission, no `remote` URL scope, only the "main" window
// Usage: node scripts/check-capabilities.mjs   (exit 1 on any problem)
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const FORBIDDEN_PREFIX = /^(fs|shell|opener|http|dialog|process|os|updater|global-shortcut|clipboard-manager):/;
const toKebab = (s) => s.replaceAll('_', '-');

export function check({ libRs, buildRs, capabilities }) {
  const problems = [];
  const handler = libRs.match(/generate_handler!\[([\s\S]*?)\]/)?.[1] ?? '';
  const handled = [...handler.matchAll(/([A-Za-z_][\w:]*)/g)].map((m) => m[1].split('::').pop());
  const manifest = [...(buildRs.match(/COMMANDS[^=]*=\s*&\[([\s\S]*?)\];/)?.[1] ?? '').matchAll(/"([\w]+)"/g)].map((m) => m[1]);
  if (!handled.length) problems.push('no commands found in generate_handler!');
  const granted = new Set();
  for (const [file, cap] of Object.entries(capabilities)) {
    if (cap.remote) problems.push(`${file}: remote URL scope is not allowed`);
    if (cap.local === false) problems.push(`${file}: local must stay true`);
    if (!(cap.windows ?? []).every((w) => w === 'main') || !cap.windows?.length) problems.push(`${file}: windows must be exactly ["main"]`);
    for (const perm of cap.permissions ?? []) {
      if (typeof perm !== 'string') { problems.push(`${file}: scoped/object permission needs review`); continue; }
      if (perm.includes('*')) problems.push(`${file}: wildcard permission ${perm}`);
      if (perm === 'core:default' || /:default$/.test(perm)) problems.push(`${file}: broad default permission ${perm}`);
      if (FORBIDDEN_PREFIX.test(perm)) problems.push(`${file}: forbidden plugin permission ${perm}`);
      granted.add(perm);
    }
  }
  for (const cmd of handled) {
    if (!manifest.includes(cmd)) problems.push(`command ${cmd} is not in build.rs COMMANDS (would be open to every window)`);
    if (!granted.has(`allow-${toKebab(cmd)}`)) problems.push(`command ${cmd} has no allow-${toKebab(cmd)} grant in any capability`);
  }
  for (const cmd of manifest) if (!handled.includes(cmd)) problems.push(`build.rs COMMANDS lists ${cmd}, which is not a registered handler`);
  return problems;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const tauri = resolve(import.meta.dirname, '..', 'src-tauri');
  const capDir = join(tauri, 'capabilities');
  const capabilities = Object.fromEntries(
    readdirSync(capDir).filter((f) => f.endsWith('.json')).map((f) => [f, JSON.parse(readFileSync(join(capDir, f), 'utf8'))]),
  );
  const problems = check({
    libRs: readFileSync(join(tauri, 'src', 'lib.rs'), 'utf8'),
    buildRs: readFileSync(join(tauri, 'build.rs'), 'utf8'),
    capabilities,
  });
  for (const p of problems) console.error(`check-capabilities: ${p}`);
  console.log(problems.length ? 'FAIL' : `ok (${Object.keys(capabilities).length} capability files)`);
  process.exit(problems.length ? 1 : 0);
}
