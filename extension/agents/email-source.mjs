// Email input source — a thin IMAP fetcher. The server's only job here is
// to connect to the user's mailbox with credentials they supplied, pull
// recent messages, and hand back normalized JSON. The Mac client turns
// those rows into meeting notes; we deliberately keep zero meeting-domain
// logic in this file so it stays a pure transport + normalization layer.
//
// Split: normalizeParsed/stripHtml are PURE (no IO, unit-tested);
// testConnection/fetchRecentEmails own all the network + lifecycle.
//
// Security: the IMAP password flows in as a function argument (resolved
// from the encrypted vault by the caller) and is NEVER logged. ImapFlow's
// own logger is disabled for the same reason.

import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import dns from 'node:dns/promises';
import net from 'node:net';

// Cap on the plaintext body we return per message. A summarizer fed a
// multi-megabyte newsletter wastes tokens and time; 20k chars is plenty
// of context for meeting-note extraction. We slice and append a marker so
// downstream readers know truncation happened.
const MAX_BODY_CHARS = 20000;

// Cap on the number of messages we return from a single fetch. The IMAP
// `since` search can match thousands of rows on a busy inbox; bounding the
// payload keeps the response (and the client's parse) sane. We keep the
// most recent ones since those are the most likely to be relevant.
const MAX_MESSAGES = 200;

// Hard ceilings on a single operation, independent of per-socket timeouts
// (which reset on any byte of activity and so can't bound a slow trickle).
// On expiry we force-close the connection so the in-flight await rejects
// rather than pinning a worker / blocking the shared event loop.
const TEST_DEADLINE_MS = 30_000;
const FETCH_DEADLINE_MS = 90_000;

// Skip messages whose raw size exceeds this. Large messages are almost
// always big attachments (decks, images, zips) — downloading the full
// RFC822 source for those wastes memory/bandwidth and the body text we
// actually summarize is tiny. We learn the size from a cheap metadata pass
// and only download the source for messages under this bound.
const MAX_SOURCE_BYTES = 2_000_000;

// HTML→plaintext for messages that ship only an HTML body. This is a
// deliberately small, dependency-free pass — not a full HTML parser. It
// drops script/style content entirely, turns the common block breaks into
// newlines, strips remaining tags, and decodes the handful of entities
// that actually show up in email bodies. Exported so it can be unit-tested
// in isolation.
export function stripHtml(html) {
  if (!html) return '';
  return String(html)
    // Remove <script>/<style> blocks wholesale — their contents are never
    // human-readable text and would otherwise leak JS/CSS into the body.
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    // Preserve visual line breaks: <br>, end of paragraph, end of div.
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    // Strip every remaining tag.
    .replace(/<[^>]+>/g, '')
    // Decode the entities common in real email bodies. Order matters:
    // decode &amp; last so an already-decoded "&lt;" isn't double-touched,
    // but since these are distinct tokens the order is only cosmetic here.
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    // Collapse runs of 3+ blank lines down to a single blank line so the
    // output reads cleanly instead of as a column of whitespace.
    .replace(/\n{3,}/g, '\n\n');
}

// PURE. Turn a mailparser `simpleParser` result + the IMAP uid into the
// stable shape the client expects. Every field has a defined fallback so
// a malformed/partial message never produces `undefined` downstream.
export function normalizeParsed(parsed, uid) {
  // Prefer the real text part; fall back to a stripped HTML body; finally
  // the empty string. Then trim and cap length.
  let text = parsed.text || '';
  if (!text && parsed.html) text = stripHtml(parsed.html);
  text = text.trim();
  if (text.length > MAX_BODY_CHARS) {
    text = text.slice(0, MAX_BODY_CHARS) + '\n\n[...truncated]';
  }

  return {
    uid: Number(uid),
    messageId: parsed.messageId || `email-uid-${uid}`,
    subject: parsed.subject || '(no subject)',
    // parsed.from is an address object; `.text` is the rendered form like
    // "Alice <alice@x.com>". Missing sender → empty string.
    from: parsed.from?.text || '',
    date: parsed.date instanceof Date
      ? parsed.date.toISOString()
      : new Date().toISOString(),
    text,
  };
}

// True for any address we must never dial from inside the server's trust
// boundary: loopback, link-local (incl. the cloud metadata 169.254.169.254),
// RFC1918 / CGNAT private ranges, IPv6 ULA, and the unspecified address.
// This is the core SSRF defence — without it an authenticated tenant could
// point the server at internal services and use connect/timeout timing as a
// port-scan oracle.
export function isPrivateAddress(ip) {
  const v = ip.startsWith('::ffff:') ? ip.slice(7) : ip;   // IPv4-mapped IPv6
  if (net.isIPv4(v)) {
    const p = v.split('.').map(Number);
    const [a, b] = p;
    if (a === 0 || a === 127 || a === 10) return true;
    if (a === 169 && b === 254) return true;                // link-local + metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;      // CGNAT 100.64/10
    return false;
  }
  const low = (ip || '').toLowerCase();
  if (low === '::1' || low === '::') return true;           // loopback / unspecified
  if (low.startsWith('fe80')) return true;                  // link-local
  if (low.startsWith('fc') || low.startsWith('fd')) return true; // ULA fc00::/7
  return false;
}

// Resolve `host` and refuse private/local targets, then pin the connection to
// the resolved IP (so a later DNS rebind can't swap in an internal address).
// `LLMIDE_EMAIL_ALLOW_PRIVATE=1` disables the check for single-user localhost
// deployments where dialing a LAN/loopback mail server is legitimate.
async function resolveSafeHost(host) {
  if (process.env.LLMIDE_EMAIL_ALLOW_PRIVATE === '1') {
    return { connectHost: host, servername: net.isIP(host) ? undefined : host };
  }
  const addrs = net.isIP(host)
    ? [{ address: host }]
    : await dns.lookup(host, { all: true });
  if (addrs.length === 0) throw new Error('Could not resolve the IMAP host');
  for (const a of addrs) {
    if (isPrivateAddress(a.address)) {
      throw new Error('Refusing to connect to a private or local address');
    }
  }
  // Pin to the first validated address; keep the hostname for TLS SNI + cert
  // verification (skip servername when the user gave a raw IP).
  return { connectHost: addrs[0].address, servername: net.isIP(host) ? undefined : host };
}

// Build a fresh ImapFlow client. Validates the port, resolves + SSRF-checks
// the host, and pins to the resolved IP. Timeouts are tight on purpose: a
// hung handshake against a bad host should fail fast rather than wedge the
// request. Async because of the DNS resolution.
async function makeClient({ host, port, secure, user, password }) {
  const portNum = Number(port);
  if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
    throw new Error('Invalid IMAP port');
  }
  const { connectHost, servername } = await resolveSafeHost(host);
  return new ImapFlow({
    host: connectHost,
    port: portNum,
    secure: !!secure,
    auth: { user, pass: password },
    logger: false,          // never log — the auth blob contains the password
    socketTimeout: 20000,
    greetingTimeout: 10000,
    tls: servername ? { servername } : undefined,
  });
}

// Map ImapFlow / network failures to a human-readable message. The raw
// errors ("Command failed", auth response codes) are useless to an end
// user, so we translate the common cases and never echo the password.
function friendlyError(err) {
  const raw = String(err?.message || err || '');
  if (/auth|login|credential|AUTHENTICATIONFAILED/i.test(raw)) {
    return 'IMAP login failed — check the address and app password';
  }
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(raw)) {
    return 'Could not reach the IMAP server — check the host name';
  }
  if (/ECONNREFUSED|ETIMEDOUT|timeout|timed out/i.test(raw)) {
    return 'Connection to the IMAP server timed out — check host, port, and TLS';
  }
  return raw || 'IMAP connection failed';
}

// Connect, open the mailbox, read its size, and disconnect. Used by the
// client's "Test connection" button before it commits to a full fetch.
// Returns a small status object; throws a clean Error on any failure.
export async function testConnection({ host, port, secure, user, password, mailbox }) {
  const box = mailbox || 'INBOX';
  let client;
  let lock;
  let timedOut = false;
  let killer;
  try {
    client = await makeClient({ host, port, secure, user, password });
    killer = setTimeout(() => { timedOut = true; try { client.close(); } catch { /* */ } }, TEST_DEADLINE_MS);
    await client.connect();
    lock = await client.getMailboxLock(box);
    const status = client.mailbox || {};
    return { ok: true, mailbox: box, total: status.exists ?? 0, recent: 0 };
  } catch (err) {
    throw new Error(timedOut ? 'IMAP connection timed out' : friendlyError(err));
  } finally {
    // Release the lock and log out even if the body threw. Guard each step
    // so a cleanup failure (e.g. logout on an already-dropped socket) can't
    // mask the real error we're trying to surface.
    if (killer) clearTimeout(killer);
    if (lock) { try { lock.release(); } catch { /* already released */ } }
    if (client) { try { await client.logout(); } catch { /* socket gone */ } }
  }
}

// Resolve the search lower-bound date. Prefer the client's forward-only
// high-water mark (`sinceISO`); otherwise fall back to `lookbackDays`.
// Exported for unit testing.
export function resolveSince({ sinceISO, lookbackDays }) {
  if (sinceISO) {
    const d = new Date(sinceISO);
    if (!Number.isNaN(d.getTime())) return d;
  }
  // Clamp server-side to 1..60 — never trust the client's bound.
  const raw = Number(lookbackDays);
  const days = Number.isFinite(raw) ? Math.min(60, Math.max(1, Math.round(raw))) : 7;
  return new Date(Date.now() - days * 86400000);
}

// Connect and return messages newer than the resolved `since`, optionally
// limited to unread and/or a sender substring. Two-phase to bound work:
//   1. cheap metadata pass (uid/size/date) — no bodies downloaded;
//   2. pick the newest MAX_MESSAGES that are also under MAX_SOURCE_BYTES,
//      then download + parse only those.
// Empty inbox / no matches → []. Throws a clean Error on connect/auth fail.
export async function fetchRecentEmails({
  host, port, secure, user, password, mailbox,
  lookbackDays, sinceISO, unreadOnly, fromFilter,
}) {
  const box = mailbox || 'INBOX';
  const since = resolveSince({ sinceISO, lookbackDays });

  // IMAP search criteria. `seen: false` = unread only; `from` is a substring
  // match the server runs. Empty filter → omitted (match all senders).
  const criteria = { since };
  if (unreadOnly) criteria.seen = false;
  const fromTrim = typeof fromFilter === 'string' ? fromFilter.trim() : '';
  if (fromTrim) criteria.from = fromTrim;

  let client;
  let lock;
  let timedOut = false;
  let killer;
  try {
    client = await makeClient({ host, port, secure, user, password });
    killer = setTimeout(() => { timedOut = true; try { client.close(); } catch { /* */ } }, FETCH_DEADLINE_MS);
    await client.connect();
    lock = await client.getMailboxLock(box);

    // Phase 1 — metadata only (no `source`, so no body bytes cross the wire).
    const meta = [];
    for await (const msg of client.fetch(criteria, { uid: true, size: true, envelope: true, internalDate: true })) {
      const when = msg.envelope?.date || msg.internalDate || null;
      meta.push({ uid: msg.uid, size: msg.size ?? 0, date: when ? new Date(when) : new Date(0) });
    }
    if (meta.length === 0) return [];

    // Newest first; keep those under the size bound; cap the count.
    meta.sort((a, b) => b.date - a.date);
    const selected = meta
      .filter((m) => m.size <= MAX_SOURCE_BYTES)
      .slice(0, MAX_MESSAGES);
    if (selected.length === 0) return [];

    // Phase 2 — download + parse the raw source for the selected uids only.
    const uidList = selected.map((m) => m.uid).join(',');
    const messages = [];
    for await (const msg of client.fetch(uidList, { uid: true, source: true }, { uid: true })) {
      const parsed = await simpleParser(msg.source);
      messages.push(normalizeParsed(parsed, msg.uid));
    }
    messages.sort((a, b) => new Date(b.date) - new Date(a.date));
    return messages;
  } catch (err) {
    throw new Error(timedOut ? 'IMAP fetch timed out' : friendlyError(err));
  } finally {
    if (killer) clearTimeout(killer);
    if (lock) { try { lock.release(); } catch { /* already released */ } }
    if (client) { try { await client.logout(); } catch { /* socket gone */ } }
  }
}
