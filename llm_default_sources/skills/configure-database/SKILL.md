---
name: configure-database
description: >-
  Configure database schema in auto-system projects. Trigger on: "add a posts
  table", "new entity", "migration", "switch to sqlite", "enable pgvector for AI
  search", "add index on user_id", "seed fixtures", or edits to the database:
  block in system.yaml. Do NOT hand-edit services/core-api/src/db/schema.ts —
  declare entities in config and re-run generate:database.
---

# Configure database

`system.yaml → database:` is the single source of truth for the DB engine, declared entities, Postgres extensions, and seed data. `services/core-api/src/db/schema.ts` (Drizzle ORM) and `services/core-api/db/migrations/000_extensions.sql` are generated from this block. Editing schema.ts directly means it gets overwritten at next `generate:database`.

## When to use

- "Add a `posts` table" / "new entity"
- "Add `user_id` foreign key to `comments`"
- "Index email for faster lookup"
- "Turn on `pgvector` so we can do embeddings"
- "Switch local dev to SQLite"
- "Add seed fixtures for testing"
- "Our DATABASE_URL env is named differently"

## The config surface

```yaml
database:
  engine: "postgres"           # postgres | mysql | sqlite
  urlEnvVar: "DATABASE_URL"    # UPPER_SNAKE_CASE; read by env.ts
  extensions: []               # postgres only: uuid-ossp | pgcrypto | pgvector | citext | pg_trgm
  entities: []                 # empty = default scaffold (users, sessions, accounts, audit_logs for postgres)
  seed:
    enabled: false
    path: "services/core-api/db/seed.sql"
  docsPath: "docs/03-database"
  schemaPath: "services/core-api/db/schema.ts"
  migrationsPath: "services/core-api/db/migrations"
```

## Entity shape

```yaml
entities:
  - name: "posts"                          # lower_snake_case
    description: "User-authored posts"
    columns:
      - { name: "id", type: "uuid", primaryKey: true }            # uuid PK auto-gets .defaultRandom() on postgres
      - { name: "user_id", type: "uuid", references: { entity: "users", column: "id", onDelete: "cascade" } }
      - { name: "title", type: "text" }                            # notNull is the default
      - { name: "body", type: "text", nullable: true }
      - { name: "published_at", type: "timestamp", nullable: true }
      - { name: "created_at", type: "timestamp", default: "now()" }
      - { name: "view_count", type: "int", default: 0 }
    indexes:
      - { name: "posts_user_id_idx", columns: ["user_id"] }
      - { name: "posts_slug_uniq", columns: ["slug"], unique: true }
```

### Column types (engine-mapped automatically)

| Declared | Postgres | MySQL | SQLite |
|----------|----------|-------|--------|
| `uuid`   | `uuid`   | `varchar(36)` | `text` |
| `text`   | `text`   | `text` | `text` |
| `int`    | `integer`| `int`  | `integer` |
| `bigint` | `bigint` | `bigint` | `integer` |
| `boolean`| `boolean`| `boolean` | `integer(mode:boolean)` |
| `jsonb`  | `jsonb`  | `json` | `text(mode:json)` |
| `timestamp` | `timestamp` | `timestamp` | `integer(mode:timestamp)` |
| `date`   | `date`   | `date` | `text` |
| `numeric`| `numeric`| `decimal(18,6)` | `real` |
| `bytea`  | `bytea`  | `binary` | `blob` |

### FK options

`references.onDelete`: `cascade` | `set_null` | `restrict` | `no_action` (default).

### Defaults

- Numeric/boolean literals: rendered as-is.
- String literals: JSON-stringified (quoted).
- SQL expressions ending in `()` such as `"now()"` render as `.defaultNow()` on postgres; other fn expressions render as `.default(sql\`${expr}\`)`.

## Steps

1. **Edit `system.yaml`** — add / modify entities, extensions, or engine.
2. **Regenerate** — `./master.sh generate:database` rewrites schema.ts and emits `000_extensions.sql` if postgres extensions are declared. Seed file is written only when `seed.enabled: true` and does not exist.
3. **Generate migration** — Drizzle's own tool handles table migrations *from* schema.ts; run the project's migrator (e.g. `drizzle-kit generate`). Auto-system does not yet emit per-entity migration diffs — schema drift between runs is your responsibility.
4. **Apply migration** — `psql "$DATABASE_URL" < services/core-api/db/migrations/000_extensions.sql` (extensions only, one-time), then your migrator's `migrate` command for table DDL.
5. **Verify compliance** — `./master.sh compliance` confirms every declared entity has a matching `export const` in schema.ts.

## Common tasks

- **Add a table:** append an entry to `entities[]` with columns + indexes, re-run `generate:database`, then let Drizzle emit the migration.
- **Enable pgvector:** set `extensions: ["pgvector"]` — the migration runs `CREATE EXTENSION IF NOT EXISTS "pgvector"` once at deploy. The declared column types do **not** yet include a native `vector` type; until that lands, drop the vector column by editing `schema.ts` directly with Drizzle's `customType<Vector>({ dataType: () => 'vector(1536)' })` (scoped as a "Known gap"). Every other declared column in the same table stays config-driven.
- **Switch engine for dev:** change `engine: "sqlite"` locally. The generated schema.ts swaps drivers automatically; your app code stays the same (Drizzle's generic API).
- **Add index:** append to `entities[].indexes`. The generator emits a sibling `<table>Indexes` const listing columns; drizzle-kit picks it up at migration generation.
- **Rename FK target:** update both the referenced entity's `name` and every `references.entity` pointing at it.

## Guidelines

- **Entities in system.yaml ≠ migrations.** Declaring an entity doesn't apply a migration — it only updates the schema.ts. Wire `generate:database` into your normal migration generator (drizzle-kit) in CI.
- **Keep FK targets declared before their consumers** in the entities list (the generator emits in array order; camelCase references require the target table var to already exist in scope).
- **Don't mix engines** in one project for prod. The generator supports three, but multi-engine code needs engine-specific query shims.
- **Postgres extensions require superuser.** If `CREATE EXTENSION` fails, enable on RDS/CloudSQL via console, then re-run the migration.

## Output format

1. **Diff of `system.yaml`** — `database.*` fields added/changed
2. **Schema summary** — list of entities now present (name + column count + FK graph)
3. **Regeneration log** — `./master.sh generate:database` output; note which files changed
4. **Migration checklist** — extensions SQL (one-time), drizzle-kit command to run, apply instruction
5. **Rule stack** — `.cursorrules → orchestration_policy.mdc → configure-database/SKILL.md → AGENT_GUIDE.md`

---

## Ready-to-paste: common entity patterns

### User-owned content (blog posts, comments, items)

```yaml
- name: "posts"
  description: "User-authored posts in the feed"
  columns:
    - { name: "id",         type: "uuid",      primaryKey: true }
    - { name: "user_id",    type: "uuid",      references: { entity: "users", column: "id", onDelete: "cascade" } }
    - { name: "title",      type: "text" }
    - { name: "body",       type: "text",      nullable: true }
    - { name: "created_at", type: "timestamp", default: "now()" }
    - { name: "updated_at", type: "timestamp", default: "now()" }
  indexes:
    - { name: "posts_user_id_idx",    columns: ["user_id"] }
    - { name: "posts_created_at_idx", columns: ["created_at"] }
```

### Soft-deletable record (keep data, hide by default)

```yaml
- name: "documents"
  columns:
    - { name: "id",         type: "uuid", primaryKey: true }
    - { name: "user_id",    type: "uuid", references: { entity: "users", column: "id", onDelete: "cascade" } }
    - { name: "title",      type: "text" }
    - { name: "content",    type: "text" }
    - { name: "created_at", type: "timestamp", default: "now()" }
    - { name: "deleted_at", type: "timestamp", nullable: true }   # NULL = active
  indexes:
    - { name: "documents_user_active_idx", columns: ["user_id", "deleted_at"] }  # supports "active docs for user"
```

Query rule: every listing endpoint filters `WHERE deleted_at IS NULL`.

### Multi-tenant (org → members → resources)

```yaml
- name: "organizations"
  columns:
    - { name: "id",         type: "uuid", primaryKey: true }
    - { name: "slug",       type: "text", unique: true }
    - { name: "name",       type: "text" }
    - { name: "created_at", type: "timestamp", default: "now()" }

- name: "memberships"
  description: "User ↔ org with role"
  columns:
    - { name: "id",              type: "uuid", primaryKey: true }
    - { name: "organization_id", type: "uuid", references: { entity: "organizations", column: "id", onDelete: "cascade" } }
    - { name: "user_id",         type: "uuid", references: { entity: "users",         column: "id", onDelete: "cascade" } }
    - { name: "role",            type: "text", default: "member" }   # owner | admin | member
    - { name: "created_at",      type: "timestamp", default: "now()" }
  indexes:
    - { name: "memberships_unique_user_org", columns: ["user_id", "organization_id"], unique: true }

- name: "org_documents"          # every resource carries an org_id for isolation
  columns:
    - { name: "id",              type: "uuid", primaryKey: true }
    - { name: "organization_id", type: "uuid", references: { entity: "organizations", column: "id", onDelete: "cascade" } }
    - { name: "created_by",      type: "uuid", references: { entity: "users",         column: "id", onDelete: "set_null" }, nullable: true }
    - { name: "title",           type: "text" }
    - { name: "created_at",      type: "timestamp", default: "now()" }
  indexes:
    - { name: "org_documents_org_idx", columns: ["organization_id"] }
```

Query rule: every query filters `WHERE organization_id = $1` from the current session's active org; pull active org from `memberships`.

### Audit log (append-only history)

```yaml
- name: "audit_logs"
  description: "Append-only record of sensitive actions"
  columns:
    - { name: "id",          type: "uuid", primaryKey: true }
    - { name: "actor_id",    type: "uuid", references: { entity: "users", column: "id", onDelete: "set_null" }, nullable: true }
    - { name: "action",      type: "text" }            # e.g. "user.delete", "posts.update"
    - { name: "entity_type", type: "text" }
    - { name: "entity_id",   type: "text", nullable: true }
    - { name: "meta",        type: "jsonb", nullable: true }
    - { name: "created_at",  type: "timestamp", default: "now()" }
  indexes:
    - { name: "audit_logs_actor_idx",      columns: ["actor_id", "created_at"] }
    - { name: "audit_logs_entity_idx",     columns: ["entity_type", "entity_id"] }
```

Emit from every mutating route; never update or delete rows.

### Full-text search (requires `pg_trgm`)

```yaml
extensions: ["pg_trgm"]        # top-level of database:
entities:
  - name: "articles"
    columns:
      - { name: "id",       type: "uuid", primaryKey: true }
      - { name: "title",    type: "text" }
      - { name: "body",     type: "text" }
      - { name: "search",   type: "text" }   # denormalized: title + body concatenated on write
    indexes:
      - { name: "articles_search_trgm", columns: ["search"] }
```

Post-generation, manually add a GIN trigram index (drizzle-kit's diff won't do this):
```sql
CREATE INDEX articles_search_trgm_gin ON articles USING GIN (search gin_trgm_ops);
```

## Ready-to-paste: migration run (after every `generate:database`)

```bash
# 1. Apply extensions once (one-time per database):
psql "$DATABASE_URL" -f services/core-api/db/migrations/000_extensions.sql

# 2. Let drizzle-kit diff schema.ts against the DB and emit per-entity SQL:
cd services/core-api
npx drizzle-kit generate:pg

# 3. Review the new migration file in db/migrations/* — destructive operations
#    (DROP COLUMN, RENAME) need explicit approval. Expand-contract for rollouts.
cat db/migrations/<latest>.sql

# 4. Apply:
npx drizzle-kit migrate

# 5. (Optional) seed dev data:
psql "$DATABASE_URL" < db/seed.sql
```

## Repository + service layer: generated, not written

Once the entity is declared and the schema emitted, the layered backend comes
from the generator — do not author it:

```bash
./master.sh generate:feature      # schema, repo, service, route, integration test
```

For every `database.entities[]` entry that produces:

| File | Note |
|---|---|
| `src/schemas/<e>.schema.ts` | validation schema |
| `src/repositories/<e>Repo.ts` | table reads/writes |
| `src/services/<e>.service.ts` | business rules over the repo |
| `src/routes/<e>.ts` | HTTP surface, registered in `routes/index.ts` automatically |
| `src/__tests__/<e>.integration.test.ts` | integration test |

The DB client is **already** generated at `src/db/index.ts` by the `db-core`
slice. Do not create `db/client.ts` — that path does not exist in a generated
project and a second client would open a competing connection pool.

Write a repository or service by hand only when the entity needs behaviour the
generator cannot express, and say so in your hand-off.
