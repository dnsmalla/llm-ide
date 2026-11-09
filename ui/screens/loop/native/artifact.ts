// Deterministic artifact checks (LoopStage.Kind.artifactCheck). This port covers required paths, sibling-stage
// Outputs, line caps, directory globs, section rules and the verdict rule (one explicit file must hold one exact line).
// Citation resolution is deliberately refused instead of
// passing a check it did not perform.
import type { FsApi } from "../../explorer/fs";
import type { LoopStage } from "./model.ts";

export interface ArtifactCheck {
  requiredPaths?: string[];
  lineLimits?: { glob: string; maxLines: number; excludes?: string[] }[];
  citationGlobs?: string[];
  projectRootFallback?: boolean;
  outputRules?: { stage: string; skillId?: string | null; shape: "file" | "directory"; maxLines: number; subGlob?: string | null; excludeStages?: string[]; citations?: boolean }[];
  sectionRules?: { headerPrefix: string; requiredLinePrefixes: string[] }[];
  /** One explicit report file (relative to the run root; dot-folders allowed) that must contain `line` as a whole line. */
  verdict?: { path: string; line: string };
}

export type ArtifactFs = Pick<FsApi, "read" | "list">;

function globRe(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") { out += "(?:.*/)?"; i++; }
        else out += ".*";
      } else out += "[^/]*";
    } else if (c === "?") out += "[^/]";
    else out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

function trimPath(p: string): string {
  let s = p.trim();
  while (s.startsWith("./")) s = s.slice(2);
  while (s.length > 1 && s.endsWith("/")) s = s.slice(0, -1);
  return s === "." ? "" : s;
}

/** Expands a glob under a project-relative directory. Hidden/build dirs are skipped like the Mac. */
async function expand(fs: ArtifactFs, base: string, glob: string, limit = 2000): Promise<string[]> {
  const cleanBase = base === "." ? "" : trimPath(base);
  const re = globRe(trimPath(glob));
  const out: string[] = [];
  const skip = new Set([".git", "node_modules", ".build", ".swiftpm", "DerivedData"]);
  const walk = async (dir: string) => {
    if (out.length >= limit) return;
    let entries;
    try { entries = (await fs.list(dir)).entries; } catch { return; }
    for (const e of entries) {
      if (out.length >= limit) return;
      if (e.name.startsWith(".") || skip.has(e.name)) continue;
      const rel = cleanBase === "" ? e.path : e.path.startsWith(`${cleanBase}/`) ? e.path.slice(cleanBase.length + 1) : e.path;
      if (e.kind === "dir") await walk(e.path);
      else if (e.kind === "file" && re.test(rel)) out.push(e.path);
    }
  };
  await walk(base);
  return out;
}

async function exists(fs: ArtifactFs, path: string): Promise<boolean> {
  try { return (await fs.read(path, 1)).status === "ok"; } catch { return false; }
}

async function lineCount(fs: ArtifactFs, path: string): Promise<number> {
  const r = await fs.read(path, 8_000_000);
  return r.text === null ? 0 : r.text.split("\n").length;
}

/**
 * The `verdict` rule: read ONE explicit file and require one exact line. Unlike `expand()`, a dot-folder path such as
 * `.factory/READINESS.md` is read, and a missing file or line fails, so a stage that never wrote its report cannot pass.
 * `verdict` comes from loop.json, which the webview can write, so its shape and path are checked here.
 */
async function verdictFailures(fs: ArtifactFs, verdict: unknown, prefix: string): Promise<string[]> {
  const v = typeof verdict === "object" && verdict !== null ? (verdict as { path?: unknown; line?: unknown }) : {};
  if (typeof v.path !== "string" || typeof v.line !== "string" || !v.path.trim() || !v.line.trim()) return ["verdict check needs a path and a line"];
  const path = trimPath(v.path);
  if (path.startsWith("/") || path.split("/").includes("..")) return [`verdict path must stay inside the run root: ${v.path}`];
  const want = v.line.trim();
  let text: string | null = null;
  try {
    const r = await fs.read(`${prefix}${path}`, 8_000_000);
    text = r.status === "ok" ? r.text : null;
  } catch {
    text = null;
  }
  if (text === null) return [`verdict file missing: ${path}`];
  if (!text.split("\n").some((l) => l.trim() === want)) return [`verdict line missing: "${want}" in ${path}`];
  return [];
}

export interface ArtifactRoots { repoPrefix: string; projectPrefix: string }
export interface ArtifactResult { passed: boolean; failures: string[] }

export async function evaluateArtifact(fs: ArtifactFs, check: ArtifactCheck, stages: readonly LoopStage[], roots: ArtifactRoots): Promise<ArtifactResult> {
  const failures: string[] = [];
  const citationGlobs = [...(check.citationGlobs ?? [])];
  const required = [...(check.requiredPaths ?? [])];
  const limits = [...(check.lineLimits ?? [])];
  const sections = check.sectionRules ?? [];
  const sectionTargets: string[] = [];
  const outputs = new Map<string, string>();
  for (const st of stages) {
    if (st.outputPath) outputs.set(st.defaultKey ?? st.skillId ?? st.id, trimPath(st.outputPath));
  }
  const sibling = (key: string, skill?: string | null) => stages.find((s) => s.defaultKey === key) ?? (skill ? stages.find((s) => s.skillId === skill) : undefined);
  for (const rule of check.outputRules ?? []) {
    const st = sibling(rule.stage, rule.skillId);
    const out = st?.outputPath ? trimPath(st.outputPath) : "";
    if (!out) continue;
    if (rule.shape === "file") {
      required.push(out);
      limits.push({ glob: out, maxLines: rule.maxLines });
      sectionTargets.push(out);
      if (rule.citations) citationGlobs.push(out);
    } else {
      sectionTargets.push(`${out}/${rule.subGlob ?? "**/*.md"}`);
      if (rule.subGlob) {
        limits.push({ glob: `${out}/${rule.subGlob}`, maxLines: rule.maxLines, excludes: (rule.excludeStages ?? []).map((k) => outputs.get(k) ?? "").filter(Boolean) });
        if (rule.citations) citationGlobs.push(`${out}/${rule.subGlob}`);
      }
    }
  }
  const prefix = roots.repoPrefix ? `${roots.repoPrefix}/` : "";
  for (const p of required) {
    const rel = `${prefix}${p}`;
    const fallback = `${roots.projectPrefix ? `${roots.projectPrefix}/` : ""}${p}`;
    if (!(await exists(fs, rel)) && !(check.projectRootFallback && await exists(fs, fallback))) failures.push(`missing: ${p}`);
  }
  if (check.verdict !== undefined) failures.push(...(await verdictFailures(fs, check.verdict, prefix)));
  for (const limit of limits) {
    const files = await expand(fs, roots.repoPrefix || ".", limit.glob);
    if (check.projectRootFallback && roots.projectPrefix !== roots.repoPrefix) {
      for (const f of await expand(fs, roots.projectPrefix || ".", limit.glob)) if (!files.includes(f)) files.push(f);
    }
    for (const file of files) {
      const rel = roots.repoPrefix ? file.slice(roots.repoPrefix.length + 1) : file;
      if ((limit.excludes ?? []).some((ex) => globRe(trimPath(ex)).test(rel))) continue;
      const n = await lineCount(fs, file);
      if (n > limit.maxLines) failures.push(`${rel}: ${n} lines (limit ${limit.maxLines})`);
    }
  }
  for (const s of sections) {
    for (const target of sectionTargets) {
      const files = target.endsWith(".md") ? await expand(fs, roots.repoPrefix || ".", target) : [];
      for (const file of files) {
        const r = await fs.read(file, 8_000_000);
        const lines = r.text?.split("\n") ?? [];
        let i = 0;
        while (i < lines.length) {
          if (!lines[i].startsWith(s.headerPrefix)) { i++; continue; }
          let end = i + 1;
          while (end < lines.length && !lines[end].startsWith("### ")) end++;
          const body = lines.slice(i + 1, end);
          for (const prefix of s.requiredLinePrefixes) if (!body.some((l) => l.startsWith(prefix))) failures.push(`${file}: ${lines[i]} missing \`${prefix}\``);
          i = end;
        }
      }
    }
  }
  const seen = new Set<string>();
  for (const glob of citationGlobs) {
    const candidates = await expand(fs, roots.repoPrefix || ".", glob);
    if (check.projectRootFallback && roots.projectPrefix !== roots.repoPrefix) for (const f of await expand(fs, roots.projectPrefix || ".", glob)) if (!candidates.includes(f)) candidates.push(f);
    for (const file of candidates) {
      if (!file.endsWith(".md") || seen.has(file)) continue;
      seen.add(file);
      const r = await fs.read(file, 8_000_000);
      const text = r.text ?? "";
      let fence = false;
      for (const line of text.split("\n")) {
        if (line.trim().startsWith("```")) { fence = !fence; continue; }
        if (fence) continue;
        for (const m of line.matchAll(/`([^`]+)`/g)) {
          const raw = m[1].trim();
          if (!raw || raw.startsWith("/") || raw.startsWith("~") || raw.includes("://") || /[ *<>{}$()|\\"']/.test(raw)) continue;
          const path = raw.replace(/:\d+(-\d+)?$/, "");
          if (!path.includes("/")) continue;
          const rel = path.replace(/^(\.\/)+/, "");
          const target = roots.repoPrefix ? `${roots.repoPrefix}/${rel}` : rel;
          if (!(await exists(fs, target))) failures.push(`${file}: citation does not resolve: \`${raw}\``);
        }
      }
    }
  }
  return { passed: failures.length === 0, failures };
}
