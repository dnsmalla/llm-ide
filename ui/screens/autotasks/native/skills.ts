// The project's agent skills for the Auto Task skill picker, mirroring the Mac's AutoTaskSkillCatalog: every folder
// under `.claude/skills/` with a SKILL.md, named by its frontmatter `name` (the folder name when missing). The
// code-applying skills are excluded: only the Loop runs those, with its batch and repair safety.
import type { FsApi } from "../../explorer/fs";

export interface ProjectSkill { name: string; description: string }

/** Bare names of the code-applying skills (the Mac's `CodeApplyingSkills.names`). */
export const EXCLUDED_SKILL_NAMES: ReadonlySet<string> = new Set(["refactor-apply", "test-gap-writer", "test-structure-setup", "refactor-conform"]);

/** A skill name the picker may offer: a bare folder-style slug. Anything else (a `/`, `..`, spaces) is refused, so a
 *  cloned repo's manifest cannot name a catalog id such as `skills/refactor-apply` and slip past the exclusion. */
const SAFE_SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export function isOfferableSkillName(name: string): boolean {
  return SAFE_SKILL_NAME.test(name) && !name.includes("..") && !EXCLUDED_SKILL_NAMES.has(name);
}

/** The server catalog id an Auto Task sends for a picked skill (`/kb/loop/agent-run` resolves only `<family>/<dir>`
 *  ids from the user's own skills repo, never the project's file), or null when the name may not run. */
export function skillRunId(name: string): string | null {
  return isOfferableSkillName(name) ? `skills/${name}` : null;
}

export function parseSkillManifest(text: string, folder: string): ProjectSkill {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  let name = folder;
  let description = "";
  if (m) {
    for (const line of m[1].split(/\r?\n/)) {
      const kv = /^(name|description):\s*(.*)$/.exec(line.trim());
      if (!kv) continue;
      const v = kv[2].trim().replace(/^["']|["']$/g, "");
      if (kv[1] === "name" && v) name = v;
      if (kv[1] === "description") description = v;
    }
  }
  return { name, description };
}

export type SkillFs = Pick<FsApi, "list" | "read">;

export async function scanProjectSkills(fs: SkillFs): Promise<ProjectSkill[]> {
  let entries: Awaited<ReturnType<SkillFs["list"]>>["entries"];
  try {
    entries = (await fs.list(".claude/skills")).entries;
  } catch {
    return [];
  }
  const out: ProjectSkill[] = [];
  for (const e of entries) {
    if (e.kind !== "dir" || e.hidden) continue;
    try {
      const r = await fs.read(`.claude/skills/${e.name}/SKILL.md`, 200_000);
      if (r.status !== "ok" || r.text === null) continue;
      const skill = parseSkillManifest(r.text, e.name);
      if (isOfferableSkillName(skill.name) && !EXCLUDED_SKILL_NAMES.has(e.name)) out.push(skill);
    } catch {
      // A folder without a readable manifest is not a skill.
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}
