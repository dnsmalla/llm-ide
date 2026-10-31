// Gmail connector, Pattern B (forward-only fetch -> notes), over the Gmail REST API with the read-only scope.
// Plan 2026-10-31-google-connectors-plan.md sections 3 to 6.
//
// One note per THREAD, the note file name derived from the account and thread id so a new reply updates the same file.
// The pure parts (header and MIME decoding, thread -> note) are exported for tests; `fetchGmail` owns the API calls.
//
// Incrementality: the cursor is the Gmail `historyId`. The first run (and any run after the history expired, HTTP 404)
// bootstraps from `threads.list` over a bounded date window and the selected labels, resumable by page token, then keeps
// the mailbox historyId read BEFORE listing so nothing that arrives during the listing is missed. A run is capped
// (threads and bytes); an unfinished run reports `pending` and a cursor that continues where it stopped. Nothing is
// ever fetched from a URL found in a message; attachments are metadata only.
//
// The caller (routes/google-connectors.mjs) commits the returned cursor ONLY after the client confirms it wrote the
// notes (create first, then mark seen), the contract of the email source's /kb/email/seen.
import { googleCall, apiUrl, GoogleApiError } from './google-fetch.mjs';
import { htmlToMarkdown, escapeMarkdownText } from './html-to-markdown.mjs';
import { redactSecretsForStorage } from '../../core/redact-secrets.mjs';

export const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';

export const LIMITS = Object.freeze({
  maxThreadsPerRun: 50, // a run's response is bounded by maxThreadsPerRun x noteBytes
  bootstrapTotalThreads: 2000,
  messageBodyBytes: 200 * 1024,
  noteBytes: 512 * 1024,
  concurrency: 4,
  maxParts: 200,
  maxPartDepth: 20,
  maxParticipants: 50,
  maxAttachmentsListed: 50,
  historyPageSize: 500,
  threadListPageSize: 100,
});

const ALWAYS_EXCLUDED = ['SPAM', 'TRASH', 'DRAFT'];
const LABEL_RE = /^[A-Za-z0-9_][A-Za-z0-9_. -]{0,99}$/;

/** Validate and clamp the per-account Gmail options (never trust the client's bounds). */
export function normalizeGmailOptions(o = {}) {
  const labels = Array.isArray(o.labels) ? [...new Set(o.labels.map(String).filter((l) => LABEL_RE.test(l)))].slice(0, 20) : [];
  const w = Math.round(Number(o.windowDays));
  return {
    labels: labels.length ? labels : ['INBOX'],
    windowDays: Number.isFinite(w) ? Math.min(365, Math.max(1, w)) : 30,
    includePromotions: o.includePromotions === true,
    includeSocial: o.includeSocial === true,
  };
}

// ---- header and MIME decoding ----------------------------------------------------------------------------------

const HDR_CTRL = /[\x00-\x1f\x7f]/g;

function decodeBytes(buf, charset) {
  const cs = String(charset || 'utf-8').trim().replace(/^"|"$/g, '').toLowerCase();
  try { return new TextDecoder(cs, { fatal: false }).decode(buf); } catch { return new TextDecoder('utf-8').decode(buf); }
}

/** RFC 2047 encoded words in a header value ("=?UTF-8?B?...?="). Adjacent encoded words join without a space. */
export function decodeMimeWords(v) {
  const s = String(v ?? '').replace(/(\?=)\s+(=\?)/g, '$1$2');
  return s.replace(/=\?([^?\s]+)\?([bBqQ])\?([^?]*)\?=/g, (m, cs, enc, data) => {
    try {
      if (enc.toLowerCase() === 'b') return decodeBytes(Buffer.from(data, 'base64'), cs.split('*')[0]);
      const bytes = [];
      const t = data.replace(/_/g, ' ');
      for (let i = 0; i < t.length; i++) {
        if (t[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(t.slice(i + 1, i + 3))) { bytes.push(parseInt(t.slice(i + 1, i + 3), 16)); i += 2; } else bytes.push(t.charCodeAt(i) & 0xff);
      }
      return decodeBytes(Buffer.from(bytes), cs.split('*')[0]);
    } catch { return m; }
  });
}

const cleanHeader = (v, max = 500) => decodeMimeWords(v).replace(HDR_CTRL, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

function headerMap(payload) {
  const m = {};
  for (const h of Array.isArray(payload?.headers) ? payload.headers : []) {
    const k = String(h?.name || '').toLowerCase();
    if (k && !(k in m) && typeof h.value === 'string') m[k] = h.value;
  }
  return m;
}

/** Split an address header on commas outside quotes and angle brackets. */
export function splitAddresses(v) {
  const out = []; let cur = ''; let q = false; let ang = 0;
  for (const c of String(v ?? '')) {
    if (c === '"') q = !q;
    else if (!q && c === '<') ang += 1;
    else if (!q && c === '>') ang = Math.max(0, ang - 1);
    if (c === ',' && !q && ang === 0) { if (cur.trim()) out.push(cur.trim()); cur = ''; } else cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.map((a) => cleanHeader(a, 200)).filter(Boolean);
}

function decodeBodyData(part) {
  const d = part?.body?.data;
  if (typeof d !== 'string' || !d) return null;
  const hdrs = headerMap(part);
  const ct = hdrs['content-type'] || '';
  const cs = /charset="?([^";\s]+)/i.exec(ct)?.[1];
  return decodeBytes(Buffer.from(d, 'base64url'), cs);
}

/** Walk the MIME tree: inline text parts and attachment metadata. Bounded in depth and part count. */
export function extractParts(payload) {
  const plain = []; const html = []; const attachments = [];
  let seen = 0;
  const walk = (p, depth) => {
    if (!p || typeof p !== 'object' || depth > LIMITS.maxPartDepth || seen >= LIMITS.maxParts) return;
    seen += 1;
    const mime = String(p.mimeType || '').toLowerCase();
    const hdrs = headerMap(p);
    const disp = String(hdrs['content-disposition'] || '').toLowerCase();
    const filename = typeof p.filename === 'string' ? cleanHeader(p.filename, 200) : '';
    if (filename || disp.startsWith('attachment')) {
      attachments.push({ name: filename || '(unnamed)', mimeType: mime.slice(0, 100), size: Number(p.body?.size) || 0, partId: String(p.partId ?? '') });
    } else if (mime === 'text/plain') {
      const t = decodeBodyData(p); if (t) plain.push(t); else if (p.body?.attachmentId) plain.push(null);
    } else if (mime === 'text/html') {
      const t = decodeBodyData(p); if (t) html.push(t); else if (p.body?.attachmentId) html.push(null);
    }
    if (Array.isArray(p.parts)) for (const c of p.parts) walk(c, depth + 1);
  };
  walk(payload, 0);
  return { plain, html, attachments };
}

// ---- quoted text -----------------------------------------------------------------------------------------------

/** Drop the quoted reply tail and the signature of a plain-text body. Never returns an empty result for a non-empty input. */
export function trimQuoted(text) {
  const orig = String(text ?? '').replace(/\r\n?/g, '\n');
  const lines = orig.split('\n');
  let cut = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^On .{5,300} wrote:\s*$/i.test(l) || (/^On .{5,200}$/i.test(l) && /^.{0,200}wrote:\s*$/i.test(lines[i + 1] || ''))
      || /^-{2,}\s*Original Message\s*-{2,}\s*$/i.test(l)
      || /^\d{4}.{1,100}(wrote|書きました)[:：]?\s*$/.test(l)
      || (/^From: .+/.test(l) && /^(Sent|Date): /.test(lines[i + 1] || '')) || l === '-- ' || l === '--') { cut = i; break; }
  }
  const kept = lines.slice(0, cut).filter((l) => !l.startsWith('>')).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return kept || orig.trim();
}

const capBytes = (s, max) => {
  if (Buffer.byteLength(s) <= max) return s;
  return `${Buffer.from(s).subarray(0, max).toString('utf8').replace(/�+$/, '')}\n\n[...truncated]`;
};

/** One message to its Markdown body (untrusted text, escaped) and attachment metadata. */
export function messageBody(msg) {
  const { plain, html, attachments } = extractParts(msg.payload || {});
  // Redact the raw text first (a secret split by escaping or markup is harder to match later); the note is redacted again as a whole.
  const plainText = redactSecretsForStorage(plain.filter((x) => typeof x === 'string').join('\n\n').trim());
  let body;
  if (plainText) body = escapeMarkdownText(trimQuoted(plainText));
  else { const h = redactSecretsForStorage(html.filter((x) => typeof x === 'string').join('\n\n')); body = h ? htmlToMarkdown(h, { maxChars: LIMITS.messageBodyBytes }) : ''; }
  if (!body && (plain.includes(null) || html.includes(null))) body = '[body not inline, omitted]';
  return { body: capBytes(body, LIMITS.messageBodyBytes), attachments };
}

// ---- thread -> note --------------------------------------------------------------------------------------------

const iso = (ms) => { const n = Number(ms); return Number.isFinite(n) && n > 0 ? new Date(n).toISOString() : null; };
const q = (v) => JSON.stringify(v);

export function noteFileName(accountId, threadId) { return `gmail-${accountId}-${String(threadId).replace(/[^A-Za-z0-9_-]/g, '_')}.md`; }

function excludedSet(options) {
  const s = new Set(ALWAYS_EXCLUDED);
  if (!options.includePromotions) s.add('CATEGORY_PROMOTIONS');
  if (!options.includeSocial) s.add('CATEGORY_SOCIAL');
  return s;
}

/**
 * Build the note for a thread, or null when nothing of it is selected (all messages carry an excluded label, or none
 * carries a selected one).
 * @param {object} thread Gmail users.threads.get (format=full) response
 * @param {{ accountId: string, accountEmail: string, options: ReturnType<typeof normalizeGmailOptions> }} ctx
 */
export function threadToNote(thread, { accountId, accountEmail, options }) {
  const excluded = excludedSet(options);
  const selected = new Set(options.labels);
  const msgs = (Array.isArray(thread?.messages) ? thread.messages : [])
    .filter((m) => m && !(m.labelIds || []).some((l) => excluded.has(l)))
    .sort((a, b) => Number(a.internalDate || 0) - Number(b.internalDate || 0));
  if (msgs.length === 0) return null;
  if (!msgs.some((m) => (m.labelIds || []).some((l) => selected.has(l)))) return null;

  const labels = [...new Set(msgs.flatMap((m) => m.labelIds || []))].filter((l) => !excluded.has(l)).sort().slice(0, 40);
  const people = new Set();
  const sections = [];
  let subject = '';
  for (const m of msgs) {
    const h = headerMap(m.payload);
    if (!subject && h.subject) subject = cleanHeader(h.subject, 300);
    for (const k of ['from', 'to', 'cc']) for (const a of splitAddresses(h[k])) if (people.size < LIMITS.maxParticipants) people.add(a);
    const { body, attachments } = messageBody(m);
    const from = cleanHeader(h.from, 200) || '(unknown sender)';
    const when = iso(m.internalDate) || '';
    let sec = `## ${escapeMarkdownText(from)}${when ? `, ${when}` : ''}\n\n${body || '[no text]'}`;
    if (attachments.length) {
      const list = attachments.slice(0, LIMITS.maxAttachmentsListed).map((a) => `- ${escapeMarkdownText(a.name)} (${escapeMarkdownText(a.mimeType || 'unknown')}, ${a.size} bytes)`).join('\n');
      sec += `\n\nAttachments (metadata only, not downloaded):\n${list}${attachments.length > LIMITS.maxAttachmentsListed ? `\n- ... ${attachments.length - LIMITS.maxAttachmentsListed} more` : ''}`;
    }
    sections.push(sec);
  }
  const title = redactSecretsForStorage(subject || '(no subject)');
  const header = `# ${escapeMarkdownText(title)}\n\n`;
  // Keep the newest messages that fit the note cap; say how many older ones were left out.
  let kept = sections.length; let total = Buffer.byteLength(header);
  const sizes = sections.map((s) => Buffer.byteLength(s) + 2);
  total += sizes.reduce((a, b) => a + b, 0);
  let omitted = 0;
  while (total > LIMITS.noteBytes && kept > 1) { total -= sizes[sections.length - kept]; kept -= 1; omitted += 1; }
  const bodyText = header + (omitted ? `[${omitted} older message${omitted === 1 ? '' : 's'} omitted: note size limit]\n\n` : '') + sections.slice(sections.length - kept).join('\n\n');

  const participants = [...people].map((p) => redactSecretsForStorage(p));
  const fm = {
    source: 'gmail', account: accountEmail || '', accountId, threadId: String(thread.id), subject: title, labels, participants,
    first_at: iso(msgs[0].internalDate), last_at: iso(msgs[msgs.length - 1].internalDate), message_count: msgs.length, untrusted: true,
  };
  const frontmatter = `---\n${Object.entries(fm).map(([k, v]) => `${k}: ${q(v)}`).join('\n')}\n---\n\n`;
  const markdown = redactSecretsForStorage(bodyText);
  return {
    threadId: String(thread.id), noteFile: noteFileName(accountId, thread.id), title, frontmatter: fm,
    markdown: frontmatter + markdown, messageCount: msgs.length, lastAt: fm.last_at,
  };
}

// ---- API -------------------------------------------------------------------------------------------------------

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) { const i = next++; if (i >= items.length) return; out[i] = await fn(items[i], i); }
  }));
  return out;
}

const THREAD_FIELDS = 'id,historyId,messages(id,threadId,labelIds,internalDate,sizeEstimate,payload)';

function listQuery(options, now) {
  const after = Math.floor((now - options.windowDays * 86_400_000) / 1000);
  const parts = [`after:${after}`];
  if (!options.includePromotions) parts.push('-category:promotions');
  if (!options.includeSocial) parts.push('-category:social');
  return parts.join(' ');
}

const parseCursor = (c) => { try { const v = JSON.parse(c); return v && typeof v === 'object' ? v : null; } catch { return null; } };
const day = (now) => new Date(now).toISOString().slice(0, 10);

/**
 * One capped Gmail run.
 * @param {{ session: object, accountId: string, accountEmail: string, cursor: string|null, options: object, now?: number,
 *   sleepImpl?: Function, limits?: Partial<typeof LIMITS> }} o
 * @returns {Promise<{ notes: object[], tombstones: object[], nextCursor: string, mode: 'bootstrap'|'history', pending: boolean,
 *   stats: { threads: number, messages: number, skipped: number, oversize: number, rebootstrapped: boolean, truncated: boolean } }>}
 */
export async function fetchGmail({ session, accountId, accountEmail, cursor, options: rawOptions, now = Date.now(), sleepImpl, limits = {} }) {
  const lim = { ...LIMITS, ...limits };
  const options = normalizeGmailOptions(rawOptions);
  const call = (url, o = {}) => googleCall(session, url, { sleepImpl, ...o });
  const stats = { threads: 0, messages: 0, skipped: 0, oversize: 0, rebootstrapped: false, truncated: false };
  const notes = []; const tombstones = [];
  let cur = parseCursor(cursor);
  let rebootstrapped = false;

  const startBootstrap = async () => {
    const profile = await call(apiUrl(`${GMAIL_API}/profile`, { fields: 'historyId,emailAddress' }));
    if (!profile?.historyId) throw new GoogleApiError('GOOGLE_BAD_JSON', 'Google answered with a malformed response');
    return { historyId: String(profile.historyId), bootstrap: { li: 0, pageToken: null, done: 0 } };
  };

  const fetchThreads = async (ids) => {
    const res = await mapLimit(ids, lim.concurrency, async (id) => {
      try {
        return { id, thread: await call(apiUrl(`${GMAIL_API}/threads/${encodeURIComponent(id)}`, { format: 'full', fields: THREAD_FIELDS }), { allow404: true }) };
      } catch (e) {
        if (e?.code === 'GOOGLE_FETCH_REFUSED') return { id, oversize: true };
        throw e;
      }
    });
    for (const r of res) {
      if (r.oversize) { stats.oversize += 1; continue; }
      if (!r.thread) { tombstones.push({ threadId: r.id, noteFile: noteFileName(accountId, r.id), line: `deleted upstream ${day(now)}` }); continue; }
      const note = threadToNote(r.thread, { accountId, accountEmail, options });
      if (!note) { stats.skipped += 1; continue; }
      stats.threads += 1; stats.messages += note.messageCount; notes.push(note);
    }
  };

  let mode = 'history';
  if (!cur) { cur = await startBootstrap(); mode = 'bootstrap'; }
  if (cur.historyId && !cur.bootstrap) {
    // ---- incremental
    const changed = new Map(); // threadId -> true
    let pageToken; let lastIncluded = String(cur.historyId); let mailboxHistoryId = null; let stoppedEarly = false;
    try {
      history: for (;;) {
        const page = await call(apiUrl(`${GMAIL_API}/history`, {
          startHistoryId: cur.historyId, historyTypes: ['messageAdded', 'labelAdded', 'messageDeleted'], maxResults: lim.historyPageSize, pageToken,
          fields: 'history(id,messagesAdded/message(threadId),labelsAdded/message(threadId),messagesDeleted/message(threadId)),nextPageToken,historyId',
        }), { allow404: true });
        if (page === null) throw new GoogleApiError('GOOGLE_GONE', 'history expired', { status: 404 });
        if (page.historyId) mailboxHistoryId = String(page.historyId);
        for (const rec of Array.isArray(page.history) ? page.history : []) {
          const ids = new Map();
          for (const x of rec.messagesAdded || []) if (x?.message?.threadId) ids.set(String(x.message.threadId), false);
          for (const x of rec.labelsAdded || []) if (x?.message?.threadId) ids.set(String(x.message.threadId), false);
          for (const x of rec.messagesDeleted || []) if (x?.message?.threadId && !ids.has(String(x.message.threadId))) ids.set(String(x.message.threadId), 'maybe-deleted');
          const fresh = [...ids.keys()].filter((t) => !changed.has(t));
          if (changed.size + fresh.length > lim.maxThreadsPerRun && changed.size > 0) { stoppedEarly = true; break history; }
          for (const [t, d] of ids) if (!changed.has(t)) changed.set(t, d);
          if (rec.id) lastIncluded = String(rec.id);
        }
        pageToken = page.nextPageToken;
        if (!pageToken) break;
      }
    } catch (e) {
      if (!(e?.status === 404)) throw e;
      // history older than Gmail keeps: a bounded re-bootstrap over the window (the notes are idempotent upserts)
      cur = await startBootstrap(); mode = 'bootstrap'; rebootstrapped = true; stats.rebootstrapped = true; changed.clear();
    }
    if (!rebootstrapped) {
      const ids = [...changed.keys()];
      await fetchThreads(ids);
      const pending = stoppedEarly;
      const next = pending ? lastIncluded : (mailboxHistoryId || String(cur.historyId));
      return { notes, tombstones, nextCursor: JSON.stringify({ historyId: next }), mode, pending, stats };
    }
  }

  // ---- bootstrap (first run, or after history expired)
  const bs = { ...(cur.bootstrap || { li: 0, pageToken: null, done: 0 }) };
  const labels = options.labels;
  let budget = lim.maxThreadsPerRun;
  while (bs.li < labels.length && budget > 0 && bs.done < lim.bootstrapTotalThreads) {
    const page = await call(apiUrl(`${GMAIL_API}/threads`, {
      labelIds: labels[bs.li], q: listQuery(options, now), maxResults: Math.min(lim.threadListPageSize, budget), pageToken: bs.pageToken || undefined,
      fields: 'threads(id),nextPageToken',
    }));
    const ids = (Array.isArray(page.threads) ? page.threads : []).map((t) => String(t.id)).filter(Boolean);
    await fetchThreads(ids);
    budget -= ids.length; bs.done += ids.length;
    bs.pageToken = page.nextPageToken || null;
    if (!bs.pageToken) bs.li += 1;
  }
  const capped = bs.done >= lim.bootstrapTotalThreads;
  if (capped) stats.truncated = true;
  const finished = bs.li >= labels.length || capped;
  const pending = !finished;
  const nextCursor = finished ? JSON.stringify({ historyId: cur.historyId }) : JSON.stringify({ historyId: cur.historyId, bootstrap: bs });
  return { notes, tombstones, nextCursor, mode: 'bootstrap', pending, stats };
}
