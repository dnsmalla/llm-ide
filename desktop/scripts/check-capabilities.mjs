// Least-privilege gate for Tauri capabilities (Phase 0 report "Security notes").
//   - every command in generate_handler! (src-tauri/src/lib.rs) is declared in the
//     AppManifest COMMANDS list (src-tauri/build.rs) and granted in a capability
//   - no wildcard permission, no `core:default`, no fs/shell/opener/http/dialog/
//     notification/autostart/process plugin permission, no `remote` URL scope, only the "main" window
//   - `core:` permissions come only from an explicit allowlist; any other permission must be an
//     `allow-<command>` grant for a registered handler
//   - a #[cfg]-gated or otherwise non-plain handler entry fails loudly (the check cannot see which
//     build it is in)
//   - --product additionally fails if capabilities/spike.json exists (spike/bench commands)
// Usage: node scripts/check-capabilities.mjs [--product]   (exit 1 on any problem)
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const FORBIDDEN_PREFIX = /^(fs|shell|opener|http|dialog|process|os|updater|global-shortcut|clipboard-manager|notification|autostart):/;
const toKebab = (s) => s.replaceAll('_', '-');
// The only `core:` permissions the product window may hold.
export const ALLOWED_CORE = new Set([
  'core:window:allow-start-dragging',
  'core:window:allow-toggle-maximize',
  'core:window:allow-internal-toggle-maximize',
]);

/** Text of the `generate_handler![ ... ]` argument list (bracket-balanced), or null. */
function handlerBlock(libRs) {
  const start = libRs.indexOf('generate_handler![');
  if (start < 0) return null;
  let depth = 0;
  for (let i = start + 'generate_handler!'.length; i < libRs.length; i++) {
    if (libRs[i] === '[') depth++;
    else if (libRs[i] === ']' && --depth === 0) return libRs.slice(start + 'generate_handler!['.length, i);
  }
  return null;
}

export function check({ libRs, buildRs, capabilities, product = false }) {
  const problems = [];
  if (product && 'spike.json' in capabilities) problems.push('product build: capabilities/spike.json must not exist (spike/bench commands)');
  const raw = handlerBlock(libRs);
  if (raw === null) problems.push('generate_handler![ ... ] not found or unbalanced');
  if (/#\s*\[/.test(raw ?? '')) problems.push('generate_handler! contains an attribute (#[cfg] ...): a conditionally registered command cannot be verified, refactor it out');
  const handler = (raw ?? '').replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
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
      if (perm.startsWith('core:') && !ALLOWED_CORE.has(perm)) problems.push(`${file}: core permission ${perm} is not in the allowlist`);
      else if (!perm.startsWith('core:') && !perm.startsWith('allow-') && !FORBIDDEN_PREFIX.test(perm)) problems.push(`${file}: unrecognised permission ${perm}`);
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

function main() {
  const product = process.argv.includes('--product');
  const tauri = resolve(import.meta.dirname, '..', 'src-tauri');
  const capDir = join(tauri, 'capabilities');
  const capabilities = Object.fromEntries(
    readdirSync(capDir).filter((f) => f.endsWith('.json')).map((f) => [f, JSON.parse(readFileSync(join(capDir, f), 'utf8'))]),
  );
  const problems = check({
    libRs: readFileSync(join(tauri, 'src', 'lib.rs'), 'utf8'),
    buildRs: readFileSync(join(tauri, 'build.rs'), 'utf8'),
    capabilities,
    product,
  });
  for (const p of problems) console.error(`check-capabilities: ${p}`);
  console.log(problems.length ? 'FAIL' : `ok (${Object.keys(capabilities).length} capability files${product ? ', product' : ''})`);
  process.exit(problems.length ? 1 : 0);
}

// Compare real paths, not URL strings: a path with spaces or non-ASCII characters is
// percent-encoded in import.meta.url, and a symlinked prefix (/var vs /private/var) differs,
// which made the old string comparison false and the whole check silently skip (fail-open).
const isMain = () => {
  try { return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(process.argv[1])); } catch { return false; }
};
if (process.argv[1] && isMain()) main();
