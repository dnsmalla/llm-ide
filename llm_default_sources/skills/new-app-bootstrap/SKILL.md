---
name: new-app-bootstrap
description: Build a production-shaped auto-system project from a prompt. Use when the user says "build a new app", "scaffold a project", "start from scratch", "I want to make a [kind of app]", "bootstrap", or when the repo has no `system.yaml` yet. This is the first-mile orchestrator — it decides which system.yaml fields to fill, sequences the generators, and hands off to the targeted `configure-*` skills for deep config.
---

# New app bootstrap

Turn a product description into a configured, generator-ran auto-system project ready to run locally. Every decision here flows through `system.yaml`, so subsequent changes go through the right `configure-*` skill and the compliance gates already know about them.

## When to use

- "Build me a [team todo | marketplace | note-taking | fitness | …] app"
- "Start a new auto-system project"
- "I cloned the repo — what's next?"
- Repo has no `.auto_system/system.yaml` yet, or it contains only the template defaults

## Do NOT

- Write raw HTML/SwiftUI/Compose before the generators have run — screens must compose primitives (Layer 2) and primitives exist only after the generators emit them.
- Skip `theme:` and reach for hex codes in CSS. Layer 3 compliance will fail the build.
- Run the generators in arbitrary order — DB schema depends on entities, server auth templates depend on auth policy, Settings UI depends on `settings.sections`.

## Decision order — fill these in `system.yaml` first

Match the user's prompt to answers for each block. Skip what isn't asked for; defaults are sensible.

1. **`project.name`** — one word, camelCase-friendly (`MyApp`, not "My Cool App").
2. **`platforms[]`** — which of web / iOS / android / backend are in scope? Leave `active: false` on platforms the user isn't shipping yet; they still get scaffolded for later.
3. **`buildStrategy`** — default `web_cascade` (build web first, mirror to native). Use `standard` only if iOS or Android is the primary platform.
4. **`advisor`** — the MOST load-bearing block for greenfield:
   - `description`: one paragraph of the app idea
   - `features[]`: 3–8 bullet points of must-ship features
   - `securityLevel`: `standard` for MVP, `high` for anything user-data-heavy, `critical` for payments/health/auth-primary apps (raises compliance bars — see `configure-auth`)
   - `quality.performance`: `pro` default; `extreme` for real-time/large-scale
5. **`theme`** — brand color + font. Everything else defaults.
6. **`auth`** — touch only if non-default (delegate to `configure-auth` skill when it gets complicated)
7. **`settings.sections`** — keep the 4 default sections unless the product is unusual
8. **`database.engine` / `database.entities`** — declare the core tables (delegate to `configure-database`)
9. **`backend`** — touch only for prod concerns (CORS origins, rate limits) — delegate to `configure-backend`

## Generator sequence (binding order)

After `system.yaml` is filled in:

```
./sc.sh init                     # (once) — fetches submodules, seeds .system-controller bundle
./master.sh theme sync           # generates design tokens per platform
./master.sh generate:database    # schema.ts + migrations SQL from database.entities
./master.sh generate:templates   # web/iOS/Android/backend files from config + auth/settings/theme
./master.sh generate:guide       # rewrites AGENT_GUIDE.md from system.yaml
./master.sh compliance           # fails on any drift / missing piece
./master.sh status               # quick sanity
```

The order is binding: `theme sync` runs before `generate:templates` because primitives read from token files; `generate:database` runs before server templates so `routes/auth.ts` can reference schema types later; `compliance` runs last so it sees the final state.

## Common app archetypes (starter config)

### B2C product (marketplace, social, content)

```yaml
advisor: { securityLevel: "high" }
auth:
  password: { minLength: 10, minDistinctClasses: 2 }
  mfa: { enabled: true, required: false, methods: ["totp"] }
  oauth: { providers: ["google", "apple"] }
database:
  engine: "postgres"
  extensions: ["pgcrypto", "pg_trgm"]
backend:
  rateLimits:
    byRoute: [{ path: "/v1/auth", windowMs: 60000, max: 10 }]
```

### SaaS / internal tool (team-owned, admin UI)

```yaml
advisor: { securityLevel: "high" }
auth:
  password: { minLength: 12, minDistinctClasses: 3, requireUppercase: true }
  mfa: { enabled: true, required: true, methods: ["totp", "webauthn"] }
  roles:
    - { id: "user",  permits: ["/app/*", "/account/*"] }
    - { id: "admin", permits: ["/admin/*", "/app/*", "/account/*"] }
database:
  extensions: ["pgcrypto"]
```

### Consumer mobile (iOS-first)

```yaml
buildStrategy: "standard"         # don't cascade from web
platforms:
  - { name: "ios",     path: "apps/ios/MyApp",     active: true }
  - { name: "web",     path: "apps/web",           active: false }
  - { name: "backend", path: "services/core-api",  active: true }
auth:
  oauth: { providers: ["apple", "google"] }
```

### Payments / health / compliance-heavy

```yaml
advisor: { securityLevel: "critical" }
# critical forces: password ≥ 12 + 3 classes, mfa.required=true, refresh TTL ≤ 14d, SECURITY_BASELINE.md present
auth:
  session: { refreshTokenTtl: 1209600 }   # 14d exactly
backend:
  passwordHash: { scryptN: 32768 }         # ~150ms/login on current hardware
  logging: { level: "warn", redactHeaders: ["authorization", "cookie", "x-api-key", "stripe-signature"] }
```

## Steps

1. **Classify the prompt** against an archetype; start from that starter config.
2. **Fill `system.yaml`** — `project`, `platforms`, `advisor.description/features`, `theme.colors.primary`, any archetype-specific overrides.
3. **Declare core entities** (users + the 1–3 dominant nouns of the product) under `database.entities`. Anything else can be added later via `configure-database`.
4. **Run the generator sequence** in the binding order above.
5. **Read `compliance`'s output.** Fail-fix-rerun until green. Typical first-run failures:
   - Missing `docs/openapi.yaml` → `/v1/auth/*` routes
   - Password policy below the `securityLevel` floor → `configure-auth`
   - No entity coverage → declared but not generated → re-run `generate:database`
6. **Delegate deeper edits** to the right `configure-*` skill rather than hand-editing the YAML by hand.

## Hand-off to other skills

- Heavier auth changes → `configure-auth`
- Add/edit tables → `configure-database`
- Add a feature end-to-end → `add-feature`
- Branding / dark mode / spacing → `configure-app-settings`
- Prod deploy → `deploy-prod`
- Perf budgets → `performance-budget`

## Output format

1. **Archetype chosen** — one sentence with why
2. **Diff of `system.yaml`** — the full new/changed content
3. **Generator run log** — condensed, one line per step
4. **Compliance summary** — pass count / fail list
5. **Next actions** — 2–3 specific follow-ups the user should make (add real OAuth client IDs, write SECURITY_BASELINE.md, etc.)
6. **Rule stack** — `.cursorrules → orchestration_policy.mdc → new-app-bootstrap/SKILL.md → AGENT_GUIDE.md`

---

## Ready-to-paste: complete `system.yaml` for a B2C SaaS (copy + edit)

Drop this whole file at `.auto_system/system.yaml` and run the generator sequence. Every line is exercised; no placeholders hidden.

```yaml
project:
  name: "AppName"          # keep CamelCase-friendly — used for package names
  version: "1.0.0"

platforms:
  - { name: "web",     path: "apps/web",             active: true }
  - { name: "backend", path: "services/core-api",    active: true }
  - { name: "ios",     path: "apps/ios/AppName",     active: false }  # flip to true when ready
  - { name: "android", path: "apps/android",         active: false }

buildStrategy: "web_cascade"

advisor:
  description: "Short paragraph describing the product, target user, and the 1–2 most important interactions."
  features:
    - "User accounts with email + password + Google sign-in"
    - "Create, edit, delete posts; feed of everyone's posts"
    - "Mark posts as private"
  securityLevel: "high"
  quality:
    performance: "pro"
    accessibility: true
    designPolish: true

theme:
  colors:
    primary: "#6366F1"
    background: "#FFFFFF"
    surface: "#F3F4F6"
  schemes:                  # opt-in dark mode; any missing role falls back to light
    light: { primary: "#6366F1", background: "#FFFFFF", surface: "#F3F4F6" }
    dark:  { primary: "#818CF8", background: "#0B0F1A", surface: "#111827" }
  layout:
    pageMargin: { mobile: 16, tablet: 24, desktop: 32 }
  typography:
    fontFamily: "Inter"

auth:
  password:
    minLength: 10
    minDistinctClasses: 2
    requireNumber: true
  session:
    accessTokenTtl: 3600       # 1h
    refreshTokenTtl: 2592000   # 30d
    refreshStrategy: "rotate"
  mfa:
    enabled: true
    required: false            # recommend; raise to true once users are onboarded
    methods: ["totp"]
  oauth:
    providers: ["google"]
  email:
    verificationRequired: true
  apiPrefix: "/v1/auth"
  roles:
    - { id: "user",  description: "Standard user",   permits: ["/app/*", "/account/*", "/settings"] }
    - { id: "admin", description: "Operator access", permits: ["/admin/*", "/app/*", "/account/*"] }

database:
  engine: "postgres"
  urlEnvVar: "DATABASE_URL"
  extensions: ["pgcrypto", "pg_trgm"]
  entities:
    - name: "posts"
      description: "User-authored posts in the feed"
      columns:
        - { name: "id",         type: "uuid",      primaryKey: true }
        - { name: "user_id",    type: "uuid",      references: { entity: "users", column: "id", onDelete: "cascade" } }
        - { name: "title",      type: "text" }
        - { name: "body",       type: "text",      nullable: true }
        - { name: "is_private", type: "boolean",   default: false }
        - { name: "created_at", type: "timestamp", default: "now()" }
        - { name: "updated_at", type: "timestamp", default: "now()" }
      indexes:
        - { name: "posts_user_id_idx",    columns: ["user_id"] }
        - { name: "posts_created_at_idx", columns: ["created_at"] }

backend:
  port: 3001
  apiPrefix: "/v1"
  cors:
    allowedOrigins: []
    allowedOriginsEnv: "CORS_ALLOWED_ORIGINS"   # runtime list via env (comma-separated)
    credentials: true
  rateLimits:
    default: { windowMs: 60000, max: 120 }
    byRoute:
      - { path: "/v1/auth", windowMs: 60000, max: 20 }
  logging:
    level: "info"
    redactHeaders: ["authorization", "cookie", "x-api-key"]
  observability:
    metricsEnabled: true
    metricsPath: "/metrics"
    tracingEnabled: false
    tracingEnvVar: "OTEL_EXPORTER_OTLP_ENDPOINT"
  passwordHash:
    algorithm: "scrypt"
    scryptN: 16384             # bump to 32768 at production deploy

settings:
  sections:
    - id: "appearance"
      title: "Appearance"
      items:
        - { key: "themeMode", label: "Theme", type: "select", default: "auto",
            options: [{ value: "auto", label: "System" }, { value: "light", label: "Light" }, { value: "dark", label: "Dark" }],
            requiresAuth: false }
    - id: "notifications"
      title: "Notifications"
      items:
        - { key: "emailDigest", label: "Email digest",       type: "boolean", default: true }
        - { key: "pushEnabled", label: "Push notifications", type: "boolean", default: true }
    - id: "privacy"
      title: "Privacy"
      items:
        - { key: "telemetry", label: "Share anonymous usage data", type: "boolean", default: false, requiresAuth: false }
        - { key: "dataExport", label: "Download your data", type: "action", href: "/account/data" }
    - id: "account"
      title: "Account"
      items:
        - { key: "security", label: "Security & MFA", type: "link", href: "/account/security" }
        - { key: "signOut",  label: "Sign out",        type: "action" }
        - { key: "deleteAccount", label: "Delete account", type: "link", href: "/account/delete", danger: true }
```

## Ready-to-paste: full bootstrap run

```bash
# In the host project root (parent of .system-controller/):
./sc.sh init                                # once; installs the bundle
vim .auto_system/system.yaml                # paste the block above, edit project.name + advisor

# Generator pipeline (order is binding):
bash .system-controller/submodules/.auto_system_engine/master.sh theme sync
bash .system-controller/submodules/.auto_system_engine/master.sh generate:database
bash .system-controller/submodules/.auto_system_engine/master.sh generate:templates
bash .system-controller/submodules/.auto_system_engine/master.sh generate:guide
bash .system-controller/submodules/.auto_system_engine/master.sh compliance
bash .system-controller/submodules/.auto_system_engine/master.sh status

# Install per-app deps:
(cd apps/web && npm ci)
(cd services/core-api && npm ci)

# Start DB + apply migrations:
docker run -d --name appname-db -e POSTGRES_PASSWORD=devpw -p 5432:5432 postgres:16
export DATABASE_URL="postgres://postgres:devpw@localhost:5432/postgres"
psql "$DATABASE_URL" -f services/core-api/db/migrations/000_extensions.sql
(cd services/core-api && npx drizzle-kit generate:pg && npx drizzle-kit migrate)

# Run everything:
(cd services/core-api && PORT=3001 npm run dev) &
(cd apps/web && NEXT_PUBLIC_API_URL=http://localhost:3001 npm run dev) &
```

Expected output after `compliance`: all checks pass except any you haven't provisioned yet (OAuth client ID, SECURITY_BASELINE.md at `securityLevel: high`). Fix those by following the hand-off skills.
