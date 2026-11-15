// Report-only Test Prune scan. Never edits a test: it lists no-assertion tests, commented-out tests, focused tests
// (.only / fit / fdescribe), gap duplicates and tests whose source file is gone. Integration/performance tests are
// exempt from the source-gone rule. Mirrors the Mac scanner's finding kinds this slice can verify.
import type { FsApi } from "../../explorer/fs";
import { CODE_FILE, WALK_STOP_NOTE, walkFiles, type TestMapFs, type TestStructure } from "./testmap.ts";

export type PruneReason = "noAssertion" | "commentedOutTest" | "focusedTest" | "gapDuplicate" | "sourceGone";
export interface PruneFinding { path: string; reason: PruneReason; line?: number }
export type PruneFs = TestMapFs & Pick<FsApi, "read" | "write" | "create">;

const ASSERTIONS = ["assert", "XCTAssert", "#expect", "expect(", "pytest.raises", "t.Error", "t.Fatal", "#require"];
const UNMIRRORED = new Set(["integration", "performance"]);
const TEST_MARKER = /(describe|it|test|specify|@Test|def test_|func test[A-Z])/;
const COMMENTED = /^\s*(#|\/\/)\s*(def test_|func test|it\(\s*['"]|test\(\s*['"])/;
const FOCUSED = /(?:\b(?:fit|fdescribe|ftest)\s*\(|\.(?:only)\s*\()/;

function stemOfTest(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base.replace(/(?:\.test|\.spec|Tests|_test|_spec|GapTests|_gap)?\.[^.]+$/, "").replace(/^test_/, "");
}
function gapSibling(path: string): string | null {
  const segs = path.split("/"); const name = segs.pop()!; const ext = name.split(".").pop();
  let sibling: string | null = null;
  if (ext === "swift" && name.endsWith("GapTests")) sibling = `${name.slice(0, -8)}Tests.swift`;
  else if (ext === "py" && name.startsWith("test_") && name.endsWith("_gap.py")) sibling = `${name.slice(0, -7)}.py`;
  else if (["mjs", "cjs", "js", "jsx", "ts", "tsx"].includes(ext ?? "") && /\.gap\.(test|spec)\./.test(name)) sibling = name.replace(/\.gap\./, ".");
  if (!sibling) return null;
  return segs.length ? `${segs.join("/")}/${sibling}` : sibling;
}

/** `notes` gets the walk-limit note when the source walk stops early (its stems would be incomplete). */
export async function scanTestPrune(fs: PruneFs, repoPrefix: string, structure: TestStructure, notes: string[] = []): Promise<PruneFinding[]> {
  const prefix = repoPrefix ? `${repoPrefix}/` : "";
  // Source files too: a test is judged by whether its source file exists, so the walk keeps every code file.
  const report = { stopped: false };
  const all = await walkFiles(fs, prefix.replace(/\/$/, "") || ".", (p) => CODE_FILE.test(p), report);
  if (report.stopped) notes.push(WALK_STOP_NOTE);
  const rel = (p: string) => repoPrefix && p.startsWith(`${repoPrefix}/`) ? p.slice(repoPrefix.length + 1) : p;
  const fileSet = new Set(all.map(rel));
  const stems = new Set([...fileSet].map((p) => p.split("/").pop()?.replace(/\.[^.]+$/, "") ?? ""));
  const findings: PruneFinding[] = [];
  const seen = new Set<string>();
  for (const root of structure.roots) {
    const testBase = `${prefix}${root.testDir}`.replace(/\/$/, "");
    for (const file of all) {
      if (!(file === testBase || file.startsWith(`${testBase}/`)) || seen.has(file)) continue;
      seen.add(file);
      const r = await fs.read(file, 2_000_000);
      const text = r.status === "ok" ? r.text ?? "" : "";
      if (!TEST_MARKER.test(text)) continue;
      const path = rel(file);
      const dirs = path.split("/").slice(0, -1);
      if (!dirs.some((d) => UNMIRRORED.has(d)) && !stems.has(stemOfTest(path))) findings.push({ path, reason: "sourceGone" });
      const gap = gapSibling(path);
      if (gap && fileSet.has(gap)) findings.push({ path, reason: "gapDuplicate" });
      if (!ASSERTIONS.some((a) => text.includes(a))) findings.push({ path, reason: "noAssertion" });
      text.split("\n").forEach((line, i) => {
        if (COMMENTED.test(line)) findings.push({ path, reason: "commentedOutTest", line: i + 1 });
        if (FOCUSED.test(line)) findings.push({ path, reason: "focusedTest", line: i + 1 });
      });
    }
  }
  return findings;
}

export function renderTestPrune(findings: readonly PruneFinding[]): string {
  const lines = ["# Test prune", "", `${findings.length} finding(s). Report only — no test file was changed.`, ""];
  const label: Record<PruneReason, string> = { noAssertion: "No assertion", commentedOutTest: "Commented-out test", focusedTest: "Focused test", gapDuplicate: "Gap duplicate", sourceGone: "Source file is gone" };
  for (const f of findings) lines.push(`- ${f.path}${f.line ? `:${f.line}` : ""} — ${label[f.reason]}`);
  return lines.join("\n") + "\n";
}

export async function writeTestPrune(fs: PruneFs, repoPrefix: string, findings: readonly PruneFinding[]): Promise<string> {
  const prefix = repoPrefix ? `${repoPrefix}/` : "";
  const path = `${prefix}llm-doc/loop/test/TEST-PRUNE.md`;
  let at = "";
  for (const seg of path.split("/").slice(0, -1)) { at = at ? `${at}/${seg}` : seg; try { await fs.create(at, "dir"); } catch (e) { if ((e as { code?: string })?.code !== "exists") throw e; } }
  await fs.write(path, renderTestPrune(findings), { expected_hash: null, force: true });
  return path;
}
