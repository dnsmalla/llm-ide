// Guard against the duplicates the dedup refactor removed: a local copy of the record guard (under any name),
// and a direct value import of the Tauri core API. Shared decode helpers live in ui/kit/src/decode.ts; new code
// calls the host only through `invokeHost` (ui/screens/shell/host.ts) so the SSH/remote gate, root_missing hooks
// and error reporting apply. The allow-list below may only shrink.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(fileURLToPath(import.meta.url), "../../../../..");

/** The only file allowed to define the record guard (no documented exceptions: shell/permissions.ts accepts arrays, so it is a different function). */
const ISRECORD_HOME = "ui/kit/src/decode.ts";

/**
 * Files and folders (relative to the repo root) that may value-import "@tauri-apps/api" or "@tauri-apps/api/core".
 * main.tsx installs the bridge; tauriChannel.ts hands screens a Channel; bench/ and spike/ are measurement code.
 * The listed views predate the rule: this list may only shrink, never grow. New code uses `invokeHost`.
 */
const INVOKE_ALLOWED = [
  "desktop/src/main.tsx",
  "desktop/src/tauriChannel.ts",
  "desktop/src/bench/",
  "desktop/src/spike/",
  "desktop/src/chat/replay.ts",
  "desktop/src/graph/sources.ts",
  "desktop/src/views/ChatView.tsx",
  "desktop/src/views/EditorView.tsx",
  "desktop/src/views/GraphView.tsx",
  "desktop/src/views/TerminalView.tsx",
];

function sources(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "tests" || entry.name === ".cache") continue;
      out.push(...sources(path));
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      out.push(path);
    }
  }
  return out;
}

const files = ["ui/screens", "ui/kit/src", "desktop/src"].flatMap((dir) => sources(join(REPO, dir)).map((f) => ({ rel: relative(REPO, f), text: readFileSync(f, "utf8") })));

test("the scan finds the source trees", () => {
  assert.ok(files.length > 200, `only ${files.length} files scanned`);
});

/** True when `text` defines a function or arrow whose body is the typeof-object + not-null + not-array record guard. */
export function definesRecordGuard(text) {
  return /\bis\s+(?:Record<string,\s*unknown>|\w+)\s*(?:=>|\{)[^;]*?typeof[^;]*?["']object["'][^;]*?Array\.isArray/.test(text);
}

/** True when `text` value-imports (statically or dynamically) from "@tauri-apps/api" or "@tauri-apps/api/core". */
export function importsTauriCoreValue(source) {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
  if (/\bimport\s*\(\s*["']@tauri-apps\/api(?:\/core)?["']\s*\)/.test(text)) return true;
  const staticRe = /\b(?:import|export)\s+(?!type\b)([^;"']*?)\s*from\s*["']@tauri-apps\/api(?:\/core)?["']/g;
  for (const m of text.matchAll(staticRe)) {
    const clause = m[1].trim();
    if (!clause.startsWith("{")) return true; // default, namespace or `export *`
    const names = clause.replace(/^\{|\}$/g, "").split(",").map((n) => n.trim()).filter(Boolean);
    if (names.some((n) => !n.startsWith("type "))) return true;
  }
  return /\bimport\s+["']@tauri-apps\/api(?:\/core)?["']/.test(text);
}

const isAllowedInvoke = (rel) => INVOKE_ALLOWED.some((a) => rel === a || (a.endsWith("/") && rel.startsWith(a)));

test("the record-guard matcher catches renamed copies and ignores look-alikes", () => {
  const yes = [
    'const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);',
    'const isObj = (v: unknown): v is Obj =>\n  typeof v === "object" && v !== null && !Array.isArray(v);',
    'function isObject(v: unknown): v is Record<string, unknown> {\n  return typeof v === "object" && v !== null && !Array.isArray(v);\n}',
    'export const rec = (v: unknown): v is Rec => !!v && typeof v === "object" && !Array.isArray(v);',
  ];
  const no = [
    'const isObjectOrArray = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;',
    'const str = (v: unknown): v is string => typeof v === "string";',
    'const isList = (v: unknown): v is unknown[] => Array.isArray(v);',
    'import { isRecord } from "../../kit/src/decode.ts";\nconst x = typeof y === "object";\nArray.isArray(z);',
  ];
  for (const sample of yes) assert.ok(definesRecordGuard(sample), sample);
  for (const sample of no) assert.ok(!definesRecordGuard(sample), sample);
});

test("the tauri matcher catches every value import form and ignores type-only ones", () => {
  const yes = [
    'import { invoke } from "@tauri-apps/api/core";',
    'import { Channel, invoke } from "@tauri-apps/api/core";',
    'import * as core from "@tauri-apps/api/core";',
    'import { core } from "@tauri-apps/api";',
    'import core from "@tauri-apps/api/core";',
    'const m = await import("@tauri-apps/api/core");',
    'import("@tauri-apps/api")',
    'import { type Channel, invoke } from "@tauri-apps/api/core";',
    'import {\n  invoke,\n} from "@tauri-apps/api/core";',
  ];
  const no = [
    'import type { Channel } from "@tauri-apps/api/core";',
    'import { type Channel } from "@tauri-apps/api/core";',
    'import { listen } from "@tauri-apps/api/event";',
    'import("@tauri-apps/api/event")',
    'import { invokeHost } from "../shell/host";',
    '// import { invoke } from "@tauri-apps/api/core" is banned',
  ];
  for (const sample of yes) assert.ok(importsTauriCoreValue(sample), sample);
  for (const sample of no) assert.ok(!importsTauriCoreValue(sample), sample);
});

test("the record guard is defined once, in the kit, under any name", () => {
  const offenders = files.filter((f) => f.rel !== ISRECORD_HOME && definesRecordGuard(f.text)).map((f) => f.rel);
  assert.deepEqual(offenders, [], "import { isRecord } from ui/kit/src/decode.ts instead of defining it");
});

test("no direct Tauri core import outside the allow-list", () => {
  const offenders = files.filter((f) => importsTauriCoreValue(f.text) && !isAllowedInvoke(f.rel)).map((f) => f.rel);
  assert.deepEqual(offenders, [], "call invokeHost from ui/screens/shell/host.ts instead");
});

test("every allow-listed file still imports the Tauri core (the list only shrinks)", () => {
  const stale = INVOKE_ALLOWED.filter((a) => !a.endsWith("/")).filter((a) => !importsTauriCoreValue(files.find((f) => f.rel === a)?.text ?? ""));
  assert.deepEqual(stale, [], "remove these from INVOKE_ALLOWED");
});
