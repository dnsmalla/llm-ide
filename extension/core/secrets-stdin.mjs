// The desktop hands the spawned core its three secrets on ONE stdin line instead of the environment, which any
// same-user process can read (`ps eww`, /proc/<pid>/environ). The Tauri host sets `LLMIDE_SECRETS_STDIN=1`, writes
// `{ "jwtSecret", "vaultKey", "hostApprovalKey" }` and closes the pipe; every other deployment keeps the env vars.
// This module MUST be imported before config.mjs in server.mjs: config reads the secrets at module load. Nothing here
// ever prints a value; a missing or malformed line fails the boot (`secrets_stdin_*`) rather than starting with
// generated dev secrets.
import { readFileSync } from 'node:fs';

const fail = (reason) => {
  process.stderr.write(`${JSON.stringify({ level: 'error', msg: reason })}\n`);
  process.exit(1);
};

if (process.env.LLMIDE_SECRETS_STDIN === '1') {
  delete process.env.LLMIDE_SECRETS_STDIN;
  let parsed;
  try {
    // fd 0 is the host's pipe: it closes it after the one line, so this read returns at EOF.
    const line = readFileSync(0, 'utf8').split('\n').find((l) => l.trim()) ?? '';
    parsed = JSON.parse(line);
  } catch {
    fail('secrets_stdin_invalid');
  }
  const take = (key, value) => {
    if (typeof value === 'string' && value.length >= 32) process.env[key] = value;
  };
  take('LLMIDE_JWT_SECRET', parsed?.jwtSecret);
  take('LLMIDE_VAULT_KEY', parsed?.vaultKey);
  take('LLMIDE_HOST_APPROVAL_KEY', parsed?.hostApprovalKey);
  if (!process.env.LLMIDE_JWT_SECRET || !process.env.LLMIDE_VAULT_KEY) fail('secrets_stdin_incomplete');
}
