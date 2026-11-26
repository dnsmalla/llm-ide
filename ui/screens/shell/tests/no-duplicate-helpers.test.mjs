// Guard against the duplicates the dedup refactor removed: a local `isRecord`, and a direct Tauri `invoke`.
// Shared decode helpers live in ui/kit/src/decode.ts; every Tauri command goes through `invokeHost`
// (ui/screens/shell/host.ts) so the SSH/remote gate, root_missing hooks and error reporting always apply.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(fileURLToPath(import.meta.url), "../../../../..");

/** The only file allowed to define isRecord. */
const ISRECORD_HOME = "ui/kit/src/decode.ts";

/**
 * Files and folders (relative to the repo root) that may import `invoke` from "@tauri-apps/api/core".
 * main.tsx installs the bridge; bench/ and spike/ are measurement code that talks to the host raw.
 * The listed views predate the rule: this list may only shrink, never grow. New code uses `invokeHost`.
 */
const INVOKE_ALLOWED = [
  "desktop/src/main.tsx",
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

test("isRecord is defined once, in the kit", () => {
  const offenders = files.filter((f) => f.rel !== ISRECORD_HOME && /\b(function|const|let)\s+isRecord\b/.test(f.text)).map((f) => f.rel);
  assert.deepEqual(offenders, [], "import { isRecord } from ui/kit/src/decode.ts instead of defining it");
});

test("no direct Tauri invoke outside the allow-list", () => {
  const importsInvoke = /import\s+(?:type\s+)?\{[^}]*\binvoke\b[^}]*\}\s+from\s+["']@tauri-apps\/api\/core["']/;
  const offenders = files
    .filter((f) => importsInvoke.test(f.text) && !INVOKE_ALLOWED.some((a) => f.rel === a || (a.endsWith("/") && f.rel.startsWith(a))))
    .map((f) => f.rel);
  assert.deepEqual(offenders, [], "call invokeHost from ui/screens/shell/host.ts instead");
});

test("every allow-listed invoke importer still imports invoke (the list only shrinks)", () => {
  const importsInvoke = /\binvoke\b[^}]*\}\s+from\s+["']@tauri-apps\/api\/core["']/;
  const stale = INVOKE_ALLOWED.filter((a) => !a.endsWith("/") && a !== "desktop/src/main.tsx")
    .filter((a) => !importsInvoke.test(files.find((f) => f.rel === a)?.text ?? ""));
  assert.deepEqual(stale, [], "remove these from INVOKE_ALLOWED");
});
