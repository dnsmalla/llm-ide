// The folder of the repository a loop works on ("" = the whole repository). Pure: no UI or host imports.
import type { LoopDefinition } from "./model.ts";

/** The app's own folders, never code a loop should refactor or test. Root-anchored. */
const APP_ROOTS = ["system", "llm-doc/loop"];
/** Folders the app or the toolchain owns wherever they appear. */
const TOOL_SEGMENTS = new Set([".git", ".factory", "node_modules"]);
const MAX_LENGTH = 300;

/** Skill stages that read or change files, so the input path limits them. */
export const INPUT_PATH_SKILLS: ReadonlySet<string> = new Set([
  "skills/refactor-planner", "skills/refactor-apply", "skills/refactor-conform", "skills/test-gap-writer",
]);

/** Normalizes a user-typed folder to a repository-relative path; `""` means the whole repository. */
export function normalizeInputPath(raw: string): { path: string } | { error: string } {
  const s = raw.trim().replace(/\\/g, "/");
  if (/[\u0000-\u001f\u007f]/.test(s)) return { error: "The input path cannot contain control characters." };
  if (s.length > MAX_LENGTH) return { error: `The input path must be ${MAX_LENGTH} characters or fewer.` };
  if (s.startsWith("/") || s.startsWith("~") || /^[A-Za-z]:/.test(s)) return { error: "The input path must be relative to the repository root, such as src/billing." };
  const segments = s.split("/").filter((seg) => seg !== "" && seg !== ".");
  if (segments.includes("..")) return { error: "The input path cannot contain “..”." };
  const path = segments.join("/");
  if (segments.some((seg) => TOOL_SEGMENTS.has(seg))) return { error: "The input path cannot point inside .git, .factory or node_modules." };
  if (APP_ROOTS.some((root) => path === root || path.startsWith(`${root}/`))) return { error: "The input path cannot point inside the app's own system/ or llm-doc/loop/ folders." };
  return { path };
}

/** True when `path` is the scope folder or inside it. Segment-aware: `src/billing2` is not inside `src/billing`. */
export function pathInside(scope: string, path: string): boolean {
  return scope === "" || path === scope || path.startsWith(`${scope}/`);
}

/** True when an enabled skill stage of the loop works on files, so its input path applies. */
export function loopUsesInputPath(loop: Pick<LoopDefinition, "config">): boolean {
  return loop.config.stages.some((s) => s.enabled && s.kind === "skill" && s.skillId !== null && INPUT_PATH_SKILLS.has(s.skillId));
}
