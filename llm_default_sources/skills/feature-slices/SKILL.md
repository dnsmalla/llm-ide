---
name: feature-slices
description: >-
  Install or upgrade auto-system feature slices (auth, legal, account, jobs,
  webhooks, middleware) by COPYING versioned code, not writing it. Trigger:
  add login, add legal pages, feature:upgrade.
---

# Feature slices

Auto-system ships complete, config-parameterised implementations of the
features every app needs — auth, account, legal, support, settings, jobs,
webhooks, DB bootstrap, backend middleware, app shell — as versioned
**slices** under `features/<id>/`. Installing one copies real files; it does
not ask a model to re-author them.

## Why this exists

The slice catalog is ~2.5 KB of JSON for all ten slices. The template bodies
it stands in for are ~180 KB. Reading the catalog instead of the code is a
~70× reduction, and the copied output is identical every time instead of
drifting per generation.

**So: never hand-write a feature a slice already covers.** Read the catalog,
install, then spend your tokens on what is actually specific to this app.

## When to use

- The user asks for a feature in the inventory below.
- You are bootstrapping an app and need its fixed surface.
- The user asks whether generated code is stale, or wants template fixes
  pulled in (`feature:upgrade`).

## Do NOT use for

- Domain features unique to this app — that is `add-feature`.
- Editing a slice's source in `features/` inside a host project. Slices are
  upstream; local edits belong in the host's own files.
- Bumping the engine version itself — that is `upgrade-system`.

## Requires auto-system >= 5.18.0

The `feature:*` commands landed in 5.18.0. Check before you rely on them:

```bash
./master.sh feature:list --json    # or: node core/dist/index.js --version
```

If that errors with an unknown command, the engine predates the slice
library — use `upgrade-system` first, and do NOT hand-write the feature in
the meantime without saying so.

Note `--version` was itself wrong before 5.18.0 (hardcoded `5.0.0`), so on an
older engine trust the presence of `feature:list`, not the version string.

## The catalog (read this first, always)

```bash
./master.sh feature:list --json
```

Returns `{ schema: 1, slices: [{ id, version, description, platforms,
requires }] }`. Metadata only — slice file bodies never enter context.

| Slice | Covers |
|---|---|
| `backend-middleware` | security headers + CSP, rate limit, payload guard, audit, error handler, health routes |
| `db-core` | DB bootstrap, users/sessions/reset-token repositories |
| `auth-core` | login, signup, MFA/TOTP, forgot + reset password, OAuth routing, email send |
| `account` | account hub — security, data export, deletion, payment |
| `app-shell` | layout, shared primitives, theme wiring, JWT helpers, route index |
| `legal` | privacy, terms, cookies, legal hub |
| `support` | support + help |
| `settings` | settings screen |
| `jobs` | background job runner + cleanup schedules |
| `webhooks` | signature verification + idempotency cache |

## Install

```bash
./master.sh feature:add <id>          # resolves `requires` first, in topo order
./master.sh feature:add <id> --force  # overwrite existing files (default: skip)
```

Install is **skip-if-exists** by default, so re-running is safe and never
overwrites something the project already has.

Then do the part install cannot: read `features/<id>/WIRING.md` and perform
its steps — registering routes in the existing index, adding nav entries,
setting env vars, running migrations. `WIRING.md` and the manifest are the
only slice files you should ever need to read.

## Upgrade (the part that makes this safe long-term)

```bash
./master.sh feature:status    # installed version vs available, + pending conflicts
./master.sh feature:upgrade   # all installed slices; or feature:upgrade <id>
```

Upgrade rewrites a file **only** when its bytes still hash to what
`.auto_system/features.lock` recorded at install — i.e. nobody touched it.
Anything edited locally is reported as a conflict and left exactly as it is.
Nothing is ever deleted; files a new version drops are reported and stay.

Reconciling a conflict is the one place you earn your tokens here: read the
conflicted file, read the slice's current template, apply the template's
*change* to the local file while preserving the local edit. Re-run
`feature:upgrade` afterwards — a file edited into agreement with the template
clears itself.

An unparsable lockfile makes every file a conflict by design. Do not "fix"
that by deleting the lockfile: that silently re-lets install overwrite edited
files. Repair or regenerate it deliberately.

## Verify

```bash
./master.sh feature:status     # expect the slice listed, 0 conflicts
./master.sh compliance         # generated app passes its own gate
```

## Gotchas

- `requires` is resolved for you (`account` pulls `auth-core`, which pulls
  `backend-middleware` + `db-core`). Install the slice you want, not its deps.
- Slices only write to platforms active in `system.yaml`. A web-only project
  installing `auth-core` gets no iOS or Android files — that is correct, not a
  partial install.
- Android files are authored under `com/placeholder/` and rewritten to the
  project's real package on write. Do not "fix" the placeholder path upstream.
- `theme.typography.fontFamily` / `fontFamilyDisplay` currently affect **web
  only**; iOS and Android render the system face regardless.
