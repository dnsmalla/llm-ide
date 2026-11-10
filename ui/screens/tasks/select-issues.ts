export interface IssueRow { id: string; number: number | null; title: string; body: string; state: string; isPR: boolean; labels?: unknown }

/** The oldest open, non-PR issue with a body that has no Factory card yet; null when none is ready. */
export function selectNextReadyIssue(issues: readonly IssueRow[], taken: ReadonlySet<string> = new Set()): IssueRow | null {
  const ready = issues
    .filter((i) => !i.isPR && i.state === "open" && typeof i.body === "string" && i.body.trim() !== "" && !taken.has(`issue:${i.id}`))
    .sort((a, b) => (a.number ?? Number.MAX_SAFE_INTEGER) - (b.number ?? Number.MAX_SAFE_INTEGER) || a.id.localeCompare(b.id));
  return ready[0] ?? null;
}
