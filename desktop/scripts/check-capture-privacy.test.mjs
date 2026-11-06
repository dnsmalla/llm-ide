import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const TAURI = join(dirname(fileURLToPath(import.meta.url)), "..", "src-tauri");
const read = (p) => readFileSync(join(TAURI, p), "utf8");
const rustFiles = readdirSync(join(TAURI, "src")).filter((f) => f.endsWith(".rs"));
test("no audio, camera or screen-capture usage strings or entitlements", () => {
  const plist = read("Info.plist");
  for (const key of ["NSMicrophoneUsageDescription", "NSCameraUsageDescription", "NSScreenCaptureUsageDescription", "NSAudioCaptureUsageDescription", "NSSpeechRecognitionUsageDescription"]) assert.equal(plist.includes(key), false, `Info.plist must not declare ${key}`);
  assert.equal(/device\.(audio-input|microphone|camera)/.test(read("tauri.conf.json")), false);
});
test("no audio or screen-capture dependency or API", () => {
  const cargo = read("Cargo.toml");
  for (const crate of ["cpal", "coreaudio", "rodio", "screencapturekit", "xcap", "scap", "nokhwa", "AVFoundation"]) assert.equal(cargo.includes(crate), false, `Cargo.toml must not depend on ${crate}`);
  for (const f of rustFiles) { const src = read(join("src", f)); for (const api of ["AVCapture", "AVAudio", "AudioQueue", "AudioUnit", "SCStream", "CGDisplayStream", "CGWindowListCreateImage", "NSSpeechRecognizer"]) assert.equal(src.includes(api), false, `${f} must not use ${api}`); }
});
test("capture modules never print caption text", () => {
  for (const f of rustFiles.filter((n) => n.startsWith("capture_"))) { const src = read(join("src", f)).split("#[cfg(test)]")[0]; for (const l of src.split("\n").filter((l) => /\b(e?print(ln)?|dbg)!\s*\(/.test(l))) assert.equal(/speaker|text|value|caption|row/.test(l), false, `${f}: ${l.trim()}`); }
});
