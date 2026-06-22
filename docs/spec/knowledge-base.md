---
title: Knowledge base — spec
status: draft
---

# Knowledge base — spec

Rebuild-grade contract for the KB subsystem. Every claim here is verified against source with a `file:line` citation. Structured table/index facts link to the generated reference page rather than being copied.

---

## 1. Scope

This spec governs the following files:

**Storage layer**

| File | Role |
|---|---|
| `extension/kb/db.mjs` | `getDb()`, `requireUser()`, `buildMatchExpr()`, `search()`, `findContext()`, `genId()`, plus email-dedup and `deleteUserCascade()` |
| `extension/kb/meetings.mjs` | Meeting + entity CRUD, `statsAdmin()` |
| `extension/kb/sources.mjs` | External-source ingestion (`code`, `ticket`, `qa`, `doc`) |
| `extension/kb/plans.mjs` | Plan + task CRUD |
| `extension/kb/personas.mjs` | Agent personas + ask-history |
| `extension/kb/feedback.mjs` | Agent-question feedback verdicts |
| `extension/kb/reviews.mjs` | Review-queue helpers |
| `extension/kb/outcomes.mjs` | Outcome-polling helpers |
| `extension/kb/user.mjs` | Per-user repos, prefs, JWT revocation |
| `extension/kb/exporter.mjs` | Project full-export iterator |
| `extension/kb/project-export.mjs` | `exportProject()` |

**Migrations**

| File | Role |
|---|---|
| `extension/kb/migrations.mjs` | `applyMigrations()`, `migrationStatus()`, checksum logic |
| `extension/kb/migrations/0001_initial.sql` through `0016_token_epoch.sql` | DDL deltas (16 files as of this writing). Recent: `0014_fts_update_triggers.sql` + `0015_outcomes_fts_body.sql` add AFTER-UPDATE FTS triggers (so edits, not just inserts/deletes, reindex); `0016_token_epoch.sql` adds the `users.tokens_valid_after` access-token-epoch column. No new tables since 0013. |

**HTTP routing**

| File | Role |
|---|---|
| `extension/kb/router.mjs` | `handleKB()` — top-level `/kb/*` dispatcher |
| `extension/kb/routes/agent.mjs` | Agent-persona and ask-history routes |
| `extension/kb/routes/live.mjs` | SSE live-session routes |
| `extension/kb/routes/planning.mjs` | Planning-agent routes |
| `extension/kb/routes/review.mjs` | Codegen-apply and review-queue routes |

**Vault**

| File | Role |
|---|---|
| `extension/server/vault.mjs` | AES-256-GCM encrypt/decrypt, HKDF key derivation, `setSecret`/`getSecret`, `ALLOWED_KEYS` |

---

## 2. Storage contract

### Full DDL

The complete DDL — column types, constraints, indexes, the `search` FTS5 virtual table, and all triggers — is in the generated reference page:

**[`../reference/database-schema.md`](../reference/database-schema.md)**

That page is generated from `extension/kb/migrations/*.sql` and must not be edited by hand. Summary of what is there:

- 20 tables: `agent_ask_messages`, `agent_feedback`, `audit_log`, `email_seen`, `email_state`, `entities`, `meetings`, `outcomes`, `password_reset_tokens`, `plan_tasks`, `plans`, `rate_limit_buckets`, `refresh_tokens`, `review_items`, `revoked_jti`, `schema_migrations`, `sources`, `user_flags`, `user_repos`, `user_secrets`, `users`.
- 1 FTS5 virtual table: `search` (columns: `meeting_id UNINDEXED`, `entity_id UNINDEXED`, `kind UNINDEXED`, `title`, `body`; tokenizer: `unicode61 remove_diacritics 2`).
- Triggers maintaining the FTS index automatically on INSERT/UPDATE/DELETE of `meetings`, `entities`, `sources`, `plans`, `plan_tasks`, and `outcomes`.
- 38 explicit indexes (see the reference page's Indexes table).

### SQLite PRAGMAs

Set once per connection inside `getDb()` (`extension/kb/db.mjs:54–62`):

```
PRAGMA journal_mode = WAL
PRAGMA synchronous = NORMAL
PRAGMA foreign_keys = ON
PRAGMA busy_timeout = 5000
PRAGMA wal_autocheckpoint = 1000
PRAGMA temp_store = MEMORY
PRAGMA mmap_size = 67108864
```

`mmap_size` is 67,108,864 bytes (64 MiB). `busy_timeout` is 5,000 ms. `wal_autocheckpoint` fires every 1,000 WAL pages. PRAGMAs are applied by iterating the array and calling `db.pragma(p.replace(/^PRAGMA\s+/i, ''))` — they are NOT run inside migrations because PRAGMAs do not survive a transaction context (`extension/kb/migrations/0001_initial.sql:1–3`).

On graceful shutdown (`closeDb()`), the server calls `PRAGMA wal_checkpoint(TRUNCATE)` before closing the handle (`extension/kb/db.mjs:86`).

### ID generation

Non-integer primary keys are minted by `genId(prefix)` (`extension/kb/db.mjs:410–418`):

```
`${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(12).toString('base64url')}`
```

12 bytes of CSPRNG entropy encoded as base64url (16 characters). The timestamp prefix preserves rough sort order.

---

## 3. Migration protocol

Source: `extension/kb/migrations.mjs`.

### `schema_migrations` table shape

Defined at `migrations.mjs:42–49`:

| Column | Type / constraint |
|---|---|
| `version` | `INTEGER PRIMARY KEY` |
| `name` | `TEXT NOT NULL` |
| `applied_at` | `TEXT NOT NULL DEFAULT (datetime('now'))` |
| `checksum` | `TEXT` (nullable — older rows may be NULL) |

### Ordering and application rules

1. Migration files must match `FILE_RE = /^(\d{3,4})_([\w.-]+)\.sql$/` (`migrations.mjs:21`). Files that do not match are silently skipped.
2. Files are sorted numerically by the leading digit prefix (`migrations.mjs:61`), not lexically.
3. Each migration runs inside a `db.transaction()` so it is atomic — either the SQL and the `schema_migrations` INSERT both succeed, or neither does (`migrations.mjs:108–113`).
4. There are no down-migrations. Rollback = restore from backup (`migrations.mjs:11–13`).
5. There is no single schema-version constant. The effective schema version is the `version` of the last row in `schema_migrations` (i.e. the highest-numbered applied migration).

### Checksum algorithm

FNV-1a 32-bit over the full UTF-8 file text (`migrations.mjs:64–75`):

```
let h = 0x811c9dc5;
for each char: h ^= charCode; h = Math.imul(h, 0x01000193);
return (h >>> 0).toString(16).padStart(8, '0');
```

### Checksum-mismatch behavior

`migrations.mjs:90–106`:

- **In `NODE_ENV=production`**: throws — the server refuses to start.
- **Outside production**: logs a `migration_checksum_mismatch` warning and continues (does not fail).

### Special case: duplicate-column ALTER TABLE

If a migration consists of exactly one `ALTER TABLE … ADD COLUMN` statement and `db.exec()` throws `"duplicate column name"`, the error is swallowed, the migration is recorded as applied, and startup continues (`migrations.mjs:119–136`). This special case is bounded to single-`ADD COLUMN` migrations only; multi-statement migrations re-throw.

---

## 4. Tenancy contract

Every piece of state is scoped to a `user_id`. The following MUST hold:

### (a) `requireUser` guard

Every state-mutating helper MUST call `requireUser(userId)` as its first action. The function is exported from `extension/kb/db.mjs:40–45`:

```js
export function requireUser(userId) {
  if (!userId || typeof userId !== 'string') {
    throw new Error('userId is required for tenanted operations');
  }
  return userId;
}
```

It throws `Error('userId is required for tenanted operations')` on any falsy or non-string value. There is no "legacy fallback" silent path.

### (b) FTS index is shared; hydration is `user_id`-scoped

The `search` FTS5 virtual table is NOT partitioned by `user_id`. An FTS MATCH query returns rows from all tenants. Tenancy is enforced in the hydration step: after fetching FTS hits, `search()` and `findContext()` join each result back to its owning table (e.g. `meetings WHERE user_id = ?`, `plan_tasks WHERE user_id = ?`) and drop any hit whose hydration returns empty (`extension/kb/db.mjs:248–376`, especially lines 273–307 and 309–376).

In `findContext()`, an overshoot strategy is used to handle multi-tenant databases where other users' rows dominate the top of the global BM25 ranking: the first pass fetches `cap * 4` hits; if owned hits come up short and the pass hit its LIMIT, a second pass fetches up to `OVERSHOOT_DEEP_LIMIT = 400` hits (`extension/kb/db.mjs:524`).

### (c) Router reads `req.user.id`; returns 401 if absent

`extension/kb/router.mjs:61–65`:

```js
const userId = req.user?.id;
if (!userId) {
  sendJSON(res, 401, { error: { code: 'AUTH_REQUIRED', message: 'Authenticated user required' } });
  return true;
}
```

The router depends on upstream JWT middleware having already verified the token and attached `req.user` before `handleKB()` is called.

### (d) Legacy rows back-filled to `user_id = 'legacy'`

Migration `0002_multitenancy.sql:74–80` adds `user_id TEXT NOT NULL DEFAULT 'legacy'` to `meetings`, `entities`, `sources`, `plans`, `plan_tasks`, `review_items`, and `outcomes`. Any rows that pre-date multi-tenancy get `user_id = 'legacy'` automatically. A corresponding `users` row with `id='legacy'` is provisioned by the same migration (lines 92–94) with `status='disabled'` so it cannot be used to log in.

---

## 5. Search / FTS algorithm

### `buildMatchExpr(raw, mode)` — `extension/kb/db.mjs:112–122`

This is an unexported module-private function. Its exact behavior:

**Tokenization** (`db.mjs:115–118`):

```js
const tokens = raw
  .toLowerCase()
  .split(/[^\p{L}\p{N}_]+/u)        // split on any non-letter, non-digit, non-underscore
  .filter((t) => t.length >= 2 && t.length <= 64)
  .slice(0, 12);                     // cap at 12 terms
```

- Input is lowercased.
- Split character class: `[^\p{L}\p{N}_]` with the Unicode flag — any character that is not a Unicode letter, Unicode decimal digit, or underscore is a separator.
- Terms shorter than 2 characters or longer than 64 characters are dropped.
- At most 12 terms are kept (hard cap).

**Joining** (`db.mjs:120`):

```js
const joiner = mode === 'or' ? ' OR ' : ' ';
```

- `mode='and'` (default): terms are joined by a space — FTS5 AND semantics (every term must appear).
- `mode='or'`: terms are joined by ` OR ` — any term may appear (used for ranked retrieval).

**Term quoting** (`db.mjs:121`):

```js
return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(joiner);
```

Each token is wrapped in double-quotes (FTS5 phrase syntax) with internal double-quotes escaped by doubling.

**Empty-query fallback** (`db.mjs:155–231`):

When `buildMatchExpr(q)` returns `null` (empty string, non-string, or all tokens filtered out), the FTS path is skipped entirely. Instead, `search()` returns rows directly from the backing tables ordered by date DESC:

| `kind` filter | Table queried | Order |
|---|---|---|
| `'meeting'` or no filter | `meetings WHERE user_id = ?` | `date DESC LIMIT cap` |
| `'action'`, `'decision'`, `'blocker'` | `entities JOIN meetings WHERE e.kind = ? AND e.user_id = ?` | `m.date DESC LIMIT cap` |
| `'outcome'` | `outcomes WHERE user_id = ?` | `observed_at DESC LIMIT cap` |
| any other kind | `sources WHERE kind = ? AND user_id = ?` | `indexed_at DESC LIMIT cap` |

**`kind` filter values** (`db.mjs:175`, `db.mjs:262–263`):

The `search()` function accepts the following `kind` values:
- Entity kinds: `'meeting'`, `'action'`, `'decision'`, `'blocker'`
- Plan kinds: `'plan'`, `'task'`
- Outcome kind: `'outcome'`
- Source kinds: `'code'`, `'ticket'`, `'qa'`, `'doc'`

The `findContext()` function always queries with explicit kind arguments: `'meeting'`, `'task'`, `'code'`, `'ticket'`, `'blocker'` (`db.mjs:543–595`).

**`limit` cap**: maximum 100 results (`db.mjs:151`):

```js
const cap = Math.max(1, Math.min(100, Number(limit) || 20));
```

Default limit is 20.

---

## 6. Vault crypto

Source: `extension/server/vault.mjs`.

### Key derivation

`vault.mjs:49–52` (function `deriveDataKey`):

```
data_key = HKDF-SHA256(
  ikm    = config.vaultKey (the LLMIDE_VAULT_KEY env var, interpreted as a Buffer),
  salt   = Buffer.from(String(userId)),
  info   = Buffer.from('llmide-vault-v1'),
  length = 32 bytes
)
```

Hash: SHA-256. Output: 32 bytes (256 bits) — the AES-256 key. A distinct key is derived per user, so compromising one user's derived key does not compromise others.

### Ciphertext byte layout

`vault.mjs:21–24` (constants), `vault.mjs:58–67` (encrypt), `vault.mjs:70–79` (decrypt):

| Offset | Length | Content |
|---|---|---|
| 0 | 1 byte | Key version (`KEY_VERSION = 0x01`) |
| 1 | 12 bytes | IV (random, `crypto.randomBytes(12)`) |
| 13 | variable | AES-256-GCM ciphertext |
| last 16 | 16 bytes | GCM authentication tag |

Total overhead: 1 + 12 + 16 = 29 bytes. Blobs shorter than 29 bytes are rejected at decrypt time (`vault.mjs:72`).

The key-version byte is bound as GCM Additional Authenticated Data (AAD) in the current format (`vault.mjs:63–64`). Blobs written before AAD was introduced are transparently decrypted without AAD on first access and re-encrypted with AAD on the next `setSecret` write (`vault.mjs:83–104`).

### Algorithm

AES-256-GCM (`vault.mjs:58`): `crypto.createCipheriv('aes-256-gcm', key, iv)`.

### Allow-listed vault keys

`vault.mjs:110–133`. Any `setSecret` / `getSecret` call with a key not in this set throws `Error('Unknown vault key: <key>')`:

```
'github.token'
'backlog.apiKey'
'linear.apiKey'
'slack.webhookUrl'
'email.imapPassword'
'claude.apiKey'
'openai.apiKey'
'google.apiKey'
'custom.apiKey'
'custom.baseUrl'
```

The full array is also exported as `VAULT_KEYS` (`vault.mjs:193`).

### DB storage

Ciphertext is stored as `BLOB` in `user_secrets(user_id, secret_key, ciphertext)`. Setting a secret to `null` or `''` DELETEs the row rather than storing an empty blob (`vault.mjs:145–149`).

---

## 7. See also

- [`../explanation/server-internals.md`](../explanation/server-internals.md) — HTTP server request lifecycle, auth middleware, how `req.user` is attached before `handleKB()` is called.
- [`../explanation/architecture.md`](../explanation/architecture.md) — overall system architecture, where the KB subsystem sits relative to agents, the Mac client, and the extension server.

---

## Regeneration checklist
- [x] Every governed symbol/endpoint/table/prompt is present with its exact shape (no "etc.", no "see code").
- [x] Every magic number, timeout, cap, regex, and crypto parameter is stated.
- [x] Spot-check: the `meetings`/`search` schema, `buildMatchExpr`, the migration protocol, and the vault byte-layout were rebuilt from this page and match source.
- [x] Structured facts link to their extractor-generated reference page (no hand-copied drift).
