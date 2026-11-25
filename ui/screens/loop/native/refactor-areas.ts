// The Refactoring area roadmap contract, checked by code (the planner prompt only asks for it): REFACTOR-AREAS.md beside
// REFACTOR.md holds one `### A<n> <path> (status: todo|active|done)` heading per area, exactly one area is active, and todo
// batches name only that area. Pure: the Plan Check stage reads the two files and fails the run with these sentences.
const AREA = /^###\s+A(\d+)\s+(.*?)\s*\(status:\s*(\w+)\)\s*$/;
const BATCH = /^###\s+(R\d+)\b.*\(status:\s*todo\)\s*$/;
const norm = (s: string) => s.trim().replace(/`/g, "").trim().replace(/^\.\//, "").replace(/\/+$/, "");

interface Section { head: string; body: string[] }
/** The `###` sections of a text whose heading matches `is`; a section runs to the next heading of any level. */
function sections(text: string, is: (line: string) => boolean): Section[] {
  const out: Section[] = [];
  let cur: Section | null = null;
  for (const line of text.split("\n")) {
    if (/^#{1,6}\s/.test(line)) { cur = is(line) ? { head: line, body: [] } : null; if (cur) out.push(cur); } else cur?.body.push(line);
  }
  return out;
}
const field = (s: Section, name: string) => s.body.find((l) => l.startsWith(`- ${name}:`))?.slice(name.length + 3).trim();

/** The contract in one sentence, added to a failure so whoever repairs the plan knows the target format. */
export const ROADMAP_CONTRACT = "REFACTOR-AREAS.md beside the plan holds one heading per area, `### A<n> <area path> (status: todo|active|done)`; exactly one area is active; every todo batch has `- Area: <the active area's path>` and files inside it; a done area has a `- Done: <reason>` line; when every area is done the plan begins with `All areas are done.` and has no todo batch.";

/**
 * `wholeRepo` is false when the loop's Input is narrowed to a file or folder: such a plan may be a single area, for
 * which the planner writes no roadmap and no `- Area:` lines.
 */
export function checkRoadmap(planText: string, roadmapText: string | null, wholeRepo = true): string[] {
  const batches = sections(planText, (l) => BATCH.test(l)).map((s) => ({ id: BATCH.exec(s.head)![1], area: field(s, "Area"), files: [...(field(s, "Files") ?? "").matchAll(/`([^`]+)`/g)].map((m) => norm(m[1])) }));
  // The marker follows the plan's frontmatter, so it is looked for in the first lines, not the first line.
  const allDone = /^All areas are done\./m.test(planText.split("\n").slice(0, 15).join("\n"));
  // A plan with no `- Area:` line on any todo batch is not divided into areas (a single file or a single area): there
  // is nothing to enforce, even when a roadmap from an earlier whole-repository plan is still on disk.
  if (batches.length > 0 && batches.every((b) => !b.area)) return [];
  if (roadmapText === null) {
    const areas = new Set(batches.flatMap((b) => (b.area ? [norm(b.area)] : [])));
    return wholeRepo && areas.size >= 2 ? ["the plan names several areas but has no REFACTOR-AREAS.md"] : [];
  }
  const problems: string[] = [];
  const areas: { id: string; path: string; status: string; sec: Section }[] = [];
  for (const sec of sections(roadmapText, (l) => /^###\s+A/.test(l))) {
    const m = AREA.exec(sec.head);
    if (!m) problems.push(`the area heading “${sec.head.trim()}” is not \`### A<n> <area path> (status: todo|active|done)\``);
    else if (!["todo", "active", "done"].includes(m[3])) problems.push(`area A${m[1]} has the invalid status “${m[3]}”`);
    // Text after a dash is a note, not part of the path.
    else areas.push({ id: `A${m[1]}`, path: norm(m[2].split(/\s+[—–-]\s+/)[0]), status: m[3], sec });
  }
  if (areas.length === 0 && problems.length === 0) problems.push("REFACTOR-AREAS.md has no `### A<n>` area heading");
  for (const id of new Set(areas.map((a) => a.id))) if (areas.filter((a) => a.id === id).length > 1) problems.push(`area ${id} appears more than once`);
  const active = areas.filter((a) => a.status === "active");
  if (active.length > 1) problems.push(`more than one area is active: ${active.map((a) => a.id).join(", ")}`);
  const open = areas.filter((a) => a.status !== "done");
  if (allDone && batches.length > 0) problems.push(`the plan says “All areas are done.” but still has todo batch ${batches.map((b) => b.id).join(", ")}`);
  if (allDone && open.length > 0) problems.push(`the plan says “All areas are done.” but ${open.map((a) => `${a.id} is ${a.status}`).join(", ")}`);
  else if (open.length > 0 && active.length === 0) problems.push(`no area is active although ${open.map((a) => a.id).join(", ")} is not done`);
  for (const a of areas) if (a.status === "done" && field(a.sec, "Done") === undefined) problems.push(`done area ${a.id} has no \`- Done:\` line`);
  if (active.length === 1) {
    const path = active[0].path;
    const inside = (p: string) => path === "." || p === path || p.startsWith(`${path}/`);
    // `- Area: A1` and `- Area: A1 src/billing` name the area by its ID.
    const named = (area: string) => { const m = /^(A\d+)\b\s*(.*)$/.exec(norm(area)); return m ? (m[1] === active[0].id ? path : m[2] || m[1]) : norm(area); };
    for (const b of batches) {
      if (!b.area) problems.push(`todo batch ${b.id} has no \`- Area:\` line`);
      else if (!inside(named(b.area))) problems.push(`todo batch ${b.id} is in area ${norm(b.area)}, but the active area is ${active[0].id} ${path}`);
      // A batch may also touch tests or build config elsewhere, but not be wholly outside the area it claims.
      else if (b.files.length > 0 && !b.files.some(inside)) problems.push(`todo batch ${b.id} names the active area but none of its files is under ${path}`);
    }
  } else if (!allDone) for (const b of batches) problems.push(`todo batch ${b.id} cannot be placed: there is no single active area`);
  return problems;
}
