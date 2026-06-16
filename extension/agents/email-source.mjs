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

// Build a fresh ImapFlow client. Timeouts are tight on purpose: the Mac
// client shows a spinner while we connect, and a hung TLS handshake
// against a bad host should fail fast rather than wedge the request.
function makeClient({ host, port, secure, user, password }) {
  return new ImapFlow({
    host,
    port: Number(port),
    secure: !!secure,
    auth: { user, pass: password },
    logger: false,          // never log — the auth blob contains the password
    socketTimeout: 20000,
    greetingTimeout: 10000,
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
  try {
    client = makeClient({ host, port, secure, user, password });
    await client.connect();
    lock = await client.getMailboxLock(box);
    const status = client.mailbox || {};
    return { ok: true, mailbox: box, total: status.exists ?? 0, recent: 0 };
  } catch (err) {
    throw new Error(friendlyError(err));
  } finally {
    // Release the lock and log out even if the body threw. Guard each step
    // so a cleanup failure (e.g. logout on an already-dropped socket) can't
    // mask the real error we're trying to surface.
    if (lock) { try { lock.release(); } catch { /* already released */ } }
    if (client) { try { await client.logout(); } catch { /* socket gone */ } }
  }
}

// Connect and return the recent messages (last `lookbackDays`, default 7)
// as normalized rows. Empty inbox / no matches → []. Throws a clean Error
// on connect/auth failure.
export async function fetchRecentEmails({ host, port, secure, user, password, mailbox, lookbackDays }) {
  const box = mailbox || 'INBOX';
  const days = Number(lookbackDays) > 0 ? Number(lookbackDays) : 7;
  const since = new Date(Date.now() - days * 86400000);

  let client;
  let lock;
  try {
    client = makeClient({ host, port, secure, user, password });
    await client.connect();
    lock = await client.getMailboxLock(box);

    const messages = [];
    // `source: true` pulls the raw RFC822 bytes so mailparser can build the
    // full structure (subject, from, text/html). `uid: true` gives us the
    // stable id we expose. A `since`-only search that matches nothing simply
    // yields no iterations → we return [].
    for await (const msg of client.fetch({ since }, { uid: true, source: true })) {
      const parsed = await simpleParser(msg.source);
      messages.push(normalizeParsed(parsed, msg.uid));
    }

    // Bound the payload: keep the newest MAX_MESSAGES by date. Sorting here
    // (rather than relying on IMAP order) makes "most recent" deterministic
    // regardless of how the server returned the set.
    messages.sort((a, b) => new Date(b.date) - new Date(a.date));
    return messages.slice(0, MAX_MESSAGES);
  } catch (err) {
    throw new Error(friendlyError(err));
  } finally {
    if (lock) { try { lock.release(); } catch { /* already released */ } }
    if (client) { try { await client.logout(); } catch { /* socket gone */ } }
  }
}
