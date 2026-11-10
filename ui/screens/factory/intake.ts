// Work items entering the Factory: from Issues, from `llm-doc/` specs and as free text. Batch intake runs only the
// Intake stage, so Needs decision fills before any code is written. Phase A's `factory.ts` exports functions with the
// SAME names (`workItemFromIssue`, `workItemFromSpec`, `workItemFromText`, `listSpecFiles`) that return Phase A's
// `WorkItem`; these return `WorkItemRecord` and are separate on purpose. Do not import the Phase A ones here.
import type { FsApi } from "../explorer/fs";
import type { Issue } from "../issues/issues-model.ts";
import type { WorkItem } from "../loop/native/factory.ts";
import type { RunMode } from "../loop/native/run-manager.ts";
import { safeRelativePath } from "../shell/bus.ts";
import type { ItemFacts } from "./columns.ts";
import { addItem, attachRun, newWorkItem, type ItemsFs, type WorkItemRecord } from "./items.ts";
import type { StartRunFn } from "./send-back.ts";

export const SPEC_ROOT = "llm-doc";
const SPEC_SKIP = `${SPEC_ROOT}/factory`; // the app's own readiness copies (Phase A Task 12)

/** An issue as a work item: its key is provider, repo and number, so the same number in two repos stays two items. */
export function workItemFromIssue(issue: Pick<Issue, "id" | "provider" | "repo" | "number" | "title" | "body" | "url">, now: Date = new Date()): WorkItemRecord {
  const ref = issue.number !== null ? String(issue.number) : issue.id;
  return newWorkItem({
    source: "issue",
    id: `${issue.provider}:${issue.repo}#${ref}`,
    title: issue.number !== null ? `#${issue.number} ${issue.title}` : issue.title,
    body: issue.url ? `${issue.body}\n\nIssue: ${issue.url}` : issue.body,
    repo: issue.repo || null,
    provider: issue.provider === "github" || issue.provider === "gitlab" ? issue.provider : null,
  }, now);
}

/** A spec under `llm-doc/`, titled by its first heading (else its file name). Anything outside llm-doc/ is refused. */
export function workItemFromSpec(path: string, text: string, now: Date = new Date()): WorkItemRecord {
  const safe = safeRelativePath(path);
  if (safe === null || !safe.startsWith(`${SPEC_ROOT}/`) || !safe.endsWith(".md")) throw new Error(`A spec must be a .md file under ${SPEC_ROOT}/.`);
  const heading = /^#\s+(.+)$/m.exec(text)?.[1]?.trim();
  const base = safe.slice(safe.lastIndexOf("/") + 1).replace(/\.md$/, "");
  return newWorkItem({ source: "spec", id: safe, title: heading || base, body: text, repo: null }, now);
}

export function workItemFromText(title: string, body: string, now: Date = new Date(), rand: () => number = Math.random): WorkItemRecord {
  return newWorkItem({ source: "text", id: null, title, body, repo: null }, now, rand);
}

/** Stores every item, then (optionally) starts an intake-only run for each NEW one; runs queue under the cap. */
export async function sendToFactory(fs: ItemsFs, items: WorkItemRecord[], opts: { runIntake: boolean; projectRoot: string; start: StartRunFn }): Promise<{ added: number; existing: string[] }> {
  const existing: string[] = [];
  const fresh: WorkItemRecord[] = [];
  for (const item of items) {
    const r = await addItem(fs, item);
    if (r.existed) existing.push(r.record.key);
    else fresh.push(r.record);
  }
  // Every item is stored before any run starts; the run manager queues runs beyond the concurrency cap.
  if (opts.runIntake) {
    for (const record of fresh) {
      const runId = opts.start(opts.projectRoot, record, "intakeOnly");
      await attachRun(fs, record.key, runId);
    }
  }
  return { added: fresh.length, existing };
}

/**
 * Puts a Loop-page Factory run on the board: its work item is stored (an item with the same source and id is reused)
 * and the run id attached. Returns the board key, or the error to log. It never throws, so a failed board write
 * cannot stop or fail the run.
 */
export async function putRunOnBoard(fs: ItemsFs, item: WorkItem, runId: string): Promise<{ key: string } | { error: string }> {
  try {
    // An issue's board id is provider:repo#number, the key workItemFromIssue writes, so both screens reach one card.
    const id = item.source === "issue" && item.provider && item.repo && item.id ? `${item.provider}:${item.repo}#${item.id}` : item.id;
    const { record } = await addItem(fs, newWorkItem({ source: item.source, id, title: item.title, body: item.body, repo: item.repo, provider: item.provider ?? null }));
    await attachRun(fs, record.key, runId);
    return { key: record.key };
  } catch (e) {
    return { error: `The run is not on the Factory board: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** What Start, Run intake and Resume do with a card: a fresh run, a reuse of its worktree, or a continue after intake. */
export function runPlanFor(action: "start" | "intake" | "resume", item: WorkItemRecord, facts: ItemFacts): { mode: RunMode; runId?: string } {
  const last = item.runIds.at(-1) ?? null;
  const reusable = last !== null && facts.worktreeExists;
  if (action === "intake") return reusable ? { mode: "intakeOnly", runId: last } : { mode: "intakeOnly" };
  const intakeReady = facts.lastRecord?.mode === "intakeOnly" && facts.lastRecord.statusCode === "success" && facts.lastRecord.runId === last;
  if (action === "resume") return reusable ? { mode: intakeReady ? "continue" : "full", runId: last } : { mode: "full" };
  return reusable && intakeReady ? { mode: "continue", runId: last } : { mode: "full" };
}

/** The notice for a send, counting what was already there. */
export function sendSummary(added: number, existing: number): string {
  if (added === 0 && existing === 0) return "Nothing to send.";
  if (added === 0) return existing === 1 ? "Already in the Factory." : `All ${existing} are already in the Factory.`;
  const base = `Sent ${added} item${added === 1 ? "" : "s"} to the Factory`;
  return existing > 0 ? `${base} (${existing} already there).` : `${base}.`;
}

/** Markdown files under `llm-doc/` (the readiness copies skipped), sorted, at most `max`. */
export async function listSpecFiles(fs: Pick<FsApi, "list">, max = 200): Promise<string[]> {
  const out: string[] = [];
  const queue: { path: string; depth: number }[] = [{ path: SPEC_ROOT, depth: 0 }];
  while (queue.length > 0 && out.length < max) {
    const { path, depth } = queue.shift()!;
    let entries;
    try { entries = (await fs.list(path, { show_hidden: false, limit: 300 })).entries; } catch { continue; }
    for (const e of entries) {
      const child = `${path}/${e.name}`;
      if (e.kind === "dir") {
        if (child !== SPEC_SKIP && depth < 3) queue.push({ path: child, depth: depth + 1 });
      } else if (e.kind === "file" && e.name.endsWith(".md") && out.length < max) {
        out.push(child);
      }
    }
  }
  return out.sort();
}
