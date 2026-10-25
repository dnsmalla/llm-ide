// Deterministic 10 000-line TypeScript sample for the editor view and bench.
// Same seed, same bytes, every run: the bench numbers are comparable across runs.
import { mulberry32 } from "../graph/prng";

export const SAMPLE_LINES = 10_000;
export const SAMPLE_SEED = 0x11ed;

const NOUNS = ["account", "buffer", "cache", "client", "config", "cursor", "delta", "event", "graph", "index", "journal", "ledger", "meeting", "node", "parser", "queue", "route", "session", "token", "usage", "vector", "window", "worker"];
const VERBS = ["load", "parse", "render", "merge", "resolve", "collect", "format", "sync", "build", "prune", "flush", "index"];
const TYPES = ["string", "number", "boolean", "Date", "Map<string, number>", "string[]", "readonly Item[]"];
const SENTENCES = [
  "Returns the cached value, or undefined when the key is unknown.",
  "Keeps the list sorted by insertion time so the oldest entry is first.",
  "Callers must hold the session lock before calling this helper.",
  "The result is memoised per input; invalidate with reset().",
  "Edges are weighted, never pruned, so dense graphs stay complete.",
];

type Rnd = () => number;

function pick<T>(rnd: Rnd, xs: readonly T[]): T {
  return xs[Math.floor(rnd() * xs.length)] as T;
}

/** One function block (doc comment, signature, body). `n` keeps every identifier unique. */
function functionBlock(rnd: Rnd, n: number): string[] {
  const noun = pick(rnd, NOUNS);
  const name = `${pick(rnd, VERBS)}${noun[0]?.toUpperCase()}${noun.slice(1)}${n}`;
  const t = pick(rnd, TYPES);
  return [
    `/** ${pick(rnd, SENTENCES)} */`,
    `export function ${name}(input: ${t}, limit = ${Math.floor(rnd() * 90) + 10}): number {`,
    `  // step ${n}: scan the input before the limit check`,
    `  let total = 0;`,
    `  for (let i = 0; i < limit; i += 1) {`,
    `    if (i % ${Math.floor(rnd() * 6) + 2} === 0) {`,
    `      total += i * ${n % 17 + 1};`,
    `    } else {`,
    `      total -= 1;`,
    `    }`,
    `  }`,
    `  return total + String(input).length;`,
    `}`,
  ];
}

/** One class block with a field, a constructor and two methods. */
function classBlock(rnd: Rnd, n: number): string[] {
  const noun = pick(rnd, NOUNS);
  const cls = `${noun[0]?.toUpperCase()}${noun.slice(1)}Store${n}`;
  return [
    `export class ${cls} {`,
    `  private readonly items = new Map<string, ${pick(rnd, TYPES)}>();`,
    `  private hits = 0;`,
    ``,
    `  constructor(private readonly label: string) {}`,
    ``,
    `  /** ${pick(rnd, SENTENCES)} */`,
    `  get(key: string): ${pick(rnd, TYPES)} | undefined {`,
    `    const value = this.items.get(key);`,
    `    if (value !== undefined) {`,
    `      this.hits += 1;`,
    `    }`,
    `    return value;`,
    `  }`,
    ``,
    `  summary(): string {`,
    `    return \`\${this.label}: \${this.hits} hits, \${this.items.size} keys\`;`,
    `  }`,
    `}`,
  ];
}

/** Interface plus a typed constant and an arrow helper. */
function typeBlock(rnd: Rnd, n: number): string[] {
  const noun = pick(rnd, NOUNS);
  return [
    `export interface ${noun[0]?.toUpperCase()}${noun.slice(1)}Options${n} {`,
    `  readonly id: string;`,
    `  readonly retries?: number;`,
    `  readonly tags: readonly ${pick(rnd, TYPES)}[];`,
    `}`,
    ``,
    `export const defaults${n}: ${noun[0]?.toUpperCase()}${noun.slice(1)}Options${n} = { id: "${noun}-${n}", tags: [] };`,
    ``,
    `const sum${n} = (xs: number[]): number => xs.reduce((a, b) => a + b, ${Math.floor(rnd() * 5)});`,
  ];
}

/** Section comment, string table and a short loop, the kind of code that fills real files. */
function tableBlock(rnd: Rnd, n: number): string[] {
  const rows = 3 + Math.floor(rnd() * 3);
  const out = [`// ---- section ${n}: ${pick(rnd, NOUNS)} messages ----`, `export const messages${n} = {`];
  for (let r = 0; r < rows; r += 1) {
    out.push(`  ${pick(rnd, VERBS)}Failed${r}: "${pick(rnd, SENTENCES).slice(0, 40)}",`);
  }
  out.push(`} as const;`);
  return out;
}

const BLOCKS: ReadonlyArray<(rnd: Rnd, n: number) => string[]> = [functionBlock, classBlock, typeBlock, tableBlock];

/**
 * Builds exactly `lines` lines of TypeScript. Blocks are appended while they fit;
 * the remainder is filled with one-line constants, so the file never ends mid-block.
 */
export function generateSampleTs(lines = SAMPLE_LINES, seed = SAMPLE_SEED): string {
  const rnd = mulberry32(seed);
  const out: string[] = [
    `// Generated sample (seed ${seed.toString(16)}, ${lines} lines). Do not edit by hand.`,
    `// Used by the LLM-IDE desktop PoC editor view and its keystroke bench.`,
    ``,
  ];
  let n = 1;
  while (out.length < lines) {
    const block = pick(rnd, BLOCKS);
    const chunk = block(rnd, n);
    n += 1;
    if (out.length + chunk.length + 1 > lines) break;
    out.push(...chunk, ``);
  }
  for (let pad = 0; out.length < lines; pad += 1) {
    out.push(`export const pad${pad} = ${pad};`);
  }
  if (out.length !== lines) throw new Error(`sample generator produced ${out.length} lines, expected ${lines}`);
  return out.join("\n");
}
