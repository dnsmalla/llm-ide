#!/usr/bin/env node
// Bundles gallery/main.tsx (+ kit CSS) into gallery/dist for local viewing. No server needed.
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export async function buildGallery(outdir = join(ROOT, "gallery/dist")) {
  mkdirSync(outdir, { recursive: true });
  await build({
    entryPoints: { gallery: join(ROOT, "gallery/main.tsx") },
    outdir, bundle: true, format: "esm", jsx: "automatic", minify: true, logLevel: "silent",
    define: { "process.env.NODE_ENV": '"production"' },
  });
  copyFileSync(join(ROOT, "gallery/index.html"), join(outdir, "index.html"));
  return outdir;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(`gallery built: ${await buildGallery()}/index.html`);
}
