// Sources -> Issue (`issues.from_notes`, Task 9): files each meeting action item as an issue on a repository already on
// the Issues board. The durable record (issue_source_links, migration 0077) keeps a re-run or a core restart from filing
// an action twice; the writer's in-memory key only covers a concurrent double click. No model is called, so no usage
// row is written and no USD cap applies. The result carries counts and issue numbers only, never a URL or a title.
import { createHash } from 'node:crypto';
import * as kb from '../../kb/db.mjs';
import { getSecret } from '../../server/vault.mjs';
import { findIssueLink, recordIssueLink } from '../../kb/issue-source-links.mjs';
import { createIssue, repoOnBoard, parseIssueWrite, ISSUE_LIMITS, NAME } from '../issue-writer.mjs';

export const MAX_CREATES_PER_RUN = 20; // the bus `issueIds` cap (schema/bus/registry.json)
const SINCE_RE = /^\d{4}-\d{2}-\d{2}$/;
const sha = (s) => createHash('sha256').update(s).digest('hex');

// The collaborators; a test replaces them through `deps`, the route and the bus use these.
const DEFAULT_DEPS = Object.freeze({
  searchActions: (userId, projectId) => kb.search(userId, { kind: 'action', projectId, limit: 500, maxCap: 500 }),
  createIssue,
  isOnBoard: repoOnBoard,
  getToken: (userId, provider) => getSecret(kb.getDb(), userId, `${provider}.token`),
});

const refused = (code, summary) => ({ ok: false, code, summary, created: 0, skipped: 0, issues: [] });

/**
 * File the action items of one project. `args` = { provider, repo, since? }. Returns
 * { ok, summary, code?, created, skipped, issues }; a provider failure stops the run with its typed code.
 */
export async function runIssuesFromNotes({ userId, projectId = null, args = {}, signal, deps = {} }) {
  const d = { ...DEFAULT_DEPS, ...deps };
  const { provider, repo, since } = args;
  const probe = parseIssueWrite('create', { provider, repo, title: 'probe', idem: '0'.repeat(16) });
  if (probe.error) return refused('TASK_BAD_ARG', `provider or repo is not valid (${probe.error.details?.field ?? 'input'}).`);
  if (since !== undefined && !SINCE_RE.test(since)) return refused('TASK_BAD_ARG', 'since must be a date (YYYY-MM-DD).');
  if (!projectId) return refused('PROJECT_REQUIRED', 'This task runs on a registered project.');
  if (!(await d.isOnBoard(userId, provider, repo))) {
    return refused('REPO_NOT_ALLOWED', 'Only repositories on your Issues board can get new issues. Import this repository first.');
  }
  const token = await d.getToken(userId, provider);
  if (!token) return refused(`${provider.toUpperCase()}_TOKEN_MISSING`, `Add a ${NAME[provider]} token in Settings → Built-in keys first.`);

  const actions = await d.searchActions(userId, projectId);
  let created = 0;
  let skipped = 0;
  const issues = [];
  let failure = null;
  for (const a of actions) {
    if (signal?.aborted) { failure = { code: 'cancelled', message: 'The run was cancelled.' }; break; }
    const text = typeof a.title === 'string' ? a.title.trim() : '';
    const date = typeof a.date === 'string' ? a.date.slice(0, 10) : '';
    if (!text || (since && date < since)) continue;
    const sourceRef = `meeting:${a.meetingId}/action:${a.entityId}`;
    const key = { provider, repo, sourceRef, textHash: sha(text) };
    if (findIssueLink(userId, key)) { skipped += 1; continue; }
    if (created >= MAX_CREATES_PER_RUN) { skipped += 1; continue; }
    const title = text.split('\n')[0].slice(0, ISSUE_LIMITS.title);
    const body = `${text}\n\nSource: ${a.meetingTitle ?? 'meeting'} (${date || 'undated'}), ${sourceRef}`.slice(0, ISSUE_LIMITS.body);
    const idem = sha(['issues.from_notes', provider, repo, sourceRef, key.textHash].join('\0')).slice(0, 32);
    const res = await d.createIssue({ userId, provider, repo, title, body, idem, token });
    if (res.status !== 200) {
      failure = { code: res.body?.error?.code ?? 'TASK_FAILED', message: res.body?.error?.message ?? 'The issue could not be created.' };
      break;
    }
    recordIssueLink(userId, { ...key, issueNumber: res.number ?? null, issueUrl: res.body?.url ?? null });
    if (res.body?.deduped) { skipped += 1; continue; }
    created += 1;
    if (res.number != null) issues.push(res.number);
  }
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const summary = failure?.code === 'cancelled'
    ? `Cancelled after ${plural(created, 'issue')}.`
    : failure
      ? `Created ${plural(created, 'issue')} before a failure: ${failure.message}`
      : `Created ${plural(created, 'issue')}; skipped ${plural(skipped, 'duplicate')}.`;
  return { ok: !failure, summary, ...(failure ? { code: failure.code } : {}), created, skipped, issues };
}
