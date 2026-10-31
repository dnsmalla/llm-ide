#!/usr/bin/env node
// Vendors graph-kit's Rust layout kernel (WASM) into ui/screens/graph/wasm/ and verifies it.
//
//   node scripts/vendor-graph-layout-wasm.mjs             build from the graph-kit checkout, copy, write the manifest
//   node scripts/vendor-graph-layout-wasm.mjs --from <f>  vendor a prebuilt .wasm (the graph-kit commit is still recorded)
//   node scripts/vendor-graph-layout-wasm.mjs --verify    check the committed .wasm against the committed manifest
//
// graph-kit is a separate repository (mac/LocalPackages/graph-kit, a submodule): this script only READS it and
// builds into a temporary target directory; it never commits there and never touches the pin. The manifest
// records the graph-kit commit, the compiler, the build command, the sha256 and the size, so a reviewer can
// rebuild and compare. wasm bytes are only reproducible with the same compiler, so a rebuild with a different
// rustc may differ and is reported rather than failing.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const WASM_DIR = join(ROOT, "ui/screens/graph/wasm");
export const WASM_FILE = join(WASM_DIR, "graph-layout.wasm");
export const MANIFEST_FILE = join(WASM_DIR, "MANIFEST.json");
const KIT = join(ROOT, "mac/LocalPackages/graph-kit");
export const BUILD_COMMAND = "cd mac/LocalPackages/graph-kit && CARGO_TARGET_DIR=<tmp> scripts/build-layout-wasm.sh <tmp-out>  (cargo build --release -p graph-layout --lib --target wasm32-unknown-unknown)";

export const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/** Problems with the committed artifact, as strings (empty = verified). */
export function verify(wasmFile = WASM_FILE, manifestFile = MANIFEST_FILE) {
  const problems = [];
  if (!existsSync(manifestFile)) return ["MANIFEST.json is missing"];
  if (!existsSync(wasmFile)) return ["graph-layout.wasm is missing"];
  let m;
  try { m = JSON.parse(readFileSync(manifestFile, "utf8")); } catch { return ["MANIFEST.json is not valid JSON"]; }
  const bytes = readFileSync(wasmFile);
  if (sha256(bytes) !== m.sha256) problems.push(`sha256 mismatch: file ${sha256(bytes)}, manifest ${m.sha256}`);
  if (bytes.length !== m.bytes) problems.push(`size mismatch: file ${bytes.length}, manifest ${m.bytes}`);
  if (!/^[0-9a-f]{40}$/.test(String(m.graphKitCommit ?? ""))) problems.push("manifest lacks a 40-hex graphKitCommit");
  // A real wasm module starts with \0asm, version 1.
  if (bytes.length < 8 || bytes.readUInt32BE(0) !== 0x0061736d || bytes.readUInt32LE(4) !== 1) problems.push("file is not a WebAssembly module");
  return problems;
}

function toolchainEnv() {
  const bin = join(homedir(), ".rustup/toolchains/stable-aarch64-apple-darwin/bin");
  return { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` };
}

function build() {
  const tmp = mkdtempSync(join(tmpdir(), "gl-wasm-"));
  const env = { ...toolchainEnv(), CARGO_TARGET_DIR: join(tmp, "target") };
  const out = join(tmp, "out");
  const r = spawnSync("bash", [join(KIT, "scripts/build-layout-wasm.sh"), out], { env, cwd: KIT, stdio: ["ignore", "inherit", "inherit"] });
  if (r.status !== 0) {
    rmSync(tmp, { recursive: true, force: true });
    throw new Error("the graph-kit wasm build failed (needs the rust toolchain with the wasm32-unknown-unknown target)");
  }
  return { file: join(out, "graph_layout.wasm"), tmp, env };
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--verify")) {
    const p = verify();
    if (p.length) { console.error("graph-layout.wasm verification FAILED:\n  " + p.join("\n  ")); process.exit(1); }
    const m = JSON.parse(readFileSync(MANIFEST_FILE, "utf8"));
    console.log(`graph-layout.wasm verified: ${m.bytes} bytes, sha256 ${m.sha256}, graph-kit ${m.graphKitCommit.slice(0, 12)}`);
    return;
  }
  const fromIdx = args.indexOf("--from");
  let src, tmp = null, env = toolchainEnv();
  if (fromIdx >= 0) src = resolve(args[fromIdx + 1] ?? "");
  else ({ file: src, tmp, env } = build());
  try {
    const bytes = readFileSync(src);
    const commit = execFileSync("git", ["-C", KIT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const dirty = execFileSync("git", ["-C", KIT, "status", "--porcelain", "--", "rust/graph-layout"], { encoding: "utf8" }).trim() !== "";
    if (dirty) throw new Error("rust/graph-layout has uncommitted changes in the graph-kit checkout: vendor only a committed kernel");
    let rustc = "unknown";
    try { rustc = execFileSync("rustc", ["-V"], { encoding: "utf8", env }).trim(); } catch { /* recorded as unknown */ }
    mkdirSync(WASM_DIR, { recursive: true });
    if (existsSync(MANIFEST_FILE)) {
      const old = JSON.parse(readFileSync(MANIFEST_FILE, "utf8"));
      if (old.graphKitCommit === commit && old.rustc === rustc && old.sha256 !== sha256(bytes)) {
        console.warn(`NOTE: same graph-kit commit and rustc as the manifest, but the bytes differ (${old.sha256.slice(0, 12)} vs ${sha256(bytes).slice(0, 12)}): the build is not reproducible here.`);
      }
    }
    copyFileSync(src, WASM_FILE);
    const manifest = {
      file: "graph-layout.wasm",
      graphKitCommit: commit,
      rustc,
      buildCommand: BUILD_COMMAND,
      sha256: sha256(bytes),
      bytes: bytes.length,
      gzipBytes: gzipSync(bytes, { level: 9 }).length,
      abi: "gl_alloc, gl_free, gl_layout, gl_out_ptr, gl_out_len, memory (no imports)",
    };
    writeFileSync(MANIFEST_FILE, JSON.stringify(manifest, null, 2) + "\n");
    const p = verify();
    if (p.length) throw new Error("verification after vendoring failed: " + p.join("; "));
    console.log(`vendored ${WASM_FILE}\n  ${manifest.bytes} bytes (${manifest.gzipBytes} gzip), sha256 ${manifest.sha256}\n  graph-kit ${commit}, ${rustc}`);
  } finally {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (e) { console.error(e instanceof Error ? e.message : e); process.exit(1); }
}
