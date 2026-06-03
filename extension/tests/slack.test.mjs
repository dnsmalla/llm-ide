import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderPlanSummary, renderDispatchResult, renderReviewDecided } from '../agents/slack.mjs';

test('renderPlanSummary produces title, goal, count, milestones', () => {
  const text = renderPlanSummary({
    title: 'Auth Migration',
    goal: 'Ship MFA by Q3',
    tasks: [
      { title: 't1', milestone: 'Compliance', risk: 'high' },
      { title: 't2', milestone: 'Compliance', risk: 'med'  },
      { title: 't3', milestone: 'Implementation', risk: 'low' },
    ],
  });
  assert.match(text, /\*Auth Migration\*/);
  assert.match(text, /Ship MFA by Q3/);
  assert.match(text, /3 tasks/);
  assert.match(text, /1 high/);
  assert.match(text, /Compliance — 2 tasks/);
  assert.match(text, /Implementation — 1 task/);
});

test('renderPlanSummary escapes Slack control chars', () => {
  const text = renderPlanSummary({
    title: 'Foo <script>alert(1)</script>',
    goal: 'a & b',
    tasks: [{ title: 't', milestone: 'm' }],
  });
  assert.ok(!text.includes('<script>'));
  assert.match(text, /&lt;script&gt;/);
  assert.match(text, /a &amp; b/);
});

test('renderDispatchResult counts ok/error/skipped and links ok rows', () => {
  const text = renderDispatchResult({
    target: 'github',
    plan: { id: 'p', title: 'Plan' },
    results: [
      { taskId: 't1', status: 'ok',      title: 'First',   url: 'https://github.com/a/b/issues/1', number: 1 },
      { taskId: 't2', status: 'error',   title: 'Failed' },
      { taskId: 't3', status: 'skipped', title: 'Skip' },
    ],
  });
  assert.match(text, /Dispatched 1 task/);
  assert.match(text, /1 error/);
  assert.match(text, /1 skipped/);
  assert.match(text, /<https:\/\/github\.com\/a\/b\/issues\/1\|First>/);
});

test('renderReviewDecided picks emoji per status', () => {
  assert.match(renderReviewDecided({ status: 'executed', title: 'x' }), /:white_check_mark:/);
  assert.match(renderReviewDecided({ status: 'rejected', title: 'x' }), /:no_entry_sign:/);
  assert.match(renderReviewDecided({ status: 'failed',   title: 'x' }), /:warning:/);
});
