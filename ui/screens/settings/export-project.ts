// Canonical project export, ported from the Mac's ProjectExporter: meetings -> source/meetings/YYYY/MM,
// plans -> llm-doc/plans, source/_index.json, README badge and system/sync.json last. All paths are
// project-relative and go through the root-confined host fs; the webview never supplies an absolute path.
import type { FsApi } from "../explorer/fs.ts";

export interface ExportMeeting {
  id: string; title: string; date: string | null; durationSec: number | null; language: string;
  participants: string[]; transcript: string; entities: { id: string; kind: string; text: string; quote: string | null }[];
}
export interface ExportTask {
  id: string; position: number; milestone: string | null; title: string; description: string | null;
  owner: string | null; due: string | null; estimateDays: number | null; dependsOn: string[];
  status: string; risk: string | null; riskReason: string | null;
}
export interface ExportPlan {
  id: string; meetingId: string | null; title: string; goal: string; language: string;
  createdAt: string | null; updatedAt: string | null; tasks: ExportTask[];
}
export interface ExportBundle { exportedAt: string; meetings: ExportMeeting[]; plans: ExportPlan[] }

export interface ExportFile { path: string; text: string }
export interface ExportResult { meetings: number; plans: number; plansWriteFailed: boolean }

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, max = 100_000): string => (typeof v === "string" ? v.slice(0, max) : "");
const strOrNull = (v: unknown, max = 10_000): string | null => (typeof v === "string" ? v.slice(0, max) : null);
const intOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) ? v : null);
const strings = (v: unknown, max: number): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, max) : []);

/** Defensive decode of GET /kb/project/:id/export. Bad rows are dropped; a non-object body returns null. */
export function decodeExportBundle(raw: unknown): ExportBundle | null {
  if (!isRecord(raw) || !Array.isArray(raw.meetings) || !Array.isArray(raw.plans)) return null;
  const meetings: ExportMeeting[] = [];
  for (const m of Array.isArray(raw.meetings) ? raw.meetings : []) {
    if (!isRecord(m) || typeof m.id !== "string" || !m.id) continue;
    meetings.push({
      id: str(m.id, 200), title: str(m.title, 500) || "(untitled)", date: strOrNull(m.date, 40),
      durationSec: intOrNull(m.durationSec), language: str(m.language, 20) || "en",
      participants: strings(m.participants, 200), transcript: str(m.transcript, 5_000_000),
      entities: (Array.isArray(m.entities) ? m.entities : []).filter(isRecord).map((e) => ({
        id: str(e.id, 200), kind: str(e.kind, 40), text: str(e.text, 20_000), quote: strOrNull(e.quote, 20_000),
      })).slice(0, 2000),
    });
    if (meetings.length >= 2000) break;
  }
  const plans: ExportPlan[] = [];
  for (const p of Array.isArray(raw.plans) ? raw.plans : []) {
    if (!isRecord(p) || typeof p.id !== "string" || !p.id) continue;
    plans.push({
      id: str(p.id, 200), meetingId: strOrNull(p.meetingId, 200), title: str(p.title, 500) || "(untitled)",
      goal: str(p.goal, 100_000), language: str(p.language, 20) || "en",
      createdAt: strOrNull(p.createdAt, 40), updatedAt: strOrNull(p.updatedAt, 40),
      tasks: (Array.isArray(p.tasks) ? p.tasks : []).filter(isRecord).map((t, i) => ({
        id: str(t.id, 200), position: intOrNull(t.position) ?? i, milestone: strOrNull(t.milestone, 200),
        title: str(t.title, 500), description: strOrNull(t.description, 20_000), owner: strOrNull(t.owner, 200),
        due: strOrNull(t.due, 40), estimateDays: intOrNull(t.estimateDays), dependsOn: strings(t.dependsOn, 100),
        status: str(t.status, 40) || "planned", risk: strOrNull(t.risk, 40), riskReason: strOrNull(t.riskReason, 500),
      })).slice(0, 2000),
    });
    if (plans.length >= 2000) break;
  }
  return { exportedAt: str(raw.exportedAt, 40), meetings, plans };
}

const yaml = (s: string): string => `"${s.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n").replaceAll("\r", "\\r").replaceAll("\t", "\\t")}"`;
const escapeMd = (s: string): string => s.replace(/[\\`*_{}[\]()#+!|]/g, (c) => `\\${c}`);
function longestBackticks(s: string): number {
  let max = 0, cur = 0;
  for (const c of s) { if (c === "`") { cur += 1; if (cur > max) max = cur; } else cur = 0; }
  return max;
}

/** Lowercase, whitespace -> hyphen, unsafe/control characters dropped, Unicode letters kept. */
export function slugify(title: string, id: string, maxLength = 40): string {
  let s = title.toLowerCase().split(/\s+/).filter(Boolean).join("-");
  s = Array.from(s).filter((c) => !/[/\\:*?"<>|]/.test(c) && !/[\u0000-\u001f\u007f]/.test(c)).join("");
  s = s.replace(/-+/g, "-").replace(/^-|-$/g, "");
  if (Array.from(s).length > maxLength) s = Array.from(s).slice(0, maxLength).join("").replace(/-+$/g, "");
  if (!s) s = "untitled";
  const suffix = Array.from(id.slice(-8)).filter((c) => !/[/\\:*?"<>|]/.test(c) && !/[\u0000-\u001f\u007f]/.test(c)).join("") || "unknown";
  return `${s}-${suffix}`;
}

function validDate(iso: string | null): Date | null {
  if (!iso) return null;
  const text = iso.slice(0, 10);
  const d = new Date(`${text}T00:00:00Z`);
  // Reject rollovers such as 2026-02-30.
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === text ? d : null;
}
function datePrefix(iso: string | null): string {
  const d = validDate(iso);
  if (!d) return "0000-00-00";
  return d.toISOString().slice(0, 10);
}
function yearMonth(iso: string | null): [string, string] {
  const d = validDate(iso);
  return d ? [d.toISOString().slice(0, 4), d.toISOString().slice(5, 7)] : ["0000", "00"];
}
function duration(sec: number | null): string {
  if (sec === null || sec <= 0) return "unknown";
  return `${Math.floor(sec / 60)}m ${sec % 60}s`;
}

export function meetingMarkdown(m: ExportMeeting, projectId: string): string {
  const participants = m.participants.map((p) => `  - ${yaml(p)}`).join("\n");
  let md = `---\nid: ${yaml(m.id)}\ntitle: ${yaml(m.title)}\ndate: ${m.date ?? "unknown"}\nduration: ${duration(m.durationSec)}\nlanguage: ${m.language}\nprojectId: ${yaml(projectId)}\nparticipants:\n${participants || "  []"}\n---\n\n# ${m.title}\n\n`;
  const actions = m.entities.filter((e) => e.kind === "action");
  const decisions = m.entities.filter((e) => e.kind === "decision");
  const blockers = m.entities.filter((e) => e.kind === "blocker");
  if (actions.length || decisions.length || blockers.length) {
    md += "## Summary\n\n";
    if (actions.length) md += `### Action Items\n\n${actions.map((a) => `- [ ] ${escapeMd(a.text)}${a.quote ? `\n  > ${a.quote.replaceAll("\n", "\n  > ")}` : ""}`).join("\n")}\n\n`;
    if (decisions.length) md += `### Decisions\n\n${decisions.map((d) => `- ${escapeMd(d.text)}${d.quote ? `\n  > ${d.quote.replaceAll("\n", "\n  > ")}` : ""}`).join("\n")}\n\n`;
    if (blockers.length) md += `### Blockers\n\n${blockers.map((b) => `- ⚠️ ${escapeMd(b.text)}${b.quote ? `\n  > ${b.quote.replaceAll("\n", "\n  > ")}` : ""}`).join("\n")}\n\n`;
  }
  if (m.transcript) {
    const fence = "`".repeat(Math.max(3, longestBackticks(m.transcript) + 1));
    md += `## Transcript\n\n${fence}text\n${m.transcript}${m.transcript.endsWith("\n") ? "" : "\n"}${fence}\n`;
  }
  return md;
}

function taskLine(t: ExportTask): string {
  const box = t.status === "done" ? "- [x]" : t.status === "cancelled" ? "- [-]" : "- [ ]";
  let line = `${box} ${escapeMd(t.title)}${t.status === "blocked" ? " ⚠️" : t.status === "in_progress" ? " 🔄" : ""}`;
  const detail = [`Status: ${t.status}`];
  if (t.milestone) detail.push(`Milestone: ${escapeMd(t.milestone)}`);
  if (t.owner) detail.push(`Owner: ${escapeMd(t.owner)}`);
  if (t.due) detail.push(`Due: ${escapeMd(t.due)}`);
  if (t.estimateDays !== null) detail.push(`Estimate: ${t.estimateDays}d`);
  if (t.dependsOn.length) detail.push(`Depends on: ${t.dependsOn.join(", ")}`);
  if (t.risk) detail.push(`Risk: ${escapeMd(t.risk)}${t.riskReason ? ` — ${escapeMd(t.riskReason)}` : ""}`);
  if (t.description) detail.push(escapeMd(t.description));
  for (const d of detail) line += `\n  - ${d}`;
  return line;
}

export function planMarkdown(plan: ExportPlan, nowIso: string): string {
  const lines = ["---", `id: ${yaml(plan.id)}`, `title: ${yaml(plan.title)}`, `language: ${yaml(plan.language)}`];
  if (plan.meetingId) lines.push(`meetingId: ${yaml(plan.meetingId)}`);
  if (plan.createdAt) lines.push(`createdAt: ${yaml(plan.createdAt)}`);
  if (plan.updatedAt) lines.push(`updatedAt: ${yaml(plan.updatedAt)}`);
  lines.push(`exportedAt: ${yaml(nowIso)}`, "---", "", `# ${escapeMd(plan.title)}`, "", "**Goal**", "", plan.goal, "");
  const tasks = [...plan.tasks].sort((a, b) => a.position - b.position);
  if (!tasks.length) lines.push("_No tasks._");
  else lines.push("## Tasks", "", ...tasks.map(taskLine));
  return `${lines.join("\n")}\n`;
}

export function planPath(plan: ExportPlan): string {
  return `llm-doc/plans/${datePrefix(plan.createdAt)}-${slugify(plan.title, plan.id)}.md`;
}

function meetingFiles(bundle: ExportBundle, projectId: string, nowIso: string): { files: ExportFile[]; index: ExportFile } {
  const entries: { id: string; title: string; date: string; path: string }[] = [];
  const files: ExportFile[] = [];
  for (const m of bundle.meetings) {
    const [year, month] = yearMonth(m.date);
    const filename = `${datePrefix(m.date)}-${slugify(m.title, m.id)}.md`;
    const rel = `source/meetings/${year}/${month}/${filename}`;
    files.push({ path: rel, text: meetingMarkdown(m, projectId) });
    entries.push({ id: m.id, title: m.title, date: m.date ?? "", path: rel });
  }
  const index = { generatedAt: nowIso, count: entries.length, meetings: entries };
  return { files, index: { path: "source/_index.json", text: `${JSON.stringify(index, null, 2)}\n` } };
}

/** Existing README + badge, or null when the README is user-authored (no llmide marker). */
export function addReadmeBadge(existing: string | null, nowIso: string, meetings: number): string | null {
  if (existing === null) return null;
  if (!existing.split("\n").some((l) => l.startsWith("<!-- llmide:auto") || l.startsWith("<!-- meetnotes:auto"))) return null;
  const badge = `**Last exported:** ${nowIso} — ${meetings} meeting(s)`;
  if (existing.includes("**Last exported:**")) return existing.split("\n").map((l) => l.startsWith("**Last exported:**") ? badge : l).join("\n");
  return `${existing}\n---\n${badge}\n`;
}

async function ensureDir(fs: FsApi, path: string): Promise<void> {
  let current = "";
  for (const part of path.split("/").filter(Boolean)) {
    current = current ? `${current}/${part}` : part;
    try { await fs.create(current, "dir"); } catch (e) { if ((e as { code?: unknown }).code !== "exists") throw e; }
  }
}

async function writeFile(fs: FsApi, path: string, text: string): Promise<void> {
  await fs.write(path, text, { expected_hash: null, force: true });
}

async function readMaybe(fs: FsApi, path: string): Promise<string | null> {
  try { const r = await fs.read(path, 10_000_000); return r.status === "ok" ? r.text : null; } catch { return null; }
}

async function writePlans(fs: FsApi, bundle: ExportBundle, nowIso: string): Promise<number> {
  if (!bundle.plans.length) return 0;
  await ensureDir(fs, "llm-doc/plans");
  let existing: string[] = [];
  try { existing = (await fs.list("llm-doc/plans", { limit: 2000 })).entries.filter((e) => e.kind === "file").map((e) => e.name); } catch { /* new folder */ }
  let written = 0;
  for (const plan of bundle.plans) {
    const target = planPath(plan);
    const name = target.slice(target.lastIndexOf("/") + 1);
    const suffix = `-${plan.id.slice(-8)}.md`;
    await writeFile(fs, target, planMarkdown(plan, nowIso));
    // Remove a renamed plan's old file only once its new copy is safely written.
    for (const old of existing) if (old.endsWith(suffix) && old !== name) { try { await fs.remove(`llm-doc/plans/${old}`); } catch { /* best effort */ } }
    written += 1;
  }
  return written;
}

/** Write the canonical export. `plansOnly` mirrors the Mac's Save Plans command (no meetings/readme/sync). */
export async function runProjectExport({ bundle, projectId, fs, nowIso, plansOnly = false }: { bundle: ExportBundle; projectId: string; fs: FsApi; nowIso: string; plansOnly?: boolean }): Promise<ExportResult> {
  let plans = 0;
  let plansWriteFailed = false;
  try { plans = await writePlans(fs, bundle, nowIso); }
  catch (e) { if (plansOnly) throw e; plansWriteFailed = true; }
  if (plansOnly) return { meetings: 0, plans, plansWriteFailed };
  const { files, index } = meetingFiles(bundle, projectId, nowIso);
  for (const f of files) {
    const dir = f.path.slice(0, f.path.lastIndexOf("/"));
    await ensureDir(fs, dir);
    await writeFile(fs, f.path, f.text);
  }
  await ensureDir(fs, "source");
  await writeFile(fs, index.path, index.text);
  try {
    const readme = addReadmeBadge(await readMaybe(fs, "README.md"), nowIso, bundle.meetings.length);
    if (readme !== null) await writeFile(fs, "README.md", readme);
  } catch { /* the Mac treats the badge as best-effort and still writes sync.json */ }
  await ensureDir(fs, "system");
  const sync = { exportedAt: nowIso, meetingsExported: bundle.meetings.length, plansExported: plans, backendExportedAt: bundle.exportedAt };
  await writeFile(fs, "system/sync.json", `${JSON.stringify(sync, null, 2)}\n`);
  return { meetings: bundle.meetings.length, plans, plansWriteFailed };
}
