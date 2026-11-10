// Picks the issue an Implement Issues run starts with. Pure: the caller passes the open issues and the Factory card keys.
import type { Issue } from "../issues/issues-model.ts";
import { workItemFromIssue } from "../factory/intake.ts";

/** The oldest open, non-PR issue with a body and no Factory card yet. `taken` holds card keys (issue:provider:repo#n). */
export function selectNextReadyIssue(issues: readonly Issue[], taken: ReadonlySet<string> = new Set()): Issue | null {
  const ready = issues.filter((i) => i.state === "open" && !i.isPR && i.body.trim() !== "" && !taken.has(workItemFromIssue(i).key));
  const byAge = (i: Issue) => i.number ?? Number.MAX_SAFE_INTEGER;
  ready.sort((a, b) => byAge(a) - byAge(b));
  return ready[0] ?? null;
}
