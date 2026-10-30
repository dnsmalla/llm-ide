// Bundled-core dependency check (Phase 0 T7). No model call is made.
//
// Imports, with the STAGED node (desktop/resources/core/node/node), the modules the chat
// engine loads lazily from desktop/resources/core/root/extension. Each module is imported
// in its own child process, so one failure cannot hide another. This catches a runtime
// file that stage-core.mjs pruned away. Exit 0 when every module is OK, 1 otherwise.
//
// Usage: node scripts/check-core-deps.mjs   (run stage-core.mjs first)
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sdkBinaryAllowed, verifyNoSdkBinary } from './sdk-binary.mjs';

const DESKTOP = resolve(import.meta.dirname, '..');
const CORE = join(DESKTOP, 'resources', 'core');
const NODE = join(CORE, 'node', 'node');
const EXT = join(CORE, 'root', 'extension');

/** Each entry: the specifier to import and an expression over the module namespace `m`. */
const MODULES = [
  {
    name: '@anthropic-ai/claude-agent-sdk',
    spec: '@anthropic-ai/claude-agent-sdk',
    expect: 'typeof m.query === "function" && typeof m.createSdkMcpServer === "function"',
  },
  {
    name: '@modelcontextprotocol/sdk (client)',
    spec: '@modelcontextprotocol/sdk/client/index.js',
    expect: 'typeof m.Client === "function"',
  },
  {
    name: '@modelcontextprotocol/sdk (client/stdio)',
    spec: '@modelcontextprotocol/sdk/client/stdio.js',
    expect: 'typeof m.StdioClientTransport === "function"',
  },
  {
    name: 'zod',
    spec: 'zod',
    expect: 'typeof m.z?.object === "function"',
  },
  {
    name: 'better-sqlite3 (in-memory open)',
    spec: 'better-sqlite3',
    db: true,
  },
  {
    name: 'llm_agent/sdk/engine.mjs (import only)',
    spec: pathToFileURL(join(EXT, 'llm_agent', 'sdk', 'engine.mjs')).href,
    expect: 'typeof m === "object" && m !== null',
  },
];

// Child program: resolve the spec first (import.meta.resolve, from the staged extension),
// print the resolved URL, then import it and run the expectation or open an in-memory DB.
// Runs with cwd = the staged extension, so bare specifiers resolve from its node_modules.
const CHILD = `
const resolved = import.meta.resolve(process.env.CHECK_SPEC);
process.stdout.write('RESOLVED ' + resolved + '\\n');
const m = await import(process.env.CHECK_SPEC);
if (process.env.CHECK_DB === '1') {
  const Database = m.default;
  const db = new Database(':memory:');
  const row = db.prepare('select 1 as one').get();
  db.close();
  if (row.one !== 1) throw new Error('in-memory query returned ' + JSON.stringify(row));
} else if (!(new Function('m', 'return (' + process.env.CHECK_EXPECT + ');'))(m)) {
  throw new Error('export check failed: ' + process.env.CHECK_EXPECT);
}
`;

const CORE_REAL = realpathSync(CORE);
/** A resolved URL passes only when it lands inside the staged core, never a repo or system copy. */
function insideCore(resolvedUrl) {
  const file = fileURLToPath(resolvedUrl);
  return file === CORE_REAL || file.startsWith(CORE_REAL + '/');
}

if (!existsSync(NODE)) {
  console.error(`FAIL staged node missing: ${NODE} (run scripts/stage-core.mjs)`);
  process.exit(1);
}

if (!sdkBinaryAllowed()) {
  const bundled = verifyNoSdkBinary(CORE);
  if (bundled.length) {
    for (const b of bundled) console.error(`FAIL  ${b} (Phase 0 condition 2: do not bundle the SDK claude binary)`);
    process.exit(1);
  }
}

// Keep the engine import away from the live database and the server port.
const scratch = mkdtempSync(join(tmpdir(), 'llmide-core-check-'));
const env = {
  ...process.env,
  LLMIDE_DB_PATH: join(scratch, 'check.db'),
  LLMIDE_ENGINE_PREWARM: '0',
};

let failures = 0;
for (const mod of MODULES) {
  try {
    const out = execFileSync(NODE, ['--input-type=module', '-e', CHILD], {
      cwd: EXT,
      env: {
        ...env,
        CHECK_SPEC: mod.spec,
        CHECK_DB: mod.db ? '1' : '0',
        CHECK_EXPECT: mod.expect ?? 'true',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
      encoding: 'utf8',
    });
    const line = out.split('\n').find((l) => l.startsWith('RESOLVED '));
    const resolved = line ? line.slice('RESOLVED '.length).trim() : '';
    if (!resolved || !insideCore(resolved)) {
      failures += 1;
      console.log(`FAIL  ${mod.name}: resolved outside the staged core: ${resolved || '(no resolution)'}`);
      continue;
    }
    console.log(`OK    ${mod.name}  -> ${fileURLToPath(resolved).replace(CORE_REAL, 'core')}`);
  } catch (e) {
    failures += 1;
    const detail = String(e.stderr || e.message).trim().split('\n').find((l) => l.trim()) ?? 'unknown error';
    console.log(`FAIL  ${mod.name}: ${detail}`);
  }
}

console.log(failures === 0 ? `all ${MODULES.length} modules OK` : `${failures} of ${MODULES.length} modules FAILED`);
rmSync(scratch, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);
