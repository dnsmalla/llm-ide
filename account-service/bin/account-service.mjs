#!/usr/bin/env node
// Process entry for the public account service. No AI, no extension import; loopback only behind nginx.
import { loadConfig } from '../src/config.mjs';
import { openDb } from '../src/db.mjs';
import { createMailer } from '../src/mailer.mjs';
import { purge } from '../src/retention.mjs';
import { createApp } from '../src/server.mjs';
import { simpleWebAuthn } from '../src/webauthn.mjs';

const config = loadConfig();
const db = openDb(config.dbPath);
const app = createApp({ config, db, mailer: createMailer(config.mail), webauthn: simpleWebAuthn, now: Date.now });

purge(db, Date.now);
setInterval(() => purge(db, Date.now), 10 * 60_000).unref();

app.listen(config.port, config.host, () => {
  console.log(JSON.stringify({ level: 'info', msg: 'listening', host: config.host, port: app.address().port, signupOpen: config.signupOpen }));
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    app.close(() => {
      db.close();
      process.exit(0);
    });
    app.closeAllConnections();
  });
}
