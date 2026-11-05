// Node module hooks so tests can import src/*.ts as Vite builds it:
// extensionless relative imports, and TS `enum` (strip-only mode rejects it).
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { fileURLToPath } from 'node:url';

export async function resolve(spec, ctx, next) {
  try {
    return await next(spec, ctx);
  } catch (e) {
    if (spec.startsWith('.') && !/\.[a-z]+$/.test(spec)) return next(`${spec}.ts`, ctx);
    throw e;
  }
}

export async function load(url, ctx, next) {
  if (!url.includes('/extension/src/') || !/\.ts(\?|$)/.test(url)) return next(url, ctx);
  const src = readFileSync(fileURLToPath(url.split('?')[0]), 'utf8');
  return { format: 'module', shortCircuit: true, source: stripTypeScriptTypes(src, { mode: 'transform' }) };
}
