// The Refactoring area roadmap contract, checked by code (the planner prompt only asks for it): REFACTOR-AREAS.md beside
// REFACTOR.md holds one `### A<n> <path> (status: todo|active|done)` heading per area, exactly one area is active, and todo
// batches name only that area. Pure: the Plan Check stage reads the two files and fails the run with these sentences.
const AREA = /^###\s+A(\d+)\s+(.*?)\s*\(status:\s*(\w+)\)\s*$/;
const BATCH = /^###\s+(R\d+)\b.*\(status:\s*todo\)\s*$/;
const norm = (s: string) => s.trim().replace(/`/g, "").trim().replace(/\/+$/, "");

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

export function checkRoadmap(planText: string, roadmapText: string | null): string[] {
  const batches = sections(planText, (l) => BATCH.test(l)).map((s) => ({ id: BATCH.exec(s.head)![1], area: field(s, "Area") }));
  const allDone = /^All areas are done\./m.test(planText.split("\n").slice(0, 6).join("\n"));
  if (roadmapText === null) {
    const areas = new Set(batches.flatMap((b) => (b.area ? [norm(b.area)] : [])));
    return areas.size >= 2 ? ["the plan names several areas but has no REFACTOR-AREAS.md"] : [];
  }
  const problems: string[] = [];
  const areas: { id: string; path: string; status: string; sec: Section }[] = [];
  for (const sec of sections(roadmapText, (l) => /^###\s+A/.test(l))) {
    const m = AREA.exec(sec.head);
    if (!m) problems.push(`the area heading “${sec.head.trim()}” is not \`### A<n> <area path> (status: todo|active|done)\``);
    else if (!["todo", "active", "done"].includes(m[3])) problems.push(`area A${m[1]} has the invalid status “${m[3]}”`);
    else areas.push({ id: `A${m[1]}`, path: norm(m[2]), status: m[3], sec });
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
    for (const b of batches) {
      if (!b.area) problems.push(`todo batch ${b.id} has no \`- Area:\` line`);
      else if (norm(b.area) !== path && !norm(b.area).startsWith(`${path}/`)) problems.push(`todo batch ${b.id} is in area ${norm(b.area)}, but the active area is ${active[0].id} ${path}`);
    }
  } else if (!allDone) for (const b of batches) problems.push(`todo batch ${b.id} cannot be placed: there is no single active area`);
  return problems;
}
