// Phase 7 — Slack delivery via Incoming Webhooks.  We use webhooks
// rather than the bot-token API because they require zero OAuth setup
// — the user pastes the URL, we POST a JSON body, done.  Webhook URLs
// embed a per-channel secret so they're "credentials" and stay in
// chrome.storage.local just like our other tokens.

import { scanForSecrets } from '../guardrails/scan.mjs';
//
// Three message templates: plan summary, dispatch result, review-decided.
// Each renders Slack mrkdwn (the looser markdown variant Slack uses for
// webhook payloads).

function asMrkdwn(text) {
  // Escape Slack's three special characters; everything else passes
  // through.  We deliberately don't strip newlines so the message stays
  // readable in the channel.
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Slack's Incoming Webhook API rejects payloads over ~4 KB in practice.
// We cap at 4096 bytes to stay well within that limit and prevent
// accidentally sending oversized notification blobs to the channel.
const MAX_WEBHOOK_PAYLOAD_SIZE = 4096;

function isWebhookUrl(raw) {
  if (typeof raw !== 'string') return false;
  try {
    const u = new URL(raw);
    // Explicit hostname validation: only hooks.slack.com is accepted.
    // Any other hostname (including subdomains of slack.com) is rejected
    // to prevent SSRF-style redirects via a crafted webhook URL.
    return u.protocol === 'https:' && u.hostname === 'hooks.slack.com';
  } catch {
    return false;
  }
}

async function postWebhook(url, body) {
  if (!isWebhookUrl(url)) {
    throw new Error('Invalid Slack webhook URL — must start with https://hooks.slack.com/');
  }
  const serialized = JSON.stringify(body);
  if (serialized.length > MAX_WEBHOOK_PAYLOAD_SIZE) {
    // Attempt to truncate the `text` field to fit within the size limit.
    // If body.text exists, shorten it; otherwise reject outright.
    if (typeof body.text === 'string') {
      const overhead = serialized.length - body.text.length;
      const allowedTextLen = MAX_WEBHOOK_PAYLOAD_SIZE - overhead - 3; // -3 for '...'
      if (allowedTextLen < 0) {
        throw new Error(`Slack webhook payload exceeds MAX_WEBHOOK_PAYLOAD_SIZE (${MAX_WEBHOOK_PAYLOAD_SIZE} bytes) and cannot be truncated`);
      }
      body = { ...body, text: body.text.slice(0, allowedTextLen) + '...' };
    } else {
      throw new Error(`Slack webhook payload exceeds MAX_WEBHOOK_PAYLOAD_SIZE (${MAX_WEBHOOK_PAYLOAD_SIZE} bytes)`);
    }
  }
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) {
    const text = (await r.text()).slice(0, 200);
    throw new Error(`Slack webhook returned ${r.status}: ${text}`);
  }
  return { ok: true, status: r.status };
}

function renderPlanSummary(plan) {
  const counts = (plan.tasks || []).reduce((acc, t) => {
    acc[t.risk || 'none'] = (acc[t.risk || 'none'] || 0) + 1;
    acc.total += 1;
    return acc;
  }, { total: 0 });
  const milestones = new Map();
  for (const t of plan.tasks || []) {
    const key = t.milestone || '(no milestone)';
    milestones.set(key, (milestones.get(key) || 0) + 1);
  }
  const lines = [
    `*${asMrkdwn(plan.title)}*`,
    plan.goal ? `_${asMrkdwn(plan.goal)}_` : '',
    `${counts.total} task${counts.total === 1 ? '' : 's'}`
      + (counts.high ? `  · :red_circle: ${counts.high} high` : '')
      + (counts.med  ? `  · :large_orange_circle: ${counts.med} med` : '')
      + (counts.low  ? `  · :large_green_circle: ${counts.low} low` : ''),
    '',
    '*Milestones*',
    ...[...milestones.entries()].map(([m, n]) => `• ${asMrkdwn(m)} — ${n} task${n === 1 ? '' : 's'}`),
  ].filter(Boolean);
  return lines.join('\n');
}

function renderDispatchResult(payload) {
  const ok      = payload.results.filter((r) => r.status === 'ok').length;
  const errored = payload.results.filter((r) => r.status === 'error').length;
  const skipped = payload.results.filter((r) => r.status === 'skipped').length;
  const links = payload.results
    .filter((r) => r.status === 'ok' && r.url)
    .slice(0, 10)
    .map((r) => `• <${r.url}|${asMrkdwn(r.title || `#${r.number}`)}>`);
  const lines = [
    `*Dispatched ${ok} task${ok === 1 ? '' : 's'}* to *${asMrkdwn(payload.target)}*`
      + (errored ? ` · ${errored} error${errored === 1 ? '' : 's'}` : '')
      + (skipped ? ` · ${skipped} skipped` : ''),
    `Plan: ${asMrkdwn(payload.plan?.title || payload.plan?.id || 'unknown')}`,
    ...(links.length ? ['', ...links] : []),
  ];
  return lines.join('\n');
}

function renderReviewDecided(reviewItem) {
  const status = reviewItem.status;
  const emoji = status === 'executed' ? ':white_check_mark:'
              : status === 'rejected' ? ':no_entry_sign:'
              : status === 'failed'   ? ':warning:'
              : ':eyes:';
  return [
    `${emoji} *Review ${asMrkdwn(status)}* — ${asMrkdwn(reviewItem.title)}`,
    reviewItem.reviewerNote ? `> ${asMrkdwn(reviewItem.reviewerNote)}` : '',
  ].filter(Boolean).join('\n');
}

export async function notifySlack({ webhookUrl, kind, payload }) {
  let text;
  if (kind === 'plan')          text = renderPlanSummary(payload);
  else if (kind === 'dispatch') text = renderDispatchResult(payload);
  else if (kind === 'review')   text = renderReviewDecided(payload);
  else if (kind === 'custom') {
    // Escape mrkdwn special chars and cap length to prevent oversized
    // or injected payloads reaching the Slack channel.
    const raw = String(payload?.text || '').slice(0, 2000);
    // Guard against a custom message that embeds a real secret (e.g. a
    // user accidentally pastes an API key into the notification field).
    if (scanForSecrets(raw)) throw new Error('Custom Slack message contains a potential secret — refusing to send.');
    text = asMrkdwn(raw);
  }
  else throw new Error(`Unknown Slack message kind: ${kind}`);

  if (!text || !text.trim()) throw new Error('Empty Slack message');
  return postWebhook(webhookUrl, { text });
}

export { renderPlanSummary, renderDispatchResult, renderReviewDecided };
