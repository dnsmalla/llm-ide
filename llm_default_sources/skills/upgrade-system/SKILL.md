---
name: upgrade-system
description: >-
  Upgrade a host project to a newer auto-system or system-controller version.
  Trigger on: "upgrade auto-system", "bump the framework", "pull the latest",
  "migrate to v5.7 (or whatever)", "what changed since we last upgraded", or
  after a submodule pointer moves forward. Orchestrates the master.sh upgrade
  engine plus the relevant config/security skills so nothing drifts.
---

# Upgrade system

Upgrading auto-system / system-controller in a live project is three things at once: (1) running the framework's own upgrade engine, (2) reviewing the new config surfaces that appeared, (3) re-running the security and compliance gates against the new standards. This skill sequences all three so the upgrade is fast *and* correct.

## When to use

- "Upgrade auto-system" / "bump the framework" / "pull the latest"
- A submodule pointer (`.system-controller`, `submodules/.auto_system_engine`) just moved forward
- `master.sh status` reports "framework version newer than project state"
- User mentions any new layer by name ("does this have Layer 7?", "the new memory graph", "the jobs runner")
- Memory's `facts.md` shows a framework version older than the engine's current

## Do NOT use for

- A one-file fix to `routes/auth.ts`, `schema.ts`, or a single skill. That's `configure-*` territory.
- Running `generate:templates` on a mature project without reviewing the diff first (this skill always dry-runs first).

## The playbook — binding order

| # | Step | Owner | Produces |
|---|------|-------|----------|
| 1 | **Pre-flight** | `memory` | Snapshot `facts.md` + current framework version BEFORE any change |
| 2 | **Dry-run the engine** | `master.sh upgrade --dry-run` | List of files/skills/rules that would change |
| 3 | **Classify the diff** | this skill | Which surfaces changed: auth / backend / database / theme / settings / compliance / skills |
| 4a | **For each auth surface change** | → `configure-auth` | Check against current `auth.*` block, apply new required fields (e.g. `session.secretEnvVar` in L6) |
| 4b | **For each backend surface change** | → `configure-backend` | CORS / rate-limit / observability review |
| 4c | **For each DB surface change** | → `configure-database` | Entity coverage check; new extensions or columns needed |
| 4d | **For each theme/settings change** | → `configure-app-settings` | Dark-scheme gaps, new token categories |
| 4e | **For every security-level floor change** | → `/security-review` (built-in) + `configure-auth` | Password policy / MFA / session TTL vs new floor |
| 5 | **Apply the engine upgrade** | `master.sh upgrade --force` | Installs new skills/rules; emits new generated files where absent |
| 6 | **Record architectural decisions** | `memory add-decision "upgraded to X" --why "Y"` | Permanent audit trail |
| 7 | **Rebuild memory** | `memory refresh` + `memory graph build` | facts.md + graph.json now reflect post-upgrade state |
| 8 | **Run compliance** | `master.sh compliance` | Catches drift introduced by the upgrade |
| 9 | **Verify** | `master.sh status` + smoke test | Final check before commit |

## Classifying the diff (how to know which skills to invoke)

Read the dry-run output and map each changed path to the right skill:

| Changed path / surface | Affected skill(s) |
|------------------------|-------------------|
| `agents/skills/configure-auth/*`, `routes/auth.ts`, schema `auth.*` fields | `configure-auth` |
| `agents/skills/configure-backend/*`, `middleware/*`, schema `backend.*` fields | `configure-backend` |
| `agents/skills/configure-database/*`, `db/schema.ts`, schema `database.*` fields | `configure-database` |
| `theme/generator.ts`, `styles/theme.css`, `DesignSystem.swift`, `DesignTokens.kt`, `components/shared/*` | `configure-app-settings` |
| `compliance/checker.ts` (new checks) | re-run compliance, fix each new finding with its handler skill |
| `memory/*`, `graph.json` | `use-memory` |
| `docs/openapi.yaml` (schema evolved) | `model-api-contract` |
| `services/email.ts`, `jobs/`, `webhooks/` (new in L6/L8/L9) | `configure-auth` + `configure-backend` |
| New `advisor.securityLevel` floor | `/security-review` (built-in) + `configure-auth` + `configure-backend.passwordHash` |

## Pre-flight checklist (step 1 — do not skip)

```bash
# 1. Commit or stash before anything. Upgrades are destructive by design.
git status --short
git add -A && git commit -m "snapshot before auto-system upgrade"

# 2. Record current framework version (the engine writes this to
# .auto_system/.upgrade-state.json; memory stores a copy in facts.md).
./sc.sh status | grep -i "framework\|version"
cat .auto_system/.upgrade-state.json 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('frameworkVersion'))"

# 3. Confirm compliance passes BEFORE the upgrade so post-upgrade failures
# are attributable to the upgrade, not to prior drift.
./sc.sh test
bash .system-controller/submodules/.auto_system_engine/master.sh compliance
```

If step 3 fails, fix the failures with the appropriate `configure-*` skill *before* upgrading. Never upgrade on a red tree.

## Dry-run the engine (step 2)

```bash
bash .system-controller/submodules/.auto_system_engine/master.sh upgrade --dry-run
```

Read every line of the output. The engine prints three categories:

1. **New templates** — files that will be created (safe; won't overwrite)
2. **Upgradeable templates** — files the engine would rewrite IF not hand-modified. If a file is marked "user-modified", it's skipped by default (re-run with `--force` to overwrite with backup).
3. **New skills / rules** — symlinks that will appear under `.cursor/skills/` and `.cursor/rules/`

## Classify and delegate (steps 3–4)

For each section in the dry-run output, identify the skill to route to:

- **"Layer 6 — new auth tables" dry-run would add `password_reset_tokens`** → `configure-database` to check if the host already has a resets table with a different name, then decide to rename or ignore
- **"Layer 7 — .env.example regenerated"** → `configure-backend` to confirm all declared env vars are in your deploy's secret store
- **"Layer 8 — jobs runner added"** → `configure-backend` + record `memory prefer` for queue driver choice
- **"New compliance check: MFA required at security: critical"** → `configure-auth` + raise `auth.mfa.required` or downgrade security level in the same PR
- **"New skill: use-memory"** → no code change; just `memory record-skill use-memory` to acknowledge

## Apply the upgrade (step 5)

After reviewing the dry-run AND addressing every surface via the right `configure-*` skill:

```bash
# For a clean project (no user-modified generated files):
bash .system-controller/submodules/.auto_system_engine/master.sh upgrade

# For a project with user-modified generated files (advisor.md, AGENT_GUIDE, etc.):
bash .system-controller/submodules/.auto_system_engine/master.sh upgrade --force
# --force writes .bak backups of user-modified files before overwriting.
# Review each .bak after the run; merge what you want back manually.
```

## Post-upgrade: record + verify (steps 6–9)

```bash
AS_MASTER=.system-controller/submodules/.auto_system_engine/master.sh

# 6. Record the decision. Always include the "why" — future you will forget.
bash "$AS_MASTER" memory add-decision \
  "Upgraded auto-system from 5.6.0 to 5.9.0" \
  --why "Need Layer 8 jobs for email retry; audit of Layer 6 auth is clean"

# 7. Rebuild memory so facts/graph reflect post-upgrade state.
bash "$AS_MASTER" memory refresh
bash "$AS_MASTER" memory graph build

# 8. Re-run compliance. New checks typically surface here.
bash "$AS_MASTER" compliance

# 9. Smoke test the app.
./sc.sh test
# plus your project's own test suite:
npm test --prefix services/core-api
npm test --prefix apps/web
```

## Common upgrade scenarios (ready-to-paste)

### Upgrading from old `dns-system` submodule → system-controller

```bash
# Phase 1: remove the legacy submodule
git submodule deinit -f .dns_system
git rm -f .dns_system
rm -rf .git/modules/.dns_system

# Phase 2: add system-controller
git submodule add https://github.com/dnsmalla/system-controller.git .system-controller
git -C .system-controller submodule update --init --recursive
ln -sf .system-controller/sc.sh ./sc.sh

# Phase 3: bootstrap (writes .cursorrules / AGENTS.md / CLAUDE.md symlinks to MASTER.md)
bash .system-controller/bin/setup-host-repo.sh

# Phase 4: migrate config
mv .dns_system/system.yaml .auto_system/system.yaml   # if not already copied
./sc.sh status                                         # verify config loads

# Phase 5: initialize memory + regenerate docs
AS_MASTER=.system-controller/submodules/.auto_system_engine/master.sh
bash "$AS_MASTER" memory init
bash "$AS_MASTER" memory refresh
bash "$AS_MASTER" memory graph build
bash "$AS_MASTER" generate:guide

# Phase 6: compliance audit
bash "$AS_MASTER" compliance
```

### Upgrading across a Layer boundary (e.g. L5 → L8 gains jobs + webhooks)

```bash
# 1. Pre-flight
./sc.sh test && bash "$AS_MASTER" compliance   # must pass before
bash "$AS_MASTER" upgrade --dry-run

# 2. For each new layer in the dry-run output, invoke the paired skill:
#    Layer 6 → configure-auth (password policy, session secret)
#    Layer 7 → .env.example is regenerated; nothing to do manually
#    Layer 8 → configure-backend (queue driver, rate limits)
#    Layer 9 → add webhooks.endpoints[] to system.yaml as needed

# 3. Apply
bash "$AS_MASTER" upgrade

# 4. Record + verify
bash "$AS_MASTER" memory add-decision "Layers 6–9 enabled" --why "…"
bash "$AS_MASTER" memory refresh && bash "$AS_MASTER" memory graph build
bash "$AS_MASTER" compliance
```

### Upgrading `advisor.securityLevel` from `standard` to `high`

```bash
# `high` enforces: password ≥ 10 chars, ≥ 2 distinct classes, MFA enabled.
# Also requires docs/SECURITY_BASELINE.md.

# 1. Invoke configure-auth to update system.yaml:
#    auth.password.minLength: 10
#    auth.password.minDistinctClasses: 2
#    auth.mfa.enabled: true

# 2. Write docs/SECURITY_BASELINE.md (template in auto-system docs)
# 3. Run /security-review (built-in command) for a full audit
# 4. Re-run compliance — expect "Password policy (high)" + "Security Baseline" to pass

bash "$AS_MASTER" compliance
bash "$AS_MASTER" memory add-decision "Raised securityLevel to high" --why "Production launch requires; audit logs in place"
```

## Guidelines

- **Always commit before upgrading.** Upgrades are designed to be destructive-safe, but a rollback is one `git checkout` away only if you have a snapshot.
- **Always dry-run first.** The engine prints exactly what it will change; agents reading this skill should **never** skip the dry-run.
- **Route to the config skill, don't edit templates directly.** If the dry-run says `routes/auth.ts` changed, go through `configure-auth` + regenerate — never hand-edit the generated file.
- **Record the upgrade in memory.** `memory add-decision` is cheap; "why did we upgrade" questions come up six months later.
- **Compliance failures are the test.** A successful upgrade ends with `master.sh compliance` passing. Any new failure is either a gap in the upgrade (fix via the right `configure-*` skill) or legitimate drift (address + commit).
- **Don't `--force` reflexively.** It overwrites user-modified generated files with backup-to-`.bak`. Review backups before committing.

## Hand-off matrix

| If the upgrade touches … | Delegate to |
|--------------------------|-------------|
| Password policy, MFA, OAuth, sessions | `configure-auth` |
| CORS, rate limits, logging, observability, scrypt | `configure-backend` |
| Entities, migrations, extensions, engine | `configure-database` |
| Theme tokens, Settings UI | `configure-app-settings` |
| OpenAPI routes | `model-api-contract` |
| Docker/CI/k8s | `deploy-prod` |
| Perf budgets | `performance-budget` |
| Memory files, graph queries | `use-memory` |
| Pure security audit (secrets, auth, inputs) | `/security-review` (built-in) |
| New entity + API for a feature | `add-feature` |

## Output format

After running an upgrade, produce:

1. **Version delta** — `from 5.6.0 → to 5.9.0` (or path delta if cross-layer)
2. **Dry-run summary** — N new files, M rewrites, K new skills
3. **Surfaces touched** — auth / backend / database / theme / settings (explicit list)
4. **Config changes applied** — diff of `system.yaml` fields edited via configure-* skills
5. **Compliance delta** — failing-before → failing-after (should decrease)
6. **Memory writes** — `decisions.md` entry + `facts.md` refresh timestamp
7. **Rule stack** — `.cursorrules → orchestration_policy.mdc → upgrade-system/SKILL.md → (configure-* skills used) → AGENT_GUIDE.md`
