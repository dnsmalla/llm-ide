// Centralized server configuration.  Every value that varies between
// dev / staging / prod (bind address, secrets, feature flags) lives
// here, sourced from environment variables.  Defaults are safe for
// local development; production deployments MUST override the
// security-relevant ones (LLMIDE_JWT_SECRET, LLMIDE_VAULT_KEY).
//
// We deliberately don't pull a dotenv library — we read process.env
// directly and let the deployer use whatever .env loader they prefer
// (docker-compose env_file, systemd EnvironmentFile, k8s ConfigMap...).

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

function envStr(name, fallback) {
  const v = process.env[name];
  return (typeof v === 'string' && v.length > 0) ? v : fallback;
}

function envInt(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function envBool(name, fallback) {
  const v = process.env[name];
  if (v === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(v);
}

// --- Secrets -------------------------------------------------------------
//
// JWT_SECRET signs access + refresh tokens.  VAULT_KEY derives per-user
// data keys for the credential vault.  Both must be high-entropy and
// stable across server restarts (rotating them invalidates all sessions
// and stored secrets respectively).
//
// In dev we auto-generate and persist them under `kb/.dev-secrets.json`
// — convenient, but never use this path in production.  Production
// must set the env vars explicitly so secrets live in the deployment
// platform's secret store, not on disk in the repo directory.

function persistedDevSecrets() {
  const file = path.join(ROOT, 'kb', '.dev-secrets.json');
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { /* fall through to regen */ }
  const fresh = {
    jwtSecret:  crypto.randomBytes(48).toString('base64url'),
    vaultKey:   crypto.randomBytes(48).toString('base64url'),
  };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(fresh, null, 2), { mode: 0o600 });
  } catch { /* ignore — we still return the value in-memory */ }
  return fresh;
}

const isProd = (envStr('NODE_ENV', 'development') === 'production');

let _jwtSecret = envStr('LLMIDE_JWT_SECRET');
let _vaultKey  = envStr('LLMIDE_VAULT_KEY');

if (!_jwtSecret || !_vaultKey) {
  if (isProd) {
    throw new Error(
      'LLMIDE_JWT_SECRET and LLMIDE_VAULT_KEY must be set in production. ' +
      'Generate with `node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64url\'))"`.'
    );
  }
  const dev = persistedDevSecrets();
  _jwtSecret = _jwtSecret || dev.jwtSecret;
  _vaultKey  = _vaultKey  || dev.vaultKey;
}

if (_jwtSecret.length < 32 || _vaultKey.length < 32) {
  throw new Error('LLMIDE_JWT_SECRET and LLMIDE_VAULT_KEY must each be at least 32 chars');
}

// Optional previous JWT secret for zero-downtime rotation.
// To rotate:
//   1. Set LLMIDE_JWT_SECRET_PREVIOUS = current LLMIDE_JWT_SECRET
//   2. Set LLMIDE_JWT_SECRET           = new secret
//   3. Deploy — new tokens signed with new key; old tokens still verified
//      against previous key until they expire (LLMIDE_ACCESS_TTL_SEC, 15 min default)
//   4. After one TTL window, clear LLMIDE_JWT_SECRET_PREVIOUS
const _jwtSecretPrevious = envStr('LLMIDE_JWT_SECRET_PREVIOUS');
if (_jwtSecretPrevious && _jwtSecretPrevious.length < 32) {
  throw new Error('LLMIDE_JWT_SECRET_PREVIOUS must be at least 32 chars if set');
}

// Bcrypt cost guard.  Too low and online password cracking becomes
// feasible (cost 8 = ~25 ms = trivially crackable); too high and
// register/login wall-clock balloons (cost 14 = ~1.5s, painful).
// 10 is the modern floor for non-trivial deployments, 14 is the
// comfortable ceiling for an interactive auth path.
const _bcryptCost = envInt('LLMIDE_BCRYPT_COST', 12);
if (_bcryptCost < 10 || _bcryptCost > 14) {
  throw new Error(`LLMIDE_BCRYPT_COST must be between 10 and 14 (got ${_bcryptCost})`);
}

export const config = Object.freeze({
  env:          isProd ? 'production' : envStr('NODE_ENV', 'development'),
  isProd,

  // Server
  host:         envStr('LLMIDE_HOST', '127.0.0.1'),
  port:         envInt('LLMIDE_PORT', 3456),
  // Explicit opt-in required to bind a non-loopback address. The server has
  // no built-in TLS, so binding 0.0.0.0 without this flag is a fail-closed
  // startup error (see server.mjs listen handler).
  allowRemote:  envBool('LLMIDE_ALLOW_REMOTE', false),
  // 8 MB default matches .env.example and is large enough for a 1-hour
  // meeting transcript (~3 MB) plus JSON framing headroom.
  bodyLimitMB:  envInt('LLMIDE_BODY_LIMIT_MB', 8),
  trustProxy:   envBool('LLMIDE_TRUST_PROXY', false),

  // Database
  dbPath:       envStr('LLMIDE_DB_PATH', path.join(ROOT, 'kb', 'data.db')),

  // Auth
  jwtSecret:    _jwtSecret,
  jwtIssuer:    envStr('LLMIDE_JWT_ISSUER', 'llmide'),
  accessTokenTTLSec:  envInt('LLMIDE_ACCESS_TTL_SEC',  15 * 60),         // 15 min
  refreshTokenTTLSec: envInt('LLMIDE_REFRESH_TTL_SEC', 30 * 24 * 60 * 60), // 30 days
  bcryptCost:   _bcryptCost,

  // Vault
  vaultKey:     _vaultKey,

  // JWT rotation support
  jwtSecretPrevious: _jwtSecretPrevious || null,

  // Logging
  logLevel:     envStr('LLMIDE_LOG_LEVEL', isProd ? 'info' : 'debug'),
  logJson:      envBool('LLMIDE_LOG_JSON', isProd),

  // Registration
  // Defaults to CLOSED in production (NODE_ENV=production) — a new
  // deployment should not accept arbitrary self-registrations until the
  // operator explicitly opens it.  In dev/test the default is open so
  // first-run setup still works without extra env vars.
  // Set LLMIDE_DISABLE_REGISTRATION=0 to re-open in prod, or
  // LLMIDE_DISABLE_REGISTRATION=1 to force-close in dev.
  registrationOpen: isProd
    ? !envBool('LLMIDE_DISABLE_REGISTRATION', true)   // prod: closed unless opt-in
    : !envBool('LLMIDE_DISABLE_REGISTRATION', false),  // dev:  open unless opt-out

  // CORS — comma-separated list of allowed origins beyond the always-
  // accepted chrome-extension://* / localhost / 127.0.0.1 set.
  extraCorsOrigins: envStr('LLMIDE_CORS_ORIGINS', '').split(',').map((s) => s.trim()).filter(Boolean),
});

// Tiny config-summary helper for boot-time logging.  Never includes the
// actual secrets — only their digests so you can verify config drift
// without exposing the values themselves.
export function configSummary() {
  const digest = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 8);
  return {
    env: config.env,
    host: config.host,
    port: config.port,
    dbPath: config.dbPath,
    jwtSecretDigest: digest(config.jwtSecret),
    vaultKeyDigest:  digest(config.vaultKey),
    accessTokenTTLSec: config.accessTokenTTLSec,
    registrationOpen: config.registrationOpen,
  };
}
