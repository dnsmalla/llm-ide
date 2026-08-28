---
name: configure-auth
description: >-
  Configure auth: password policy, session TTLs, MFA, OAuth, email verification,
  API prefix, roles. Trigger on: "tighten password rules", "require MFA", "raise
  session timeout", "add Google sign-in", "change /v1/auth prefix", "add an
  admin role", "make passwords 12 chars", "rotate refresh tokens", or edits to
  the auth: block in system.yaml. Do NOT hand-edit lib/auth.ts,
  services/auth-api.ts, or services/core-api/src/routes/auth.ts — those are
  generated.
---

# Configure auth

`system.yaml → auth:` is the single source of truth for password policy, session TTLs, MFA, OAuth providers, email verification, API prefix, and role→route permissions. The client (`apps/web/lib/auth.ts`, `services/auth-api.ts`) *and* the server (`services/core-api/src/routes/auth.ts`) are generated from this block — drift between them is a compliance failure.

## When to use

- "Require stronger passwords" / "12+ chars, require symbols"
- "Turn on MFA" / "require TOTP" / "add WebAuthn"
- "Change session timeout" / "rotate refresh tokens" / "longer remember-me"
- "Add Google / Apple / GitHub sign-in"
- "Require email verification before login"
- "Add admin role with access to /admin/*"
- "Move auth routes off `/v1/auth`"

## Do NOT hand-edit these

| File | Driven by |
|------|-----------|
| `apps/web/lib/auth.ts` — `AUTH_CONSTANTS` | `auth.password.*` |
| `apps/web/services/auth-api.ts` — URL prefix | `auth.apiPrefix` |
| `services/core-api/src/routes/auth.ts` — `PASSWORD_MIN`, `ACCESS_TTL_SEC`, `SCRYPT_N/R/P`, etc. | `auth.password.*`, `auth.session.*`, `backend.passwordHash.*` |
| `services/core-api/src/config/env.ts` — port / apiPrefix / CORS | `backend.*` |

Editing these manually triggers the compliance drift check and gets clobbered on the next `./master.sh generate:templates`.

## The config surface

```yaml
auth:
  password:
    minLength: 8            # int ≥ 6
    maxLength: 128
    requireUppercase: false # when true, server + client hard-reject missing class
    requireLowercase: false
    requireNumber: false
    requireSpecial: false
    minDistinctClasses: 2   # 1–4 distinct char classes required
  session:
    accessTokenTtl: 3600            # seconds
    refreshTokenTtl: 2592000        # 30 days
    idleTimeout: 1800
    rememberMeDays: 30
    refreshStrategy: "rotate"       # rotate | reuse (rotate is recommended)
  mfa:
    enabled: true
    required: false                 # critical securityLevel forces true
    methods: ["totp"]               # totp | sms | email | webauthn
  oauth:
    providers: []                   # google | apple | github | microsoft | facebook
  email:
    verificationRequired: false
    passwordlessEnabled: false
  apiPrefix: "/v1/auth"
  roles:
    - id: "user"
      description: "Standard authenticated user"
      permits: ["/app/*", "/account/*", "/settings"]
```

## Security-level gates (automatic)

`advisor.securityLevel` enforces a floor on `auth`:

| Level | Floor |
|-------|-------|
| `standard` | no extra gates |
| `high`     | `password.minLength ≥ 10`, `minDistinctClasses ≥ 2`, `mfa.enabled: true` |
| `critical` | `password.minLength ≥ 12`, `minDistinctClasses ≥ 3`, `mfa.required: true`, `session.refreshTokenTtl ≤ 14 days` |

Raising `securityLevel` can fail compliance until matching auth values are raised. Do both in the same edit.

## Steps

1. **Edit `system.yaml`** — change the relevant `auth.*` field(s).
2. **Regenerate** — `./master.sh generate:templates` (rewrites client `lib/auth.ts`, server `routes/auth.ts`, server `rateLimit.ts` if auth path changed).
3. **Verify** — `./master.sh compliance` — fails on:
   - Policy mismatch between client and server
   - Critical gate violations (e.g. critical + `mfa.required: false`)
   - Missing auth routes in `docs/openapi.yaml`
4. **Update docs** — if you added a new role, update the permits on every other role that should *not* reach that role's paths.

## Common tasks

- **Stricter passwords:** set `requireUppercase: true, requireNumber: true, minDistinctClasses: 3, minLength: 12`. Re-run templates; the existing user records keep their old hashes (they just have to meet the new rule next rotation).
- **Enforce MFA:** flip `mfa.required: true`. Ensure `routes/auth.ts` handlers are updated to enforce (the generated stub accepts any 6-digit code — wire a real verifier).
- **Add OAuth:** set `oauth.providers: ["google", "apple"]`. Current templates don't generate OAuth handlers — they declare intent. You'll add the handler in `services/core-api/src/routes/auth.ts` for now (this is a known gap).
- **Change API prefix:** edit `auth.apiPrefix` (e.g. `/v2/auth`). Regenerate. Update `docs/openapi.yaml` path prefix and any reverse-proxy rules.

## Guidelines

- Keep client and server on the same `auth.password` values. The drift check will flag you, but catch it before commit.
- Don't mix `auth.apiPrefix` with `backend.apiPrefix` — the former is just the auth sub-path, the latter is the server's root prefix. Routes resolve as `${backend.apiPrefix}${auth.apiPrefix}/…` in most deployments.
- `passwordless + passwordRules` are not mutually exclusive; keep both sensible — users who set a password still need to meet the rules.
- Touching `auth.roles` requires updating the router guard templates (Layer 4 doesn't generate them yet); this skill only sets the declarative intent.

## Output format

When applying an auth change, emit:

1. **Diff of `system.yaml`** — only the fields that changed
2. **Regeneration log** — output of `./master.sh generate:templates`
3. **Compliance result** — `./master.sh compliance` status (and which checks now pass/fail)
4. **Rule stack** — `.cursorrules → orchestration_policy.mdc → configure-auth/SKILL.md → AGENT_GUIDE.md`

---

## Ready-to-paste: strict production auth (copy + edit)

```yaml
auth:
  password:
    minLength: 12
    maxLength: 128
    requireUppercase: true
    requireLowercase: true
    requireNumber: true
    requireSpecial: false
    minDistinctClasses: 3
  session:
    accessTokenTtl: 1800              # 30m
    refreshTokenTtl: 1209600          # 14d (≤ what securityLevel=critical permits)
    idleTimeout: 900                  # 15m
    rememberMeDays: 14
    refreshStrategy: "rotate"
  mfa:
    enabled: true
    required: true                    # all users must set up MFA before protected routes
    methods: ["totp", "webauthn"]     # WebAuthn = passkeys
  oauth:
    providers: ["google", "apple", "microsoft"]
  email:
    verificationRequired: true
    passwordlessEnabled: false
  apiPrefix: "/v1/auth"
  roles:
    - { id: "user",    description: "Standard user",   permits: ["/app/*", "/account/*", "/settings"] }
    - { id: "staff",   description: "Support + ops",   permits: ["/staff/*", "/app/*", "/account/*"] }
    - { id: "admin",   description: "Full operator",   permits: ["/admin/*", "/staff/*", "/app/*", "/account/*"] }

# Also raise the scrypt cost at prod scale:
backend:
  passwordHash:
    scryptN: 32768                    # ~150ms/login on modern hardware
```

## OAuth: declare the provider — the handler IS auto-emitted

Declaring providers is all that is required:

```yaml
auth:
  oauth:
    providers: ["google"]        # google | apple | github | microsoft | facebook
```

`generate:templates` then emits `services/core-api/src/routes/oauth.ts` — the
full authorization-code flow with a CSRF state cookie, server-side token
exchange, user upsert with account linking, and session issuance — and wires
it into `routes/index.ts`. Verified: declaring `google` produces a 125-line
`oauth.ts` and two references in the route index.

**Do not hand-write `routes/oauth.ts`.** It is `[GEN]`; a hand-written copy is
overwritten or conflicts with the emitted router.

Set the provider's env vars (the emitted router reads them):

```bash
GOOGLE_CLIENT_ID=… GOOGLE_CLIENT_SECRET=… GOOGLE_REDIRECT_URI=…
```

Apple is deliberately absent from the emitters: its client secret is a signed
JWT needing key management, so declaring `apple` registers intent without a
generated handler — that one you do write by hand.
