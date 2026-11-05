import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import nodemailer from 'nodemailer';

export function createMailer(mail) {
  if (mail.transport === 'file') {
    // Development only (config refuses it in production): the file holds live sign-in links.
    mkdirSync(mail.dir, { recursive: true, mode: 0o700 });
    const file = join(mail.dir, 'outbox.jsonl');
    return {
      file,
      async send(msg) {
        appendFileSync(file, `${JSON.stringify({ from: mail.from, ...msg })}\n`, { mode: 0o600 });
      },
    };
  }
  if (mail.transport === 'none') {
    // Sign-up stays closed and no account mail is sent until an SMTP provider is configured.
    return { async send() { throw new Error('email is not configured'); } };
  }
  if (mail.transport === 'smtp') {
    const transport = nodemailer.createTransport(mail.smtpUrl);
    return {
      async send(msg) {
        await transport.sendMail({ from: mail.from, to: msg.to, subject: msg.subject, text: msg.text });
      },
    };
  }
  throw new Error(`unknown mail transport ${mail.transport}`);
}

// Off the request path, so a response never waits on (or reveals) the mail branch.
// The token is never stored in clear, so a restart drops a pending mail; the user resends.
export function deliver(mailer, msg, { retryMs = 2000, attempts = 5, onFail = () => {} } = {}) {
  let tries = 0;
  const attempt = () => {
    Promise.resolve()
      .then(() => mailer.send(msg))
      .catch(() => {
        tries += 1;
        if (tries < attempts) setTimeout(attempt, retryMs * 2 ** (tries - 1)).unref();
        else onFail();
      });
  };
  setImmediate(attempt);
}
