// The folders an Auto Task's input or output may point at, mirroring the Mac's AutoTaskFolderCatalog: the project's
// Library roots and the directories inside them, as project-relative paths. Directories only, so an output folder
// that has no files yet is still offered. Read-only: it lists, it never creates or writes.
import type { SkillFs } from "./skills.ts";

export const LIBRARY_ROOTS: readonly string[] = ["source", "code", "data", "llm-doc"];
/** How deep below a Library root to descend (a root itself is depth 1), as on the Mac. */
export const FOLDER_MAX_DEPTH = 4;
/** Upper bound on returned paths, so a large repo cannot make the picker unusable. */
export const FOLDER_MAX_RESULTS = 400;

export interface LibraryFolder { path: string; root: string; depth: number }

export async function scanLibraryFolders(fs: Pick<SkillFs, "list">): Promise<LibraryFolder[]> {
  const out: LibraryFolder[] = [];
  const walk = async (path: string, root: string, depth: number): Promise<void> => {
    if (depth > FOLDER_MAX_DEPTH || out.length >= FOLDER_MAX_RESULTS) return;
    let entries: Awaited<ReturnType<SkillFs["list"]>>["entries"];
    try { entries = (await fs.list(path)).entries; } catch { return; }
    const dirs = entries.filter((e) => e.kind === "dir" && !e.hidden).sort((a, b) => a.name.localeCompare(b.name));
    for (const d of dirs) {
      if (out.length >= FOLDER_MAX_RESULTS) return;
      const child = `${path}/${d.name}`;
      out.push({ path: child, root, depth });
      await walk(child, root, depth + 1);
    }
  };
  for (const root of LIBRARY_ROOTS) {
    if (out.length >= FOLDER_MAX_RESULTS) break;
    let ok = false;
    try { ok = (await fs.list(root)).entries !== undefined; } catch { ok = false; }
    if (!ok) continue;
    out.push({ path: root, root, depth: 1 });
    await walk(root, root, 2);
  }
  return out.sort((a, b) => a.path.localeCompare(b.path, undefined, { sensitivity: "base" })).slice(0, FOLDER_MAX_RESULTS);
}
