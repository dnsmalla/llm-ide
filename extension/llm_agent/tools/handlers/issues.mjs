// Agent tools for hosted issues. They reuse the same board check, vault token, parser and provider call as
// routes/issue-writes.mjs, so a tool cannot reach a repository the Issues board would refuse.
import * as kb from '../../../kb/db.mjs';
import { getSecret } from '../../../server/vault.mjs';
import { safeAudit } from '../../../server/route-http.mjs';
import { authorizeAction } from '../../../server/route-authority.mjs';
import { NAME, callProvider, onceForIdem, parseIssueWrite, recordCreatedIssue, repoOnBoard, WEB_ORIGIN } from '../../../server/issue-writer.mjs';

const PROVIDERS = new Set(['github', 'gitlab']);
const idem = () => `tool-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`.slice(0, 64);

function prep(args, ctx) {
  const provider = args?.provider;
  const repo = args?.repo;
  if (!PROVIDERS.has(provider) || typeof repo !== 'string' || !repo) return { error: 'provider and repo are required' };
  const projectId = ctx?.agentContext?.projectId ?? null;
  if (projectId) {
    const decision = authorizeAction(kb.getDb(), ctx.userId, 'external.write', { projectId });
    if (!decision.ok) return { error: `${decision.code}: ${decision.message}` };
  }
  const db = kb.getDb();
  if (!repoOnBoard(ctx.userId, provider, repo)) return { error: `${repo} is not on your Issues board; import the repository first` };
  const token = getSecret(db, ctx.userId, `${provider}.token`);
  if (!token) return { error: `Add a ${NAME[provider]} token in Settings → Built-in keys first` };
  return { db, provider, repo, token };
}

export async function handleIssueCreate(args, ctx) {
  const p = prep(args, ctx);
  if (p.error) return { error: p.error };
  const w = parseIssueWrite('create', {
    provider: p.provider, repo: p.repo,
    title: args.title, body: args.body ?? '', idem: typeof args.idem === 'string' ? args.idem : idem(),
  });
  if (w.error) return { error: w.error.error?.message ?? 'invalid issue' };
  const out = await onceForIdem(ctx.userId, w, () => callProvider(w, p.token));
  if (out.status === 200) recordCreatedIssue(ctx.userId, w, out);
  safeAudit(p.db, { userId: ctx.userId, ip: null, userAgent: null, action: 'issues.create', resource: `${w.provider}:${w.repo}`, outcome: out.status === 200 ? 'success' : 'failure', detail: { via: 'agent-tool', status: out.status } });
  if (out.status !== 200) return { error: out.body?.error?.message ?? `${NAME[w.provider]} answered ${out.status}` };
  return { ok: true, provider: w.provider, repo: w.repo, number: out.number, url: out.body.url, deduped: out.body.deduped === true };
}

export async function handleIssueComment(args, ctx) {
  const p = prep(args, ctx);
  if (p.error) return { error: p.error };
  const w = parseIssueWrite('comment', { provider: p.provider, repo: p.repo, number: args.number, body: args.body });
  if (w.error) return { error: w.error.error?.message ?? 'invalid comment' };
  if (!kb.findTicket(ctx.userId, { provider: w.provider, repo: w.repo, number: w.number, origin: WEB_ORIGIN[w.provider] })) {
    return { error: `issue ${w.provider}:${w.repo}#${w.number} is not on your Issues board` };
  }
  const out = await callProvider(w, p.token);
  safeAudit(p.db, { userId: ctx.userId, ip: null, userAgent: null, action: 'issues.comment', resource: `${w.provider}:${w.repo}#${w.number}`, outcome: out.status === 200 ? 'success' : 'failure', detail: { via: 'agent-tool', status: out.status } });
  if (out.status !== 200) return { error: out.body?.error?.message ?? `${NAME[w.provider]} answered ${out.status}` };
  return { ok: true, provider: w.provider, repo: w.repo, number: w.number, url: out.body.url };
}
