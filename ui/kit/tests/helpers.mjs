import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const KIT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const REPO = resolve(KIT, "../..");
export const lf = (t) => t.replace(/\r\n/g, "\n");
export const read = (...p) => lf(readFileSync(join(KIT, ...p), "utf8"));

/** `selector { --a: b; }` blocks -> Map(selector -> Map(name -> value)). Comments stripped. */
export function parseBlocks(css) {
  const out = new Map();
  const clean = lf(css).replace(/\/\*[\s\S]*?\*\//g, "");
  for (const m of clean.matchAll(/([^{}@]+)\{([^{}]*)\}/g)) {
    const props = out.get(m[1].trim()) ?? new Map();
    for (const d of m[2].matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) props.set(d[1], d[2].trim());
    out.set(m[1].trim(), props);
  }
  return out;
}

export const kebab = (s) => s.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
