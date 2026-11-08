# Dual Server Modes — Implementation Plan (2026-11-08)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a second, first-class server mode — an always-online **Remote SSH hub** — beside today's **Local desktop** mode, without regressing the local app, Host API v1, project roles, or encrypted sync.

**Architecture:** The hub is the existing Node core started in hub mode (`LLMIDE_HUB=1`) on the user's own server, reached through nginx TLS. The desktop app gains a `ServerMode` preference: in `local` it behaves exactly as today (spawn a loopback core, sync snapshots to MEGA/Box/SFTP); in `remote` it never spawns or adopts a local core, and instead talks to the hub through a **loopback-only, unguessable-path proxy in the Rust host that pins the hub's TLS key**. The web app pairs with the hub's Host API v1 over nginx WSS and keeps its existing project picker and role display. MEGA/Box/SFTP sync remains a local-mode feature; a hub is always on and needs no offline snapshot.

**Tech Stack:** Node 22 core (`node:http`, better-sqlite3, `node:test`), Tauri 2 host (Rust 1.88, `ureq` + `rustls`, system `ssh` with a stdin transport), React screens (`ui/screens`, node tests), web PWA (`web/`), nginx + Certbot, systemd.

**Spec:** This plan implements the user brief of 2026-11-08 ("Local desktop (MEGA sync for web/mobile) and Remote SSH hub (always-online core for desktop/web/iPhone)") on top of [ADR 0020](../../decisions/0020-box-encrypted-sync.md) (sync is the local/offline path), [ADR 0021](../../decisions/0021-team-hub.md) (the hub is the core in hub mode; roles and invites), and [ADR 0022](../../decisions/0022-project-scoped-team-roles.md) (project-scoped roles). Wire contract: [Host API v1](../../../schema/host-api/v1/README.md), [API 128](../../spec/api-server.md). Operations baseline: [desktop release](../../how-to/desktop-release.md), [VPS notes](../../../deploy/vps/README.md), [env vars](../../reference/env-vars.md), [project roles](../../how-to/project-roles.md). The Phase-1 agent's landed (uncommitted) working tree is the spec for the Settings mode card and `remote_ssh_test`; its Phase-2 sketch is superseded by this plan.

---

## Global constraints

- **Do not touch `ios_app/**` in this pass.** P4.6 is explicitly gated on a user decision; it is a hand-off with file anchors, not work for this coder.
- **One concern per commit**, Conventional Commits, `git add <paths>` only, never `--no-verify`, `CARGO_INCREMENTAL=0` for cargo.
- **A solo/local install never regresses.** `remote_server.mode` defaults to `local`; an absent block in an old `prefs.json` reads as `local`; the local spawn, Host API and sync paths keep their current behavior when `remote_server.mode == "local"`.
- **No secret ever reaches argv, a log, an event payload or the DOM.** The only server secret at rest is the deploy env file (0600 root:root, written once from stdin); the only client secret at rest is the OS keychain entry for the hub session, bound to the hub URL + TLS pin. The SSH private key is either the user's file (referenced by path, never read by the app) or a generated key stored only in the keychain and materialized as a 0600 temporary file for the duration of one `ssh` call.
- **No shell interpolation.** Every remote command is `Command::new("ssh").args([...])` with a fixed argv; the only variable parts are validated host/user/port/path and an enum stage name. There is no `sh -c`, no `eval`, no `sudo sh -c`, and no `rsync --rsync-path` string.
- **TLS is mandatory for a hub.** The core binds `127.0.0.1`; nginx is the only public listener; `LLMIDE_TLS_TERMINATED=1` is required for a non-loopback hub bind (already enforced at `extension/server.mjs:1577`). The desktop pins the hub leaf SPKI; a mismatch fails closed, with no system-trust fallback. A hub deploy uses `certbot --key-type ecdsa --reuse-key` so the pin survives renewal.
- **Least privilege.** One root helper (`/usr/local/sbin/llmide-deploy`), one sudoers line per stage, no wildcard, no arbitrary command. The service user `llmide` has no shell, no home login, and write access only to `/var/lib/llmide`.
- **Auth boundaries do not move.** The hub's main HTTP API is reachable only through nginx and every route keeps its `ROUTE_POLICY` class (`extension/server/route-authority.mjs`). The old unauthenticated `/api/*` alias stays absent. The desktop UI still sends no credentials to an unverified core; the proxy is treated as the verified core only after the pin check.
- **The hub is a new install, not a data migration.** v1 does not import a desktop DB into a hub. Projects are created/registered on the hub; existing chats stay local. A user switching to a hub disables sync first (P4.5).

---

## Baseline and the Phase 1 work

At plan time (`2026-11-08 19:22`, `main` at `86e1bae8`) the tree has the local core host, Host API v1, hub boot guard, member/role model, project registry and sync. The Phase-1 agent's work (the Settings server-mode card and `remote_ssh_test`) had just landed **uncommitted** in this workspace while the plan was being written; the interface block below is read from that tree. Treat it as landed: review, commit it as P1.1/P1.2, and build on its names.

### Existing anchors this plan builds on

| Concern | Anchor |
|---|---|
| Desktop prefs, defaults, patch, core env | `desktop/src-tauri/src/prefs.rs:169` (`Prefs`), `:215` (`Default`), `:230` (`PrefsPatch`), `:408` (`core_env_pairs`) |
| Core status and lifecycle | `desktop/src-tauri/src/core_host.rs:191` (`CoreStatus`), `:509` (`run_startup`), `:1188` (`runtime_for`), `:1411` (`core_status`) |
| Launch hook | `desktop/src-tauri/src/lib.rs:608` (`start_in_background`) |
| OS keychain | `desktop/src-tauri/src/secrets.rs:24` (`SERVICE`), `:120` (`load_or_create`) |
| Core diagnostic UI | `ui/screens/settings/sections/ServerSection.tsx:18`, `:182` (`BackendForm`) |
| Settings host contract | `ui/screens/settings/host.ts:8` (`CoreTrust`), `:16` (`DiagnosticsInfo`), `:200` (`SettingsHost`) |
| Shell core client / trust | `ui/screens/shell/core.ts:55` (`isLoopbackUrl`), `:243`; `ui/screens/shell/trust-gate.ts:36`; `ui/screens/shell/runtime.ts:29` |
| Shell sections | `ui/screens/shell/sections.ts:24`, `:96`; `ui/screens/shell/Shell.tsx:99`, `:150` |
| Hub boot / Host API listener | `extension/server.mjs:1014` (`/health`), `:1577` (TLS guard), `:1765` (listener); `extension/server/host-api-listener.mjs:31`, `:49` |
| Host API PIN route | `extension/routes/host-api/http-routes.mjs:60-90` |
| Hub config | `extension/core/config.mjs:265-300`, `:387` (`registrationOpen`) |
| Route authority | `extension/server/route-authority.mjs:60` (`PROJECT_WORK_ROUTES`), `:120` (`authorizeAction`) |
| Sync routes | `extension/routes/sync/http-routes.mjs`, `server.mjs:400` (`isSyncRoute`) |
| VPS baseline | `deploy/vps/README.md`, `deploy/vps/llmide-core.service`, `deploy/vps/llm-ide.com.nginx` |
| Core staging | `desktop/scripts/stage-core.mjs` (Node pinned in `node-pin.json`: 22.23.4, linux-x64 only) |

### Phase 1 interfaces (landed in the working tree on 2026-11-08 19:25; verify before editing)

The Phase-1 agent's work is now present as **uncommitted changes** in this workspace:
`desktop/src-tauri/src/remote.rs`, `desktop/src-tauri/src/prefs.rs` (`RemoteServerPrefs`), `lib.rs` / `build.rs` /
`capabilities/default.json` (`remote_ssh_test`), `ui/screens/settings/remote-model.ts`,
`ui/screens/settings/sections/RemoteServerCard.tsx`, `ui/screens/settings/host.ts`, `ui/screens/shell/host-prefs.ts`,
`ui/screens/shell/settings-adapter.ts`, `docs/how-to/configure-remote-server.md`. **Do not re-implement it; review it
and build on it.** Its Phase-2 sketch (per-user systemd/launchd + an `ssh -N -L` tunnel) is **superseded** by this
plan's hub deploy (system service behind nginx TLS); P5.5 rewrites that page.

```rust
// desktop/src-tauri/src/remote.rs — as landed
#[derive(Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SshTarget { pub host: String, #[serde(default = "default_port")] pub port: u16, pub user: String, pub key_path: String }

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SshTestResult {
    pub host: String, pub port: u16, pub user: String,
    pub host_key_type: String, pub fingerprint: String,
    pub uname: String, pub node: bool, pub node_path: Option<String>, pub node_version: Option<String>,
}
#[tauri::command] pub async fn remote_ssh_test(target: SshTarget) -> Result<SshTestResult, FsError>;
pub trait Runner { fn run(&self, args: &[String]) -> std::io::Result<RawOutput>; } // P2.3 extends this with stdin
pub fn prepare(&SshTarget) -> Result<PreparedTarget, FsError>;
pub fn ssh_args(&PreparedTarget) -> Vec<String>; // -v, BatchMode=yes, ConnectTimeout=10, accept-new, IdentitiesOnly, -p, -i, user@host, fixed REMOTE_COMMAND
```

```rust
// desktop/src-tauri/src/prefs.rs — as landed
pub enum ServerMode { #[default] Local, Remote }
pub struct RemoteServerPrefs { pub mode: ServerMode, pub host: String, pub port: u16, pub user: String, pub key_path: String, pub label: String }
// Prefs { remote_server: RemoteServerPrefs, .. } and PrefsPatch { remote_server: Option<RemoteServerPrefs>, .. }
```

```ts
// ui/screens/settings/host.ts + remote-model.ts — as landed
export type ServerMode = "local" | "remote";
export interface RemoteServerConfig { mode: ServerMode; host: string; port: number; user: string; keyPath: string; label: string }
export interface RemoteSshResult { host: string; port: number; user: string; hostKeyType: string; fingerprint: string; uname: string; node: boolean; nodePath: string | null; nodeVersion: string | null }
export interface SettingsHost { getRemoteServer?(): Promise<RemoteServerConfig>; setRemoteServer?(c: RemoteServerConfig): Promise<RemoteServerConfig>; testRemoteSsh?(c: RemoteServerConfig): Promise<RemoteSshResult>; }
```

The card is `RemoteServerCard.tsx`, rendered inside `ServerSection.tsx`; its model/test are
`ui/screens/settings/remote-model.ts` and `ui/screens/settings/tests/remote-model.test.ts`. P1.1/P1.2 below are
**acceptance checks** for that landed work; P1.3/P1.4 harden it. The landed code uses
`StrictHostKeyChecking=accept-new` and `ssh -v` to read the fingerprint; P1.3 replaces that with an app-owned
`known_hosts`, an explicit trust step and `StrictHostKeyChecking=yes` after trust. The landed prefs deliberately keep
`remote_server` out of `restart_needed`; P3.1 must remove that exception.

### Task count

29 task units across 5 phases. Two (P1.1, P1.2) are already landed in the working tree; **27 remain** (P1.3 onward). The plan is deliberately ordered so each phase ends with something the user can run.

---

## Key decisions needed before build

The plan states a recommended default for each; the coder stops at the named gate if the user has not answered.

| # | Decision | Recommended | Gate |
|---|---|---|---|
| D1 | **How the hub exposes the Host API to web/iPhone.** (a) Direct pinned listener on `:3016` (today's desktop model; browsers cannot trust a self-signed cert) or (b) the v1 listener on loopback behind nginx, advertising the nginx leaf SPKI as `h1fp` (web gets public-CA trust, iPhone pins the same leaf). | **(b)**, with `certbot --key-type ecdsa --reuse-key`. It is the only way the browser and the pinned phone share one URL. | Before P4.1 |
| D2 | **iPhone public hostname.** `PairingInfo.canonicalPrivateHost` (`ios_app/SharedProtocol/Sources/SharedProtocol/PairingInfo.swift:50`) accepts only private IPs, `*.local` and `*.ts.net`. A public hub domain needs a small Swift change; a hub on Tailscale needs none. | If the user's hub is public, **lift the iOS freeze for one task (P4.6)**; otherwise ship the Tailscale path and record "public domains not supported on iPhone v1". | Before P4.6 |
| D3 | **Pin rotation.** Leaf SPKI pin survives Certbot renewals only with `--reuse-key`; a rotated key intentionally fails closed. | **Pin the leaf SPKI + `--reuse-key`**; on mismatch show the new fingerprint and require an explicit re-trust dialog. No silent re-pin. | Before P3.2 |
| D4 | **Mode switch semantics.** Live switch (stop proxy/spawn core without restart) or restart. | **Restart in v1** (one code path, same rule as every other backend pref). "Work offline" is explicit and restarts. | Before P3.1 |
| D5 | **Desktop parity in remote mode.** Full UI against the hub vs an allowlist of remote-safe screens. | **Allowlist** (`chat`, `library`, `issues`, `gantt`, `settings`, `welcome`) and honest notices on the rest. Host-filesystem screens cannot work against a remote machine in v1. | Before P3.7 |
| D6 | **Where deploy executes.** Desktop Rust host over system `ssh`/`rsync` vs a command on the hub. | **Desktop host**. A deploy endpoint on the hub would be a remote-root surface; there must not be one. | Before P2.1 |
| D7 | **SSH key custody.** User-provided key path (Phase 1) vs app-generated key in keychain. | **Support both; default to "generate a dedicated key"** stored in the keychain. The user still installs the public line once with a copy-paste command. | Before P1.4 |
| D8 | **Hub auth for the desktop.** Hub member login (email/password + invite, refresh token in keychain) vs pairing the desktop as a Host API device. | **Member login.** The desktop is the full UI and project roles already apply to members; a device token would bypass the UI's role model. | Before P3.4 |
| D9 | **Node on the hub.** Install Node 22 on the server vs upload the already-staged Linux core (bundled Node 22 + production deps). | **Upload the staged core** (P2.4). No `npm ci`, no native build, no system Node; the release is atomic and rollback is a symlink. | Before P2.4 |
| D10 | **First owner.** Open a temporary registration window vs a one-time bootstrap token. | **One-time bootstrap token**: `open-registration` writes a 32-byte `LLMIDE_BOOTSTRAP_TOKEN` only for the window; `https://<domain>/setup?t=…` creates the first owner once, then `lock-registration` removes the token and closes registration. A public open window would let a stranger race the owner. | Before P2.6 |
| D11 | **MEGA/sync in a hub.** Keep sync available on a hub or restrict it to local mode. | **Local mode only** (P4.5). A hub is always on; snapshots add attack surface and a second source of truth. | Before P4.5 |

---

## Security model (the non-negotiables, by layer)

**SSH transport.** `BatchMode=yes`, `StrictHostKeyChecking=yes`, `UserKnownHostsFile=<data>/remote/known_hosts` (0600), `GlobalKnownHostsFile=/dev/null`, `IdentitiesOnly=yes`, `-o ClearAllForwardings=yes`, `-o PermitLocalCommand=no`, `-o ProxyCommand=none`, `-o UpdateHostKeys=no`, `-o CanonicalizeHostname=no`. The host key is confirmed out of band (the UI shows `SHA256:...` and the exact `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` command to compare on the server console). A changed key is a hard failure, never `accept-new` on the normal path. Host, user, port and key path are validated before they reach argv; a value starting with `-` is refused.

**Secrets.** `LLMIDE_JWT_SECRET` and `LLMIDE_VAULT_KEY` are generated in Rust with `getrandom`, written only to the staged env file over the SSH child's stdin, installed `0600 root:root`, and never included in `DeployPlan`, events, errors, or logs. The deploy logger receives `stage`, `status`, `duration`, `code` only. The one-time owner bootstrap token (`LLMIDE_BOOTSTRAP_TOKEN`) lives only in `/etc/llmide/bootstrap.env` (0600) during the window and in the setup URL shown once; it is removed by `lock-registration` and never logged. The hub refresh token is stored as JSON in the OS keychain under `hub-session`, bound to `{hubUrl, tlsPin}`; a pin/URL change clears it. `secrets_status` reports booleans only. `Secrets`/key structs have redacted `Debug`.

**TLS.** The core binds loopback; nginx is the only 443 listener; `LLMIDE_TLS_TERMINATED=1` documents the terminator. The desktop host checks the leaf SPKI on every connection (`rustls` custom verifier: normal chain validation **and** exact pin), refuses redirects, refuses non-`https`, and sends no credentials on a mismatch. The web app is same-origin HTTPS; a browser cannot pin, so it relies on the CA + HSTS and the exact-origin Host API allowlist. The iPhone pins the same leaf SPKI through `h1fp`.

**Authorization.** The hub's HTTP routes are the product API, not an admin proxy: every request is JWT-authenticated, `ROUTE_POLICY`-classified, and project-scoped where the handler requires it (`PROJECT_WORK_ROUTES`). `/metrics`, `/admin/*`, host-proof routes (`/kb/sync/*`, `/kb/self-heal/*`, `/host-api/*`, `/bus`, `/kb/issues/*` writes) stay out of the remote UI's reach except where a task explicitly changes them. The desktop proxy adds no credentials of its own and cannot reach any host but the pinned hub. The proxy binds `127.0.0.1`, uses a 32-byte path token, and rejects anything else with 404.

**Least privilege.** The only root path is `llmide-deploy <stage>`, root-owned 0755, with a `case` over an enum; sudoers grants the operator's login user exactly those stage commands (no `*`). The helper writes `/etc/llmide` as root, runs the core as `llmide`, and never runs user-supplied text. Uninstall keeps `/var/lib/llmide` unless the user types the hostname **and** checks "delete data"; the purge path is a separate stage.

**No `/api` exposure.** nginx never proxies `/api/*`; the core has no `/api` prefix, so it answers 404. The hub hostname routes `/auth/`, `/kb/`, `/agent/`, `/projects`, `/health`, `/admin/`, `/host-api/v1` (to the listener) and `/app/` (static PWA) only. A deploy test greps the vhost for `location /api` and fails if one appears.

---

## Rollout and migration

1. **Local users: no change.** `remote_server.mode` defaults to local; the Settings card shows the existing Server & Backend group plus a mode row. No DB migration, no API change, no CSP change.
2. **First hub.** The user runs Settings → Server & Backend → *Remote SSH hub* → Test → Deploy. The deploy is explicit and confirmed; it creates a fresh hub DB. The owner registers in the temporary window; registration closes immediately after.
3. **Desktop on the hub.** The user switches mode, the app restarts, signs in as the hub member, and picks a project. Local-only screens show "Local desktop only" with a one-line reason.
4. **Web.** The hub serves the PWA at `/app/`; pairing is the existing PIN flow, now with a `wss://<hub>/host-api/v1` URL and the hub's project picker.
5. **iPhone.** With D2 = Tailscale/private name, no app change; with D2 = public domain, P4.6 lands the one Swift change. Pair per project; the project role UI is already implemented.
6. **Switching back.** "Work offline" writes `remote_server.mode = local` and restarts; the local core starts on its own data. The hub keeps running and its sessions stay valid.
7. **API/DB.** API **129** (additive: hub PIN `url`, front `fingerprint`, `/health.hub`, `host.hello.hostKind: "hub"`); **no migration** (devices, backups and projects already exist). A client that predates 129 ignores the new fields.
8. **Rollback.** Desktop mode rollback is a pref write + restart. Hub rollback is the previous release symlink + service restart (P2.4/P5.1) and, if needed, the pre-deploy DB backup (P2.6).

---

## Testing gates

| Gate | Command | When |
|---|---|---|
| Extension unit | `cd extension && node --test --test-name-pattern "<name>" tests/<file>.test.mjs` | every core task |
| Extension suite | `cd extension && npm test` | end of each phase touching the core |
| Desktop node | `cd desktop && npm test` | every host/UI task |
| Desktop Rust | `cd desktop/src-tauri && CARGO_INCREMENTAL=0 cargo test --lib` | every Rust task |
| Contracts | `make contract-gates` + `node scripts/generate-host-api.mjs --check` | P4.2 and any wire change |
| Web | `cd web && npm test && npx tsc --noEmit -p .` | P4.4 |
| Docs | `make docs-check` | P5.5 and any env/route doc change |
| Regression | `make regression` | before each phase push |
| Real deploy | scratch VPS + `deploy/vps/check-sync.sh` style checks | P2.6, P4.3, P5.5 |

`make regression` is the push gate. `cargo test --lib` is separate (minutes cold) and runs in desktop CI; run it locally for every Rust task.

---

## Phase 1 — connection, key storage, SSH test

**Outcome:** the user can enter a server, prove the SSH login works without a password prompt, compare and pin the host key, and has a dedicated key stored in the OS keychain. No server change yet. P1.1/P1.2 are landed (uncommitted); P1.3/P1.4 complete the phase.

### Task P1.1 — Settings server mode and the remote connection block (LANDED; review + commit)

**Why.** The app needs a durable, typed choice between local and remote, and the remote connection fields must be validated once, in Rust, not in a React form. The Phase-1 agent has implemented this in the working tree; this task is the acceptance check and the commit, not a rewrite.

**Files (as landed).**
- `desktop/src-tauri/src/prefs.rs:53-96` (`ServerMode`, `RemoteServerPrefs`), `:190-193` (`Prefs.remote_server`), `:241-244` (`PrefsPatch`), `:281` (`apply_patch`), `:336` (view/parse), tests `:569-605`.
- `desktop/src-tauri/src/remote.rs` (module, validation, runner), `lib.rs:49`/`:436` (`mod remote;`, handler), `build.rs:7` (`remote_ssh_test`), `capabilities/default.json` (`allow-remote-ssh-test`).
- `ui/screens/settings/host.ts:25-55` (`ServerMode`, `RemoteServerConfig`, `RemoteSshResult`, `SettingsHost`), `ui/screens/settings/remote-model.ts`, `ui/screens/settings/sections/RemoteServerCard.tsx`, `ServerSection.tsx:11`/`:144-146`, `ui/screens/shell/host-prefs.ts:32-45`/`:108-122`, `ui/screens/shell/settings-adapter.ts:123-145`.
- Docs `docs/how-to/configure-remote-server.md` (landed; P5.5 rewrites its Phase-2 sketch).
- Tests `desktop/src-tauri/src/remote.rs` (`mod tests`), `ui/screens/settings/tests/remote-model.test.ts`.

**Interfaces.** As landed: `RemoteServerPrefs { mode, host, port, user, key_path, label }`, `Prefs.remote_server`, `PrefsPatch.remote_server`, `getRemoteServer`/`setRemoteServer`/`testRemoteSsh`. The view deliberately does **not** mark a restart needed for the remote block yet (`prefs.rs:460-462`), because Phase 1 does not act on the mode; P3.1 removes that exception.

- [ ] **Step 1: Run the landed tests (the acceptance test)**

```bash
cd desktop/src-tauri && CARGO_INCREMENTAL=0 cargo test --lib remote::tests -- --nocapture
cd desktop && node --test --experimental-strip-types ui/screens/settings/tests/remote-model.test.ts
```

Expected: the landed tests pass:
`remote_server_prefs_round_trip_normalize_and_never_require_a_restart`,
`the_remote_block_has_no_field_for_key_contents`, `rejects_option_injection_in_host_and_user_before_running_ssh`,
`argv_is_an_array_with_the_required_ssh_options_and_no_shell`, `a_missing_ssh_binary_is_reported_as_such`.

- [ ] **Step 2: Confirm the gaps this plan will close**

Run: `grep -n "accept-new\|restart_needed\|Node 20" desktop/src-tauri/src/remote.rs desktop/src-tauri/src/prefs.rs docs/how-to/configure-remote-server.md`.
Expected: `accept-new` (P1.3 replaces it), the `remote_server` restart exception (P3.1 removes it), and the "Node 20+" line (P2.4/P5.5 corrects it: the hub ships Node 22.23.4). If the landed code differs from the interface above, record the mapping in the task report and adapt the later tasks; do not rewrite working code.

- [ ] **Step 3: Make the minimal corrections (not a rewrite)**

Keep the landed names and tests. Only if a test is missing for the security shape, add it (do not duplicate an existing one). If the uncommitted work is not already committed, commit it as its own change; do not fold a later phase into it.

- [ ] **Step 4: Verify**

Run the two commands in Step 1, plus `cd desktop && npm test -- --test-name-pattern "remote"`.
Expected: PASS.

- [ ] **Step 5: Commit**

```
feat(desktop): a typed local/remote server mode with a validated SSH profile
```

### Task P1.2 — `remote_ssh_test` (LANDED): BatchMode, no prompts, fingerprint

**Why.** The user must prove the key works before any deploy writes anything. A password prompt would hang a GUI process; a wrong host key must be surfaced, not trusted.

**Files (as landed).**
- `desktop/src-tauri/src/remote.rs:192-341` (`ssh_args`, `execute`, `parse_host_key`, `remote_ssh_test`), tests `:324-470`.
- `ui/screens/settings/remote-model.ts` (`RemoteServerModel.test()`, `remoteSshErrorText`), `RemoteServerCard.tsx` (`TestResult`).

**Interfaces (as landed).** `remote_ssh_test(target: SshTarget) -> Result<SshTestResult, FsError>`; `Runner` is injectable; `REMOTE_COMMAND` is a fixed literal that prints `__LLMIDE_UNAME__`, `__LLMIDE_NODE__`, `__LLMIDE_NODE_VERSION__`. `ssh_args` currently uses `-v`, `BatchMode=yes`, `ConnectTimeout=10`, `StrictHostKeyChecking=accept-new`, `IdentitiesOnly=yes`, `-p`, `-i`, `user@host`, and the fixed command. Errors are `invalid_host`, `invalid_user`, `invalid_key_path`, `invalid_port`, `key_not_found`, `ssh_missing`, `ssh_failed`, `no_host_key`, `no_uname`.

- [ ] **Step 1: Run the landed test (the acceptance test)**

```bash
cd desktop/src-tauri && CARGO_INCREMENTAL=0 cargo test --lib remote::tests::argv_is_an_array_with_the_required_ssh_options_and_no_shell -- --exact
cd desktop/src-tauri && CARGO_INCREMENTAL=0 cargo test --lib remote::tests::rejects_option_injection_in_host_and_user_before_running_ssh -- --exact
```

Expected: PASS: the argv contains `BatchMode=yes`, `IdentitiesOnly=yes`, `-p`, `-i`; the host/user/key are validated before `ssh`; no shell string; the remote command is a fixed literal.

- [ ] **Step 2: Note the two Phase-1 limitations to close next**

1. `accept-new` writes the host key to the user's `~/.ssh/known_hosts` and parses `ssh -v` stderr; the app does not own the pin and does not require an explicit compare. **P1.3** fixes this.
2. The test reports whether `node` is on the remote PATH; the hub does **not** need it (P2.4 uploads Node 22.23.4). The card's "Node is not on the remote host's PATH" warning must not block a hub deploy; **P2.1/P5.5** correct the copy and the preflight.

- [ ] **Step 3: Make the minimal correction**

Only if the landed test suite lacks a case, add it; otherwise change nothing. Do not replace `accept-new` here: P1.3 owns that change and its tests.

- [ ] **Step 4: Verify**

Run the two commands in Step 1; then a real server: Test SSH shows the host key type, fingerprint, `uname`, and Node presence without a prompt.

- [ ] **Step 5: Commit**

```
feat(remote): test an SSH server in batch mode and show its host key
```


- [ ] **Step 5: Commit**

```
feat(remote): test an SSH server in batch mode and show its host key
```

### Task P1.3 — Confirm and pin the host key; refuse a changed key

**Why.** The Phase-1 test shows a fingerprint; trust must be an explicit user action, and a later change must stop the deploy instead of silently connecting to a different machine.

**Files.**
- Create `desktop/src-tauri/src/remote_trust.rs`.
- Modify `desktop/src-tauri/src/remote.rs` (`ssh_args` trust mode, `remote_ssh_test` returns `known`), `desktop/src-tauri/src/prefs.rs` (`RemoteServerPrefs.known_host`, view), `lib.rs` (`remote_ssh_trust`, `remote_ssh_forget`), `build.rs`, `capabilities/default.json`.
- Modify `ui/screens/settings/host.ts` (`RemoteServerConfig.knownHost`), `remote-model.ts`, `sections/RemoteServerCard.tsx`.
- Test `remote_trust.rs`; `ui/screens/settings/tests/remote-model.test.ts`.

**Interfaces.** Produces:
```rust
#[tauri::command] pub fn remote_ssh_trust(target: SshTarget, fingerprint: String) -> Result<(), String>;
#[tauri::command] pub fn remote_ssh_forget(host: String, port: u16) -> Result<(), String>;
pub(crate) fn check_known_host(path: &Path, host: &str, port: u16, presented: &str) -> Result<(), TrustError>;
```
`known_hosts` lives at `<desktop data>/remote/known_hosts` (0600); `RemoteServerPrefs.known_host` stores the `SHA256:` fingerprint only after confirmation. `SshTestResult` gains `known: bool` (additive): true when the presented key matches the app's pin, false when it is new or changed. The first test uses `StrictHostKeyChecking=accept-new` with a **temporary** `UserKnownHostsFile` under `<desktop data>/remote/tmp/`; after `remote_ssh_trust`, every call uses the app file with `StrictHostKeyChecking=yes` and `GlobalKnownHostsFile=/dev/null`.

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn a_changed_host_key_is_refused_and_never_overwritten() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("known_hosts");
    // Host key line as ssh writes it for a non-default port: [host]:port key-type base64.
    std::fs::write(&path, "[hub.example.com]:2222 ssh-ed25519 AAAAOLD\n").unwrap();
    let err = check_known_host(&path, "hub.example.com", 2222, "AAAANEW").unwrap_err();
    assert_eq!(err.code(), "HOST_KEY_CHANGED");
    assert!(std::fs::read_to_string(&path).unwrap().contains("AAAAOLD"), "the old pin must survive a refused change");
}

#[test]
fn the_trusted_argv_uses_the_app_known_hosts_and_yes() {
    let a = ssh_args_trusted(&SshTarget { host: "hub.example.com".into(), port: 2222, user: "deploy".into(), key_path: "/k".into() });
    assert!(a.windows(2).any(|w| w[0] == "-o" && w[1] == "StrictHostKeyChecking=yes"));
    assert!(a.iter().any(|x| x.starts_with("UserKnownHostsFile=") && x.contains("remote/known_hosts")));
    assert!(!a.iter().any(|x| x.contains("accept-new")));
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd desktop/src-tauri && CARGO_INCREMENTAL=0 cargo test --lib remote_trust::tests -- --exact`
Expected: FAIL (module missing; the landed `ssh_args` still uses `accept-new` and the user's known_hosts).

- [ ] **Step 3: Write the minimal implementation**

Parse `[host]:port` and `host` forms; compare the base64 key body, not the comment. On the first test, run with a temp known_hosts and `accept-new`; read the presented key from the temp file (or the `ssh -v` line the landed code already parses), return it with `known: false`. The UI shows:
```
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
```
and a checkbox "I compared this fingerprint on the server". Only then `remote_ssh_trust` appends the temp line to the app file atomically (0600) and saves `known_host` in prefs; the next Test uses `ssh_args_trusted` and returns `known: true`. If the presented key differs from the app file, return `HOST_KEY_CHANGED` and never write. `remote_ssh_forget` deletes the line and the prefs value behind a typed confirmation. Update the landed `argv_is_an_array...` test to the trusted argv (one test, not two).

- [ ] **Step 4: Run it to verify it passes**

Run the cargo tests; then: Test → show fingerprint → tick → Trust → Test again (`known: true`). Change the server key (scratch VM) → Test shows "This server's host key changed" and writes nothing.

- [ ] **Step 5: Commit**

```
feat(remote): pin the SSH host key and fail closed when it changes
```

### Task P1.4 — A dedicated SSH key in the OS keychain

**Why.** A user-provided key may be their personal key (too much authority) and a key file on disk is easy to copy. The app can generate one ed25519 key per hub, keep the private half in the keychain, and materialize it only for the duration of one `ssh` call.

**Files.**
- Create `desktop/src-tauri/src/remote_key.rs`.
- Modify `desktop/src-tauri/src/secrets.rs:24-30` (new account constant only; keep the existing two untouched), `remote.rs` (prefer the keychain key when `key_path` is empty), `lib.rs`, `build.rs`, `capabilities/default.json`.
- Modify `ui/screens/settings/host.ts` (`RemoteKeyInfo`), `remote-model.ts`, `sections/RemoteServerCard.tsx` (Generate key, public line, copy).
- Test `remote_key.rs`; `ui/screens/settings/tests/remote-model.test.ts`.

**Interfaces.** Produces:
```rust
pub const ACCOUNT_SSH_KEY: &str = "remote-ssh-key";
#[tauri::command] pub fn remote_key_generate() -> Result<RemoteKeyInfo, String>; // stores in keychain
#[tauri::command] pub fn remote_key_status() -> Result<RemoteKeyInfo, String>; // never returns the private key
#[tauri::command] pub fn remote_key_public() -> Result<String, String>;         // "ssh-ed25519 AAAA... llmide-hub"
pub struct RemoteKeyInfo { pub public_key: String, pub fingerprint: String, pub source: &'static str }
```
`prepare()` accepts an empty `key_path` only when the keychain holds a generated key; `ssh_args_trusted` gets the key from `RemoteKeyProvider`: a `NamedTempFile` (0600) written from the keychain and dropped after `Command::output()`; `-i <temp>` only. If `remote_server.key_path` is non-empty, it is used as before (the user's choice, never copied). The landed `valid_key_path`/`prepare` must be updated for the empty case with a test.

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn generated_key_lives_only_in_the_store_and_materializes_0600() {
    let b = crate::secrets::MemoryBackend::default();
    let info = generate_into(&b).unwrap();
    assert!(info.public_key.starts_with("ssh-ed25519 "));
    assert!(b.get(ACCOUNT_SSH_KEY).unwrap().is_some());
    let tmp = materialize(&b).unwrap();
    let mode = std::fs::metadata(tmp.path()).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o600);
    let shown = format!("{:?}", info);
    assert!(!shown.contains("PRIVATE KEY"));
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd desktop/src-tauri && CARGO_INCREMENTAL=0 cargo test --lib remote_key::tests::generated_key_lives_only_in_the_store_and_materializes_0600 -- --exact`
Expected: FAIL (module missing).

- [ ] **Step 3: Write the minimal implementation**

Call `ssh-keygen -q -t ed25519 -N "" -C "llmide-hub" -f <temp>` (present on macOS/Linux; on Windows, `ssh-keygen.exe` from the optional OpenSSH client; if absent, return `SSH_KEYGEN_MISSING` with a clear message and let the user pick a key path). Read the private file, store it in the keychain under `remote-ssh-key`, delete the temp. The public line is shown in the UI with a copy button and the exact `authorized_keys` command. The key is per install, not per host; P1.3's known_hosts still pins each host. Do not add the key to the user's `~/.ssh`.

- [ ] **Step 4: Run it to verify it passes**

Run the cargo test; then Generate → copy the public line → append it to the server's `~/.ssh/authorized_keys` (the UI prints the command) → Test. Expected: PASS with no key path entered.

- [ ] **Step 5: Commit**

```
feat(remote): generate a dedicated SSH key and keep it in the OS keychain
```

**Phase 1 exit:** mode + profile saved; Test proves key auth; host key shown, confirmed and pinned; a changed key fails closed; the generated key never persists on disk (only a 0600 temp file for the duration of one ssh call); `cargo test --lib` green; `desktop && npm test` green.

---

## Phase 2 — deploy to the user's server

**Outcome:** from Settings, with two explicit confirmations, the app installs a running hub on a fresh Ubuntu 24.04 x86_64 server: service user, `/opt/llmide` release, `/var/lib/llmide` data, systemd unit, 0600 env file, nginx TLS vhost, health check, owner registration window, and a rollback path. No secret in argv/logs; no arbitrary root command.

**Shape:** one fixed root helper `/usr/local/sbin/llmide-deploy` with an enum of stages. The app uploads files to a staging directory the login user owns, then calls `sudo -n /usr/local/sbin/llmide-deploy <stage>` (one sudoers line per stage). The helper reads fixed paths and never interpolates arguments. The bundle is the **already-staged Linux core** (`desktop/scripts/stage-core.mjs --target linux-x64`, bundled Node 22.23.4), so the server needs no Node, npm or compiler.

### Task P2.1 — Read-only SSH preflight and a deploy plan

**Why.** A deploy must refuse before it writes when the server is the wrong OS/arch, has no systemd/nginx/certbot, lacks passwordless sudo, has too little disk, or the domain does not point at it.

**Files.**
- Create `desktop/src-tauri/src/remote_deploy.rs`.
- Modify `desktop/src-tauri/src/remote.rs` (reuse `ssh_args_trusted`; add `DeployRunner`), `lib.rs`, `build.rs`, `capabilities/default.json`.
- Create `deploy/hub/preflight.sh` (fixed POSIX script, no interpolation, sent over stdin).
- Create `ui/screens/settings/remote-deploy-model.ts`, `ui/screens/settings/sections/RemoteDeployCard.tsx`.
- Test `remote_deploy.rs` + `ui/screens/settings/tests/remote-deploy.test.mjs`.

**Interfaces.**
```rust
pub trait DeployRunner: Send + Sync {
    fn run(&self, target: &SshTarget, argv: &[String], stdin: Option<&[u8]>) -> Result<RawOutput, String>;
}
pub struct DeployPreflight {
    pub os: String, pub arch: String, pub systemd: bool, pub nginx: bool, pub certbot: bool,
    pub sudo_nopasswd: bool, pub disk_free_mb: u64, pub existing_version: Option<String>,
    pub dns_matches: Option<bool>, pub claude: bool, pub blockers: Vec<String>, pub warnings: Vec<String>,
}
#[tauri::command] pub async fn remote_deploy_plan(target: SshTarget, domain: String, app: tauri::AppHandle) -> Result<DeployPlan, String>;
```
`DeployRunner` wraps `ssh_args_with(target, command)` (the P1.3 refactor of the landed `ssh_args`; `command` is always a constant from `stage_command` or a fixed probe string) and adds stdin. No deploy path interpolates user text into the remote command. The preflight script prints `LLMIDE_PREFLIGHT <json>` on one line; the Rust side parses only that line. It runs no `sudo` except `sudo -n true` (a read-only privilege probe).

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn preflight_refuses_arm_password_sudo_and_missing_nginx() {
    let out = br#"LLMIDE_PREFLIGHT {"os":"Ubuntu 24.04","arch":"aarch64","systemd":true,"nginx":false,"certbot":true,"sudo_nopasswd":false,"disk_free_mb":900,"claude":false,"existing_version":null}"#;
    let p = parse_preflight(out).unwrap();
    let blockers = plan_blockers(&p, "hub.example.com");
    assert!(blockers.iter().any(|b| b == "arch_unsupported"));
    assert!(blockers.iter().any(|b| b == "sudo_requires_password"));
    assert!(blockers.iter().any(|b| b == "disk_below_2gb"));
    assert!(blockers.iter().any(|b| b == "nginx_missing"));
    assert!(!blockers.iter().any(|b| b == "node22_missing"), "the bundle brings Node 22; the server needs only a runnable ELF");
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd desktop/src-tauri && CARGO_INCREMENTAL=0 cargo test --lib remote_deploy::tests::preflight_refuses_arm_password_sudo_and_missing_nginx -- --exact`
Expected: FAIL (module missing).

- [ ] **Step 3: Write the minimal implementation**

`DeployPlan` fields: `id` (16 random bytes hex), `version`, `domain`, `arch`, `stages` (`id`, `title`, `mutating`, `detail`), `blockers`, `warnings`, `confirmation` (the exact domain string the user must type), `created_at`. The stage list is fixed: `predeploy-backup`, `base`, `env`, `bundle`, `nginx`, `start`, `open-registration`, `lock-registration`. Preflight checks: OS is Ubuntu/Debian (warn otherwise), arch is `x86_64` (blocker for `aarch64` until a linux-arm64 pin exists; document the one-line follow-up), `systemctl`, `nginx -v`, `certbot --version`, `sudo -n true`, free disk ≥ 2048 MB, existing `/opt/llmide/current/VERSION`, `getent hosts <domain>` vs the server's public IPv4 (warning only), `command -v claude` (warning only: per-user vault keys also work). It does **not** require Node on the server: the bundle carries Node 22.23.4, and P2.4 verifies that binary after upload. The UI renders the plan as a checklist with the warnings and the typed-domain confirmation; the Deploy button is disabled until the plan has no blockers.

- [ ] **Step 4: Run it to verify it passes**

Run the cargo test; on a scratch VM, run Plan. Expected: PASS; a server without nginx lists `nginx_missing` and no mutating stage runs.

- [ ] **Step 5: Commit**

```
feat(remote): a read-only deploy preflight that refuses the wrong server
```

### Task P2.2 — One privileged helper and a one-time bootstrap

**Why.** The deploy needs root for the service user, unit, env file and nginx. A generic `sudo` from a GUI is unacceptable; one fixed helper with an enum of stages is auditable and testable.

**Files.**
- Create `deploy/hub/llmide-deploy` (POSIX `sh`, installed as `/usr/local/sbin/llmide-deploy`).
- Create `deploy/hub/sudoers.template` (`<user> ALL=(root) NOPASSWD: /usr/local/sbin/llmide-deploy base, ...` one line per stage).
- Modify `remote_deploy.rs` (`remote_deploy_bootstrap`, `stage_command`, `DeployRunner` stdin), `ServerSection`/`RemoteDeployCard`.
- Test `remote_deploy.rs` + a shell test `deploy/hub/llmide-deploy.test.sh` (run by `node --test`? use a Rust test that executes `sh -n` and inspects the file; keep it dependency-free).

**Interfaces.**
```rust
#[tauri::command] pub async fn remote_deploy_bootstrap(target: SshTarget) -> Result<Bootstrap, String>;
pub struct Bootstrap { pub installed: bool, pub command: String } // `command` is shown when sudo needs a password
pub const STAGES: &[&str] = &["check", "predeploy-backup", "base", "env", "bundle", "nginx", "start", "open-registration", "lock-registration", "backup", "rollback"];
// P5.1 appends "update"; P5.4 appends "revoke-key", "uninstall", "uninstall-purge". The sudoers file is generated from this list.
```

Bootstrap sequence, attempted automatically and, on failure, printed for the user to run in a terminal:
1. upload the helper to `~/.llmide-deploy/llmide-deploy` (login user, 0700);
2. `sudo -n install -m 0755 -o root -g root ~/.llmide-deploy/llmide-deploy /usr/local/sbin/llmide-deploy`;
3. `sudo -n install -m 0440 -o root -g root ~/.llmide-deploy/sudoers /etc/sudoers.d/llmide-deploy`;
4. `sudo -n /usr/local/sbin/llmide-deploy check` — a read-only stage that prints `ok`. It never runs a mutating stage as a probe.

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn sudoers_grants_exact_stages_and_never_a_wildcard() {
    let s = sudoers_text("deploy");
    assert!(s.contains("deploy ALL=(root) NOPASSWD: /usr/local/sbin/llmide-deploy base"));
    for stage in STAGES { assert!(s.contains(&format!("/usr/local/sbin/llmide-deploy {stage}")), "missing {stage}"); }
    assert!(!s.contains('*'), "no wildcard command");
    assert!(!s.contains("ALL=(ALL)"));
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd desktop/src-tauri && CARGO_INCREMENTAL=0 cargo test --lib remote_deploy::tests::sudoers_grants_exact_stages_and_never_a_wildcard -- --exact`
Expected: FAIL.

- [ ] **Step 3: Write the minimal implementation**

The Rust side has `stage_command(stage) -> &'static str`: it returns exactly `sudo -n /usr/local/sbin/llmide-deploy <stage>` for a stage in the enum and panics/refuses otherwise. The helper starts with `set -eu`, `umask 077`, refuses unless `id -u` is 0, reads `/etc/llmide/deploy.conf` (root 0600) for `DOMAIN`, `VERSION`, `ARCH`, `PORT`, and dispatches with `case "$1" in ...`. It has no `eval`, no `$@` expansion, no `sh -c`, and no user text. Every stage is idempotent and logs `llmide-deploy: <stage>: <ok|fail>` to stderr (stage names only). The Rust bootstrap writes the files over `ssh` stdin/stdout, then verifies `sudo -n /usr/local/sbin/llmide-deploy check` prints `ok`. If any `sudo -n` step fails, return the exact copy-paste command and a message: "Your server asks for a sudo password. Run this once in a terminal, then press Deploy again." The UI never asks for a sudo password.

- [ ] **Step 4: Run it to verify it passes**

Run the cargo test; `sh -n deploy/hub/llmide-deploy`; on a scratch VM run the printed bootstrap and then `sudo -n /usr/local/sbin/llmide-deploy check`. Expected: `ok`; `sudo -n /usr/local/sbin/llmide-deploy nope` exits 2; `sudo -n cat /etc/shadow` is refused.

- [ ] **Step 5: Commit**

```
feat(remote): one fixed root helper with an enum of deploy stages
```

### Task P2.3 — Service user, directories, systemd unit and the secret env file

**Why.** The hub must run as an unprivileged, no-shell user with one writable directory, be restarted by systemd, and receive its JWT/vault secrets without them appearing in `ps`, a log or a shell history.

**Files.**
- Create `deploy/hub/llmide-core.service`, `deploy/hub/core.env.template`, `deploy/hub/logrotate`.
- Modify `deploy/hub/llmide-deploy` (`base`, `env` stages).
- Modify `extension/core/config.mjs` (`projectsRoot` from `LLMIDE_PROJECTS_ROOT`), `extension/kb/projects.mjs` (`hubProjectRoot` guard), `extension/routes/docs-routes.mjs` (a hub `POST /kb/projects/register { id, name }` derives the root, `mkdir` 0700 under it, refuses an outside root `PROJECT_ROOT_NOT_ALLOWED`).
- Modify `remote_deploy.rs` (`remote_deploy_run` secret stdin, redacted events), `remote-deploy-model.ts`.
- Test `remote_deploy.rs` (`env_file_is_0600_and_never_in_argv`), `extension/tests/projects-hub-root.test.mjs`.

**Interfaces.** Stage `base` creates `llmide` (`useradd --system --home /var/lib/llmide --shell /usr/sbin/nologin llmide`), `/opt/llmide/{releases,current}`, `/var/lib/llmide` (0700 llmide:llmide), `/var/lib/llmide-deploy` (0700 root:root, staging only), `/srv/llmide/projects` (0700 llmide:llmide), `/etc/llmide` (0700 root:root), installs the unit and logrotate, `systemctl daemon-reload`. Stage `env` reads stdin, writes `/etc/llmide/core.env` (0600 root:root) and `/etc/llmide/deploy.conf` (0600 root:root), then `systemctl restart llmide-core` only if the unit is running.

Unit (exact):
```ini
[Unit]
Description=LLM-IDE hub
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=llmide
Group=llmide
WorkingDirectory=/opt/llmide/current/core/root/extension
EnvironmentFile=/etc/llmide/core.env
EnvironmentFile=-/etc/llmide/bootstrap.env
ExecStart=/opt/llmide/current/core/node/node /opt/llmide/current/core/root/extension/server.mjs
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/llmide /srv/llmide/projects
LimitNOFILE=65536
```

Env file (exact keys; values generated per install):
```
NODE_ENV=production
PATH=/usr/local/bin:/usr/bin:/bin
LLMIDE_HOST=127.0.0.1
LLMIDE_PORT=3457
LLMIDE_HUB=1
LLMIDE_TLS_TERMINATED=1
LLMIDE_DATA_DIR=/var/lib/llmide
LLMIDE_DB_PATH=/var/lib/llmide/data.db
LLMIDE_PROJECTS_ROOT=/srv/llmide/projects
LLMIDE_BACKUP_DIR=/var/lib/llmide/backups
LLMIDE_BACKUP_KEEP=7
LLMIDE_DISABLE_REGISTRATION=1
LLMIDE_TRUST_PROXY=1
LLMIDE_LOG_JSON=1
LLMIDE_LOG_LEVEL=info
LLMIDE_MAX_TURNS=8
LLMIDE_HOST_API_HUB=1
LLMIDE_HOST_API_WEB_ORIGINS=https://<domain>
LLMIDE_HOST_API_FINGERPRINT_FILE=/etc/llmide/host-api-fingerprint
LLMIDE_JWT_SECRET=<64 hex>
LLMIDE_VAULT_KEY=<64 hex>
```
`LLMIDE_BOOTSTRAP_TOKEN` is **not** in `core.env`: it lives only in the optional `/etc/llmide/bootstrap.env` (0600 root:root), written by `open-registration` and removed by `lock-registration`, so the one-time owner token exists only during the window (P2.6).

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn env_file_is_0600_and_never_in_argv() {
    let fake = FakeSsh::default();
    let secrets = Treasures { jwt: "a".repeat(64), vault: "b".repeat(64) };
    run_stage(&fake, "env", Some(&env_bytes(&secrets, "hub.example.com"))).unwrap();
    let call = fake.last().unwrap();
    assert!(!call.argv.join(" ").contains(&secrets.jwt), "JWT must not be in argv");
    assert!(!call.argv.join(" ").contains(&secrets.vault), "vault key must not be in argv");
    assert!(String::from_utf8_lossy(call.stdin.as_ref().unwrap()).contains("LLMIDE_VAULT_KEY="));
}
```

```js
test("a hub project is created only under the projects root", () => {
  assert.match(hubProjectRoot(null, "Alpha", "/srv/llmide/projects"), /^\/srv\/llmide\/projects\/alpha-[0-9a-f]{4}$/);
  for (const bad of ["/etc", "/srv/llmide/projects/../etc", "/srv/llmide/projects-evil/x"]) {
    assert.throws(() => hubProjectRoot(bad, "x", "/srv/llmide/projects"), /PROJECT_ROOT_NOT_ALLOWED/);
  }
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd desktop/src-tauri && CARGO_INCREMENTAL=0 cargo test --lib remote_deploy::tests::env_file_is_0600_and_never_in_argv -- --exact` and `cd extension && node --test --test-name-pattern "a hub project is created only under" tests/projects-hub-root.test.mjs`
Expected: FAIL (no stdin path; no guard).

- [ ] **Step 3: Write the minimal implementation**

Add `LLMIDE_PROJECTS_ROOT` to `extension/core/config.mjs` (`projectsRoot`; unset = no confinement for a local install) and enforce it in `hubProjectRoot`/the register route: on a hub a root outside `projectsRoot` is `403 PROJECT_ROOT_NOT_ALLOWED`; a request with `{ name }` and no root derives `<projectsRoot>/<slug>-<4 hex>` and `mkdir`s 0700 `llmide`. This closes the "register `/etc` as a project" hole on a shared hub. Generate both secrets with `getrandom` (32 bytes hex). Build the env bytes in Rust, send them as `stdin` to `sudo -n /usr/local/sbin/llmide-deploy env`; the helper writes a `mktemp` in `/etc/llmide`, `cat > "$tmp"`, `chmod 0600`, `chown root:root`, `mv` into place. The Rust event stream for this stage carries `{stage:"env", status:"ok"}` only. Add a unit golden test for the directives above and a logrotate file (`/var/lib/llmide/*.log` weekly, 4, `notifempty`, `compress`).

- [ ] **Step 4: Run it to verify it passes**

Run the cargo test and the Node guard test; on the scratch VM: `sudo stat -c '%a %U:%G' /etc/llmide/core.env` → `600 root:root`; `sudo systemctl cat llmide-core` shows the unit; `ps eww -C node` (or `journalctl`) does not show the secrets.

- [ ] **Step 5: Commit**

```
feat(remote): a no-shell service user, a locked-down unit and a stdin-only env file
```

### Task P2.4 — Upload the staged Linux core, switch releases atomically, roll back

**Why.** Building Node or native modules on the user's server is slow, needs a toolchain and network, and makes the result non-reproducible. The desktop already stages a pinned Node + production deps; upload that for `linux-x64`, verify it, and switch a symlink.

**Files.**
- Modify `desktop/scripts/stage-core.mjs` (`--out <dir>`; default unchanged) and add `desktop/scripts/stage-hub-core.mjs` (stage `linux-x64`, add `extension/scripts/backup.mjs` + `restore-backup.mjs`, write `VERSION` and `SHA256SUMS`, tar.gz).
- Modify `deploy/hub/llmide-deploy` (`bundle` stage: verify tar sha256, unpack to `releases/<version>`, `chown -R root:root`, symlink `current` → `releases/<version>`, keep 3).
- Modify `remote_deploy.rs` (`remote_deploy_upload`, `remote_deploy_run` bundle/rollback), `remote-deploy-model.ts`.
- Test `desktop/scripts/stage-hub-core.test.mjs` (arg parser + manifest) and `remote_deploy.rs` (`release_switch_and_rollback`).

**Interfaces.**
```rust
#[tauri::command] pub async fn remote_deploy_upload(plan_id: String, app: tauri::AppHandle) -> Result<UploadSummary, String>;
pub struct UploadSummary { pub version: String, pub bytes: u64, pub sha256: String }
```
Release layout:
```
/opt/llmide/releases/<version>/core/{node/node,root/extension,root/schema,root/graph-kit}
/opt/llmide/current -> releases/<version>
/opt/llmide/previous -> releases/<old>   (a second symlink, updated on switch)
```

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn release_switch_keeps_the_previous_and_rolls_back() {
    let mut fs = FakeRemoteFs::new();
    fs.install("1.2.3");
    fs.install("1.2.4");
    switch_release(&mut fs, "1.2.4").unwrap();
    assert_eq!(fs.current(), "1.2.4");
    assert_eq!(fs.previous(), "1.2.3");
    rollback_release(&mut fs).unwrap();
    assert_eq!(fs.current(), "1.2.3");
}

#[test]
fn the_bundled_node_must_be_22() {
    assert!(bundled_node_ok("v22.23.4"));
    assert!(!bundled_node_ok("v20.19.0"));
    assert!(!bundled_node_ok("v24.0.0"));
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd desktop/src-tauri && CARGO_INCREMENTAL=0 cargo test --lib remote_deploy::tests -- --exact`
Expected: FAIL (`release_switch...` and `the_bundled_node_must_be_22`).

- [ ] **Step 3: Write the minimal implementation**

`stage-hub-core.mjs` runs `node desktop/scripts/stage-core.mjs --target linux-x64 --out <temp>`, copies the two backup scripts into `root/extension/scripts/`, writes `VERSION` (desktop app version), computes `SHA256SUMS`, and creates `dist/hub/llmide-core-<version>-linux-x64.tar.gz`. The helper's `bundle` stage runs `./core/node/node --version` after unpacking and refuses anything but `v22.` (the Node 22 check; the server needs no system Node). If `web/dist` exists, `stage-hub-core.mjs` stages it under `root/web`; the helper installs it to `/var/www/llmide-web` (0755 root) so nginx can serve the PWA at `/app/`. A missing web build is a warning, not a blocker: the hub still serves desktop and iPhone; P4.4 adds the web upload/verification. Upload by streaming the tarball over `ssh` stdin (not `scp`/`rsync`, so there is no `-e` string to build and no remote path interpolation): `remote_deploy_upload` opens the file, pipes it to `ssh ... 'cat > /var/lib/llmide-deploy/bundle.tar.gz'` (a fixed path; a deploy lock held in Rust prevents two plans at once), then the helper verifies the sha256 from a file staged beside it. The helper unpacks with `tar -xzf` into `releases/<version>.tmp`, `mv` to `releases/<version>`, updates `current`/`previous`, and prunes releases older than 3. `remote_deploy_run("rollback")` swaps `current` to `previous` and restarts.

- [ ] **Step 4: Run it to verify it passes**

Run the cargo test; `node desktop/scripts/stage-hub-core.mjs` in a scratch dir; verify the tarball has `core/node/node` (ELF x86-64), `VERSION`, `SHA256SUMS`; on the VM upload and switch, then roll back.

- [ ] **Step 5: Commit**

```
feat(remote): ship the staged Linux core and switch releases with a symlink
```

### Task P2.5 — nginx, TLS, and the certificate pin file

**Why.** The hub is public; the core binds loopback. nginx is the only TLS listener, must proxy the API and the Host API WebSocket, and must publish the front's SPKI so the phone can pin it.

**Files.**
- Create `deploy/hub/llm-ide-hub.nginx.template`.
- Modify `deploy/hub/llmide-deploy` (`nginx` stage: render template with `DOMAIN`, `nginx -t`, backup the old site, reload; on failure restore; certbot `--key-type ecdsa --reuse-key`; write `/etc/llmide/host-api-fingerprint` 0644; install `setup.html` into `/var/www/llmide-web`).
- Modify `remote_deploy.rs` (`pin_from_cert` parse), `RemoteDeployCard`.
- Test `remote_deploy.rs` (`vhost_has_no_api_alias_and_pins_the_front`) + a golden file test.

**Interfaces.** Vhost (excerpt; full file is the deliverable). A port-80 server serves `/.well-known/acme-challenge/` from `/var/www/llmide-web` and redirects everything else to 443:
```nginx
server { listen 80; server_name __DOMAIN__; root /var/www/llmide-web;
  location /.well-known/acme-challenge/ { try_files $uri =404; }
  location / { return 301 https://$host$request_uri; } }
server {
  listen 443 ssl http2;
  server_name __DOMAIN__;
  ssl_certificate     /etc/letsencrypt/live/__DOMAIN__/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/__DOMAIN__/privkey.pem;
  ssl_protocols TLSv1.2 TLSv1.3;
  add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
  client_max_body_size 8m;

  location = /host-api/v1 {
    proxy_pass http://127.0.0.1:3016;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_read_timeout 3600s;
    access_log off;
  }
  location /agent/v2/ {
    proxy_pass http://127.0.0.1:3457;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto https;
    proxy_buffering off;
    proxy_read_timeout 3600s;
  }
  location = /setup { root /var/www/llmide-web; try_files /setup.html =404; add_header Cache-Control "no-store" always; }
  location /app/ { alias /var/www/llmide-web/; try_files $uri $uri/ /app/index.html; }
  location = /metrics { return 404; }
  location / { proxy_pass http://127.0.0.1:3457; proxy_set_header Host $host; proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; proxy_set_header X-Forwarded-Proto https; }
}
```

Pin extraction (helper, root): `openssl x509 -in .../cert.pem -pubkey -noout | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | basenc --base64url | tr -d '='` → `sha256:...`; write `/etc/llmide/host-api-fingerprint` 0644. The Rust side reads that file over SSH and validates `^sha256:[A-Za-z0-9_-]{43}$` before storing `remote_tls_pin`.

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn vhost_has_no_api_alias_and_proxies_the_host_api() {
    let v = render_vhost("hub.example.com");
    assert!(!v.contains("location /api"), "the retired /api alias must not come back");
    assert!(v.contains("location = /host-api/v1"));
    assert!(v.contains("proxy_set_header Upgrade $http_upgrade"));
    assert!(v.contains("proxy_buffering off"));
    assert!(v.contains("location = /metrics { return 404; }"));
    assert!(!v.contains("Access-Control-Allow-Origin \"*\""));
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd desktop/src-tauri && CARGO_INCREMENTAL=0 cargo test --lib remote_deploy::tests::vhost_has_no_api_alias_and_proxies_the_host_api -- --exact`
Expected: FAIL (template/render missing).

- [ ] **Step 3: Write the minimal implementation**

Render the template by replacing only `__DOMAIN__` (validated before it reaches the file). The helper creates `/var/www/llmide-web` (0755 root:root), copies any existing `/etc/nginx/sites-enabled/llm-ide-hub` to `.bak.<ts>`, writes the new file, runs `nginx -t`; on failure restores the backup and exits non-zero. Then `certbot certonly --webroot -w /var/www/llmide-web -d "$DOMAIN" --key-type ecdsa --reuse-key --non-interactive --agree-tos -m "$EMAIL"` (email is a deploy field, validated; if absent use `--register-unsafely-without-email` only after an explicit checkbox). Reload nginx; verify `curl -sS https://$DOMAIN/health` via the pinned Rust client. The pin file is written only after the certificate exists.

- [ ] **Step 4: Run it to verify it passes**

Run the cargo test; on the scratch VM `nginx -t`; `curl -I https://hub.example.com` shows HSTS and a valid cert; `/api/health` → 404; the fingerprint file matches `openssl` output.

- [ ] **Step 5: Commit**

```
feat(remote): nginx TLS for the hub, with the front certificate pin published
```

### Task P2.6 — Confirmed deploy run, health gate, owner window, automatic rollback

**Why.** The stages above are individually safe but a deploy is still a one-way change for a non-expert user. It must be explicitly confirmed, checked live, and undone automatically if the hub does not answer.

**Files.**
- Modify `remote_deploy.rs` (`remote_deploy_run` state machine, `remote_deploy_rollback`, health client), `remote-deploy-model.ts`, `RemoteDeployCard.tsx`, `ServerSection.tsx`.
- Create `deploy/hub/setup.html` (a dependency-free owner-registration page; the one-time token is read from the URL and stripped with `history.replaceState`) and serve it at `https://<domain>/setup` through nginx.
- Modify `deploy/hub/llmide-deploy` (`start`, `open-registration`, `lock-registration`, `predeploy-backup`, `rollback`).
- Modify `extension/server.mjs` (`collectHealth` adds `hub: config.hub`, additive, so the deploy gate can prove it reached a hub), `extension/tests/health-hub.test.mjs`;
- Modify `extension/core/config.mjs` (`bootstrapToken` from `LLMIDE_BOOTSTRAP_TOKEN`), `extension/server/users.mjs`/`auth-routes.mjs` (`registerUser` accepts a one-time `bootstrap` only while no real user exists), `extension/tests/bootstrap-registration.test.mjs`.
- Test `remote_deploy.rs` (`health_failure_rolls_back`, `confirmation_is_the_domain`, `registration_is_closed_after_lock`), `extension/tests/bootstrap-registration.test.mjs`.

**Interfaces.**
```rust
#[tauri::command] pub async fn remote_deploy_run(plan_id: String, confirmation: String, app: tauri::AppHandle) -> Result<DeployReport, String>;
#[tauri::command] pub async fn remote_deploy_rollback(plan_id: String) -> Result<(), String>;
pub struct DeployReport { pub version: String, pub url: String, pub api_version: u32, pub hub: bool, pub owner_window_open: bool, pub setup_url: Option<String>, pub rolled_back: bool, pub failed_stage: Option<String> }
```
Order: `predeploy-backup` (if existing), `base`, `env`, `bundle`, `nginx`, `start`, health, `open-registration`; the user creates the owner; the UI's "I created the owner account" calls `lock-registration`; verify `/auth/well-known` says `registrationOpen: false`. On success the app adds `hub_url: "https://<domain>"` to `RemoteServerPrefs` (additive, `#[serde(default)]`); the TLS pin is still P3.2, so the mode stays `local` until the user probes and pins.

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn a_hub_that_never_becomes_healthy_is_rolled_back() {
    let fake = FakeDeploy::new().health(vec![Err("timeout"), Err("timeout")]);
    let r = deploy_run(&fake, "plan", "hub.example.com", Duration::from_millis(50)).unwrap_err();
    assert_eq!(r.code, "HEALTH_TIMEOUT");
    assert!(fake.stages().contains(&"rollback".to_string()));
    assert!(fake.stages().iter().position(|s| s == "rollback") > fake.stages().iter().position(|s| s == "start"));
}
```

```js
test("bootstrap creates only the first owner", () => {
  const db = testDb();
  assert.ok(registerFirstOwner(db, "Owner@Example.com", "pw", "bootstrap-1"));
  assert.throws(() => registerFirstOwner(db, "second@example.com", "pw", "bootstrap-1"), /BOOTSTRAP_USED/);
  const m = getMember(db, firstUserId(db));
  assert.equal(m.team_role, "owner");
  assert.equal(m.max_mode, "execute");
  assert.throws(() => registerFirstOwner(testDb(), "a@b.c", "pw", "wrong"), /BOOTSTRAP_INVALID/);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd desktop/src-tauri && CARGO_INCREMENTAL=0 cargo test --lib remote_deploy::tests::a_hub_that_never_becomes_healthy_is_rolled_back -- --exact`
Run: `cd extension && node --test --test-name-pattern "bootstrap creates only the first owner" tests/bootstrap-registration.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Write the minimal implementation**

`plan_id` is held in a `Mutex<HashMap<String, DeployPlan>>` for 30 minutes; `confirmation` must equal `plan.confirmation` exactly; a consumed plan cannot be reused. After `start`, poll `https://<domain>/health` with the pinned TLS client every 2 s for 45 s; require `dbOk == true`, `hub == true` (the additive `/health.hub` field from this task), `apiVersion >= 128` (P4.2 raises the floor to 129 once the hub pairing fields exist; P4.3 re-runs the gate with 129). On any stage failure or timeout: run `rollback` (stop service, restore `previous` symlink, restore the nginx `.bak`), then return `rolled_back: true` and the failing stage with the redacted last 20 journal lines. `predeploy-backup`: if `/var/lib/llmide/data.db` exists, stop, run the bundled backup script (better-sqlite3 `VACUUM INTO /var/lib/llmide/backups/predeploy-<ts>.db`), start again; if the backup fails, abort before any write. Owner window: `open-registration` generates a 32-byte token, writes `/etc/llmide/bootstrap.env` (0600 root:root; `LLMIDE_BOOTSTRAP_TOKEN=<hex>`), rewrites `LLMIDE_DISABLE_REGISTRATION=0`, restarts, and prints `LLMIDE_SETUP_URL=https://<domain>/setup?t=<token>`. The Rust side parses that one line, shows it once in the card's **Open owner setup** button, and never logs it. `setup.html` posts `{ bootstrap, email, password, displayName }` to `/auth/register`; the core accepts `bootstrap` only when it equals `config.bootstrapToken` **and** no real user exists, creating the first account as `owner`/`execute`/no cap (one use: once any real user exists, every bootstrap is refused). `lock-registration` rewrites `1`, removes `/etc/llmide/bootstrap.env`, restarts, and verifies `/auth/well-known`; the static page stays but registration now answers `REGISTRATION_CLOSED`. The UI shows a live stage list (from Tauri events) and a final "Hub is live at https://…; registration is closed" card. `setup.html` is served by `nginx` only at exact `/setup` (no directory listing, no caching); it is removed by `uninstall`.

- [ ] **Step 4: Run it to verify it passes**

Run the cargo test and the Node bootstrap test; on the scratch VM run a full deploy, create the owner, lock registration; then break the bundle on purpose (wrong VERSION) and confirm an automatic rollback to the previous release.

- [ ] **Step 5: Commit**

```
feat(remote): a confirmed deploy with a health gate, owner window and automatic rollback
```

**Phase 2 exit:** a fresh Ubuntu 24.04 x86_64 server runs the hub under systemd behind nginx TLS; `/health` reports `hub: true`; registration is closed; the desktop has the hub URL (the TLS pin is added in P3.2); no secret appears in argv, logs or events; a failed start rolls back; `cargo test --lib` + `desktop && npm test` green.

---

## Phase 3 — desktop remote-core client

**Outcome:** with `remote_server.mode = "remote"`, the app starts **no local core**. It connects to the hub through a loopback proxy in the Rust host, pins the hub TLS key, signs in as a hub member, shows the hub's project list, and scopes every chat to a chosen project. Local-only screens say so. If the hub is down, the app offers an explicit "Work offline" restart into local mode; it never silently spawns a local core.

**Data path:** `React screens → http://127.0.0.1:<proxy>/<32-byte-token>/… → Rust proxy → https://<hub> (pinned TLS) → core`. The webview still sees a loopback URL, so `isLoopbackUrl` (`ui/screens/shell/core.ts:55`), the CSP (`127.0.0.1:3456-3459`) and the token-in-memory rule are unchanged.

### Task P3.1 — Remote mode never spawns a local core; switching modes is a restart

**Why.** "Remote" must mean exactly that. A background spawn would open the same SQLite DB beside the hub, double-run sync and confuse the status bar. The mode is decided before the core starts, so a restart is the only honest switch.

**Files.**
- Modify `desktop/src-tauri/src/core_host.rs:72-115` (`Tuning`), `:166-180` (`Phase`), `:191-230` (`CoreStatus`), `:431-509` (`start_in_background`/`run_startup`), `:1411` (`core_status`).
- Modify `desktop/src-tauri/src/lib.rs:600-615` (mode read), `:437` (prefs commands), add `app_restart`.
- Modify `ui/screens/settings/sections/ServerSection.tsx` (mode switch + confirm), `ui/screens/settings/remote-model.ts`.
- Test `core_host.rs` (`remote_mode_does_not_spawn`), `ui/screens/settings/tests/server-mode.test.mjs`.

**Interfaces.** `Tuning.mode: ServerMode` (set by `lib.rs:608` from `prefs::launch().remote_server.mode` after `prefs::init`; **do not read prefs in `CoreHost::new`**, which runs before `prefs::init`); `Phase::Remote` serialized `"remote"`; `CoreStatus` gains `mode: &'static str`, `remote_hub: Option<String>`, `remote_tls_pin: Option<String>`, `remote_session: bool` (P3.2 fills the last three from `remote_server.hub_url`/`tls_pin`; until then they are `None`/`false`). `verified_url()` returns `None` in remote mode (the host must not bind a remote token to its local chat archive). `core_start`/`core_stop`/`core_restart` start/stop the proxy in remote mode.

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn remote_mode_does_not_spawn_a_local_core() {
    let launches = Arc::new(AtomicUsize::new(0));
    let n = launches.clone();
    let host = CoreHost::with(
        Tuning { mode: ServerMode::Remote, ..Tuning::default() },
        Arc::new(move |_| { n.fetch_add(1, Ordering::SeqCst); Err("must not spawn".into()) }),
        Arc::new(|_| ClaudeInfo::unknown()),
    );
    host.start_in_background(Some(std::env::temp_dir()));
    assert_eq!(launches.load(Ordering::SeqCst), 0);
    let s = host.status();
    assert_eq!(s.mode, "remote");
    assert!(matches!(s.state, Phase::Remote | Phase::Starting | Phase::Ready | Phase::Failed));
    assert!(host.verified_url().is_none(), "a remote core is never a locally verified spawn");
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd desktop/src-tauri && CARGO_INCREMENTAL=0 cargo test --lib core_host::tests::remote_mode_does_not_spawn_a_local_core -- --exact`
Expected: FAIL (`Tuning` has no `mode`; `CoreStatus` has no `mode`).

- [ ] **Step 3: Write the minimal implementation**

Add `CoreHost::set_mode(ServerMode)` (an `AtomicU8` in `Inner`); `lib.rs` calls it right after `prefs::init` and before `start_in_background`. In `run_startup`, if the mode is `Remote`: do not probe `:3456`, do not adopt, do not spawn; call `remote_proxy::start(prefs)`; set `state: Ready` and `url` to the proxy URL on success, `Failed` with `error_code: "REMOTE_UNAVAILABLE"` on failure. `shutdown` stops the proxy. `core_status` reports `mode`, the hub URL (not a secret), whether a pin is set, and whether a stored session exists. Settings: a "Switch mode" button opens a native-confirm text ("LLM-IDE will restart to use the hub. Local-only screens will be unavailable."); on confirm write `remote_server.mode`, then invoke `app_restart`; remove the landed `remote_server` exception in `prefs.rs::view()` so a mode change reports `restartNeeded`. The current mode is read-only while signed-in work is running; the card says "Applies on the next app start."

- [ ] **Step 4: Run it to verify it passes**

Run the cargo test; switch the mode in Settings, confirm, and watch the app relaunch with no `node` child (`ps`); switch back and see the local core start.

- [ ] **Step 5: Commit**

```
feat(desktop): remote mode starts no local core and switches by restart
```

### Task P3.2 — Probe and pin the hub's TLS key

**Why.** A public hostname is not an identity. The desktop must show the certificate it is about to trust and compare the SPKI on every connection; a renewed/rotated key must fail closed, never silently re-pin.

**Files.**
- Create `desktop/src-tauri/src/remote_tls.rs`.
- Modify `desktop/src-tauri/Cargo.toml` (direct `rustls = "=0.23.46"`, `rustls-pki-types = "=1.15.1"`, `webpki-roots = "=1.0.11"`; versions already in `Cargo.lock`).
- Modify `desktop/src-tauri/src/prefs.rs` (`RemoteServerPrefs` gains `tls_pin: String`, `#[serde(default)]`; `hub_url` was added in P2.6; the block stays `deny_unknown_fields`), `remote_deploy.rs` (store the pin after deploy), `lib.rs`, `build.rs`, `capabilities/default.json`.
- Modify `ui/screens/settings/host.ts` (`RemoteServerConfig.hubUrl`/`tlsPin`), `remote-model.ts`, `RemoteDeployCard.tsx`.
- Test `remote_tls.rs` (`pin_mismatch_is_refused`, `probe_returns_spki_and_dates`); `ui/screens/settings/tests/remote-model.test.ts`.

**Interfaces.**
```rust
pub struct TlsInfo { pub fingerprint: String, pub subject: String, pub issuer: String, pub not_before: i64, pub not_after: i64, pub dns_names: Vec<String> }
#[tauri::command] pub async fn remote_tls_probe(hub_url: String) -> Result<TlsInfo, String>;
#[tauri::command] pub fn remote_tls_pin(hub_url: String, fingerprint: String) -> Result<(), String>; // stores in remote_server after confirm
pub fn pinned_agent(pin: &str) -> ureq::Agent; // used by the proxy and deploy health
```
`hub_url` is validated as `https://<host>[:port]` with no path beyond `/`, no userinfo, query or fragment; it is read from `RemoteServerPrefs.hub_url` (P2.6) or defaults to `https://<host>` when the user has not deployed yet. The verifier wraps `WebPkiServerVerifier` (normal chain + hostname) and additionally compares `sha256(end_entity.spki)` with the pin, in constant time. `ureq` gets `AgentBuilder::tls_config(Arc<rustls::ClientConfig>)`, `redirects(0)`, `timeout_connect(10s)`.

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn pin_mismatch_is_refused_and_never_falls_back() {
    let good = "sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    let other = "sha256:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
    assert!(pin_matches(good, good));
    assert!(!pin_matches(good, other));
    let cfg = pinned_config(good);
    assert_eq!(cfg.alpn_protocols, vec![b"http/1.1".to_vec()]);
    assert!(pinned_config(other).pin != cfg.pin, "the pin is carried into the config, not read from a global");
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd desktop/src-tauri && CARGO_INCREMENTAL=0 cargo test --lib remote_tls::tests::pin_mismatch_is_refused_and_never_falls_back -- --exact`
Expected: FAIL (module missing).

- [ ] **Step 3: Write the minimal implementation**

`remote_tls_probe` opens a TCP/TLS connection to `https://<hub>` (host only, port 443 or explicit), performs a normal handshake, and returns the leaf's SPKI SHA-256 as `sha256:<base64url-no-padding>`, subject/issuer (`X509Certificate`-like parse via `rustls-pki-types`/`webpki`), validity and SANs. It never returns the certificate body. The UI shows the fingerprint and the same "compare on the server" hint as SSH:
```
openssl x509 -in /etc/letsencrypt/live/<domain>/cert.pem -pubkey -noout | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | basenc --base64url
```
On confirm, `remote_tls_pin` stores `https://hub` + the pin. P2.6's deploy stores the pin automatically only after this dialog, not from the deploy output alone. A mismatch at any later call returns `REMOTE_TLS_PIN_MISMATCH` with the new fingerprint; the UI says "This hub's certificate changed. Compare the new fingerprint before trusting it." No auto re-pin.

- [ ] **Step 4: Run it to verify it passes**

Run the cargo test; on the scratch hub: Probe → fingerprint equals `openssl`; pin it; rotate the cert with a new key (test VM) → Connect fails with the changed-fingerprint message.

- [ ] **Step 5: Commit**

```
feat(remote): pin the hub certificate's SPKI and refuse a changed key
```

### Task P3.3 — The loopback pinned proxy (HTTP + SSE)

**Why.** The webview cannot pin a certificate and must not be widened to non-loopback URLs. A small loopback proxy keeps every existing security assumption and gives the UI a normal `http://127.0.0.1` core.

**Files.**
- Create `desktop/src-tauri/src/remote_proxy.rs`.
- Modify `core_host.rs` (start/stop proxy from remote mode), `remote_tls.rs` (pinned agent), `lib.rs` (no new command: the proxy starts with the host).
- Test `remote_proxy.rs` (`proxies_methods_and_streams_sse`, `refuses_unknown_prefix_and_oversize`, `never_follows_redirects`).

**Interfaces.** `ProxyHandle { url: String, token: String, stop(): }`; bind candidate ports `[3459, 3458, 3457]` (the CSP allows 3456-3459; 3456 is the local live port and is not used in remote mode but avoid it). The base URL is `http://127.0.0.1:<port>/<32-byte-base64url-token>`. Request handling:
- exact prefix match, else `404`;
- methods GET/POST/PUT/PATCH/DELETE; body cap 8 MiB (413);
- forward `Authorization`, `Content-Type`, `Accept`, `Last-Event-ID`, `x-llmide-client` (the UI may send it; no host nonce in remote); set `Host` to the hub host (never the loopback proxy host) and do **not** forward the webview's `Origin` (this is a direct client, not a browser);
- upstream `https://<hub>` + the rest of the path; no redirects; response status/headers/body streamed;
- when `Accept: text/event-stream`, flush every chunk (`io::copy` on the reader) and no read timeout; otherwise 60 s.
No credential is added by the proxy; it is a transparent transport for the UI's bearer. The proxy token is part of the base URL the host hands to the shell; the UI displays only `http://127.0.0.1:<port>` (never the token) and the diagnostics log records paths, not the base URL.

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn proxies_methods_and_streams_sse() {
    let up = FakeHub::start(|req| match req.path.as_str() {
        "/health" => (200, "application/json", "{\"ok\":true}".into()),
        "/agent/v2/stream" => (200, "text/event-stream", "data: one\n\ndata: two\n\n".into()),
        _ => (404, "text/plain", "no".into()),
    });
    let p = Proxy::start(up.url(), "tok").unwrap();
    let health = ureq::get(&format!("{}/tok/health", p.url)).call().unwrap();
    assert_eq!(health.into_string().unwrap(), "{\"ok\":true}");
    let mut r = ureq::get(&format!("{}/tok/agent/v2/stream", p.url)).set("Accept", "text/event-stream").call().unwrap();
    let mut buf = String::new();
    r.into_reader().read_to_string(&mut buf).unwrap();
    assert_eq!(buf, "data: one\n\ndata: two\n\n");
    assert_eq!(ureq::get(&format!("{}/nope/health", p.url)).call().unwrap_err().into_response().unwrap().status(), 404);
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd desktop/src-tauri && CARGO_INCREMENTAL=0 cargo test --lib remote_proxy::tests::proxies_methods_and_streams_sse -- --exact`
Expected: FAIL (module missing).

- [ ] **Step 3: Write the minimal implementation**

Use a `std::net::TcpListener` on loopback and one thread per connection (bounded to 16 concurrent; reject more with 503). Parse the request line and headers only (no chunked request bodies from the UI; if `Transfer-Encoding: chunked` arrives, 411). Build a `ureq::Request` with the pinned agent; copy the response with the same status and content type; for SSE, use `io::copy` and flush. Strip `Connection`, `Transfer-Encoding`, `Content-Length` when streaming and let the proxy set `Connection: close`. The token is compared in constant time. `stop()` sets an `AtomicBool` and connects once to unblock `accept`.

- [ ] **Step 4: Run it to verify it passes**

Run the cargo test; with the real hub, the UI's `/health` works, chat streams token-by-token, and a request from another local process without the token gets 404.

- [ ] **Step 5: Commit**

```
feat(remote): a loopback-only proxy that carries the UI's API to the pinned hub
```

### Task P3.4 — Hub session in the keychain, bound to the hub and its pin

**Why.** A hub login should survive a restart, but a refresh token is a long-lived credential. It belongs in the OS keychain, and it must not be replayed to a re-pointed host after a certificate or URL change.

**Files.**
- Create `desktop/src-tauri/src/remote_session.rs`.
- Modify `desktop/src-tauri/src/secrets.rs:24-30` (`ACCOUNT_HUB_SESSION`), `lib.rs` (`remote_session_load/store/clear`), `build.rs`, `capabilities/default.json`.
- Modify `ui/screens/shell/core.ts:232`/`:536` (`restoreSession()`, `register(..., invite?)`), `ui/screens/shell/Panels.tsx:104-210` (invite field when the hub's registration is closed), `ui/screens/shell/Shell.tsx` (call `restoreSession()` on mount in remote mode), `ui/screens/settings/remote-model.ts`.
- Test `remote_session.rs` (`session_is_bound_to_url_and_pin`, `status_never_returns_the_token`), `ui/screens/shell/tests/core.test.mjs`.

**Interfaces.**
```rust
pub const ACCOUNT_HUB_SESSION: &str = "hub-session";
#[derive(Serialize, Deserialize)] struct StoredSession { v: u8, hub: String, pin: String, refresh: String }
#[tauri::command] pub fn remote_session_store(hub: String, pin: String, refresh: String) -> Result<(), String>;
#[tauri::command] pub fn remote_session_load() -> Result<Option<String>, String>; // refresh token, only if hub+pin match prefs
#[tauri::command] pub fn remote_session_clear() -> Result<(), String>;
```
`secrets_status` gains `hub_session: bool` (never the value). The JSON blob is one keychain entry; `Debug` is redacted.

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn session_is_bound_to_the_url_and_pin() {
    let b = MemoryBackend::default();
    store(&b, "https://hub.example.com", "sha256:AAA", "refresh-1").unwrap();
    assert_eq!(load(&b, "https://hub.example.com", "sha256:AAA").unwrap().as_deref(), Some("refresh-1"));
    assert_eq!(load(&b, "https://hub.example.com", "sha256:BBB").unwrap(), None);
    assert_eq!(load(&b, "https://evil.example.com", "sha256:AAA").unwrap(), None);
    // A mismatch clears the stored value: it must never be sent to the new host.
    assert!(b.get(ACCOUNT_HUB_SESSION).unwrap().is_none());
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd desktop/src-tauri && CARGO_INCREMENTAL=0 cargo test --lib remote_session::tests::session_is_bound_to_the_url_and_pin -- --exact`
Expected: FAIL.

- [ ] **Step 3: Write the minimal implementation**

Hub accounts are invite-only: the remote Register form must send the owner's single-use `invite` token (`POST /auth/register {email,password,displayName?,invite}` — the core already accepts it, `extension/server/users.mjs:85`). In remote mode `canRegister` comes from `/auth/well-known` plus an invite field; a failed invite shows `INVITE_INVALID`/`REGISTRATION_CLOSED` in plain text. Store `{v:1, hub, pin, refresh}` under `hub-session`. `load` compares the stored hub/pin with `remote_server.hub_url` and `remote_server.tls_pin` (exact string equality, both already validated) before returning; on mismatch it deletes the entry and returns `None`. The UI's `restoreSession()` calls `remote_session_load`, POSTs `/auth/refresh`, sets tokens (existing `setTokens` path), and on 401 clears the keychain and signs out. After every refresh, the UI calls `remote_session_store` with the rotated token. Sign-out clears it. Never log the token; `CoreError` messages contain status/code only.

- [ ] **Step 4: Run it to verify it passes**

Run the cargo test; restart the app while signed in to the hub → signed in; change the TLS pin (test) → signed out and the keychain entry gone.

- [ ] **Step 5: Commit**

```
feat(remote): keep the hub session in the OS keychain, bound to the pinned host
```

### Task P3.5 — The shell knows its core is a remote hub

**Why.** Trust, host proof and the host chat binding were written for a spawned local core. In remote mode the shell must allow credentials to the pinned proxy, never request a host proof, and never bind the hub token to the local chat archive.

**Files.**
- Modify `ui/screens/shell/host.ts:12` (`CoreTrust`), `:16-41` (`CoreStatus`, `CoreState`), `:157` (decode), `ui/screens/settings/host.ts:14` (`CoreTrust`, the hyphenated union used by Settings), `ui/screens/shell/settings-adapter.ts` (`trustOf`), `ui/screens/shell/runtime.ts:29-46`, `ui/screens/shell/trust-gate.ts:36-50`, `ui/screens/shell/chat-binding.ts` (eligibility), `ui/screens/shell/status-view.ts`/`StatusBar.tsx` (label).
- Modify `desktop/src-tauri/src/core_host.rs` (`verified_url` remote `None`); `chat_cmds.rs:29` already handles `None`.
- Test `ui/screens/shell/tests/trust-gate.test.mjs`, `ui/screens/shell/tests/status-store.test.mjs`.

**Interfaces.** Shell `CoreTrust` gains `"remote_pinned"`; Settings `CoreTrust` gains `"remote-pinned"` (it uses hyphens today: `spawned`/`adopted-unverified`). `CoreStatus.mode` is `"local" | "remote"`. `trustGate` treats `remote_pinned` as allowed (the pin was confirmed in P3.2/P3.4); `busProof` returns `null` for any non-`spawned` trust (already); `runtime.ts` passes `enabled: () => isHostAvailable() && coreStatus.mode === "local"` to `createChatBinding`.

- [ ] **Step 1: Write the failing test**

```js
test("a pinned remote core is trusted, carries no host proof and does not bind the host chat", async () => {
  let s = { url: "http://127.0.0.1:3459/tok", state: "ready", trust: "remote_pinned", mode: "remote", restarts: 0, pid: null };
  const g = createTrustGate({ getStatus: () => s, isHost: () => true });
  assert.equal(g.allowed(), true);
  assert.equal(g.view().needsConfirm, false);
  const b = createBusProofStore({ invoke: async () => "a".repeat(64), getStatus: () => s, subscribeStatus: () => () => {}, isHost: () => true });
  assert.equal(b.get(), null);
  s = { ...s, mode: "local", trust: "spawned" };
  assert.equal(g.allowed(), true);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd desktop && node --test --experimental-strip-types ui/screens/shell/tests/trust-gate.test.mjs`
Expected: FAIL (`remote_pinned` is not allowed; `createBusProofStore` import may need exposing).

- [ ] **Step 3: Write the minimal implementation**

Add `remote_pinned` to the `CoreTrust` union and to `compute()` (allowed, no confirm). Add `mode` to `CoreStatus` (default `"local"` for older hosts) and to the status view label ("Hub: connected", "Hub: reconnecting"). `runtime.ts` disables `chatBinding` in remote mode. The status bar's core menu hides Start/Stop/Restart's local meanings in remote mode and shows Connect/Reconnect instead (backed by `core_start`/`core_stop`, which now drive the proxy). `settings-adapter.ts` reports `coreTrust: "remote-pinned"` for Settings (its `trustOf` maps the shell value).

- [ ] **Step 4: Run it to verify it passes**

Run the node test; with the real hub, the login screen appears without an "untrusted core" modal and no `chat_bind_session` call is made (host log).

- [ ] **Step 5: Commit**

```
feat(ui): treat a pinned remote core as trusted without a host proof
```

### Task P3.6 — Remote project list, picker and `projectId` scoping

**Why.** The hub requires a project for project work (`PROJECT_WORK_ROUTES`, `extension/server/route-authority.mjs:60`) and project roles decide what the member may do. A remote chat with no project is refused; the desktop must show the hub's projects and send the chosen id on every scoped frame.

**Files.**
- Create `ui/screens/shell/remote-projects.ts`, `ui/screens/shell/RemoteProjectBar.tsx`.
- Modify `ui/screens/shell/use-shell.ts`, `Shell.tsx:99-180`, `sections.ts` (`SectionProps`), `ui/screens/chat/ChatScreen.tsx:160-180`, `ui/screens/chat/surface.tsx:63` (use `HttpChatStore` in remote mode, not `TauriChatStore`), `ui/screens/chat/store.ts` (project id source), `ui/screens/settings/team-projects-model.ts` (reuse decoder).
- Test `ui/screens/shell/tests/remote-projects.test.mjs`, `ui/screens/chat/tests/store-route.test.mjs`.

**Interfaces.**
```ts
export interface RemoteProject { id: string; name: string; role: "owner"|"admin"|"member"|"viewer"; maxMode: "none"|"read_only"|"execute"; usdCapMonth: number; permissions: string[] }
export function createRemoteProjects(client: Pick<CoreClient,"request">, storage: KeyValueStorage, hubKey: string): RemoteProjects;
// getSnapshot(): { projects, selectedId, status: "loading"|"ready"|"error", error }
// select(id), whenReady(), refresh()
```
`GET /projects` (API 126, `docs/how-to/project-roles.md`) returns the list; the picker persists `selectedId` per hub fingerprint, not per local folder. `create(name)` sends `POST /kb/projects/register { id, name }` on a hub (`id` is the client-derived project id, `crypto.randomUUID()` or the existing id rule; the core rejects a duplicate id); the P2.3 core guard derives `<projectsRoot>/<slug>-<4 hex>` (0700 `llmide`), inserts the row and makes the creator `owner`. A hub request with a `root` outside `LLMIDE_PROJECTS_ROOT` is `403 PROJECT_ROOT_NOT_ALLOWED` (P2.3); a local install keeps the existing path-based register unchanged. `projectsRoot` is env-only and never returned to a client. `SectionProps` gains `projectId: string | null`; `ChatScreen` sends `body.projectId` and passes `projectId` to `createSession`. `chat/surface.tsx` chooses `new HttpChatStore(coreTransport)` when `mode === "remote"` and `TauriChatStore` only in local mode (the host archive cannot hold hub chats). A viewer's compose options come from `chat.options` (the server already filters); the UI also disables send when the selected project role is `viewer` and the mode is not Ask.

- [ ] **Step 1: Write the failing test**

```js
test("remote projects load, persist per hub, and expose the role", async () => {
  const calls = [];
  const client = { request: async (path) => { calls.push(path); return { projects: [
    { id: "p1", name: "Alpha", role: "member", maxMode: "execute", usdCapMonth: 20, permissions: ["model.ask", "model.exec"] },
    { id: "p2", name: "Beta", role: "viewer", maxMode: "read_only", usdCapMonth: 20, permissions: ["model.ask"] },
  ] }; } };
  const s = memory();
  const r = createRemoteProjects(client, s, "sha256:AAA");
  await r.whenReady();
  assert.deepEqual(r.getSnapshot().projects.map((p) => p.id), ["p1", "p2"]);
  assert.equal(r.getSnapshot().selectedId, "p1");
  r.select("p2");
  assert.equal(createRemoteProjects(client, s, "sha256:AAA").getSnapshot().selectedId, "p2");
  assert.equal(createRemoteProjects(client, s, "sha256:BBB").getSnapshot().selectedId, "p1");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd desktop && node --test --experimental-strip-types ui/screens/shell/tests/remote-projects.test.mjs`
Expected: FAIL (module missing).

- [ ] **Step 3: Write the minimal implementation**

Add the store and a compact project picker in the toolbar (name + role badge; disabled while loading) with a **New project** action (name only; the core derives the folder). On `Shell` in remote mode, open the picker instead of the local Welcome project flow; `projectRoot` stays `null`, `projectId` is set. `ChatScreen` uses `projectId` when present and refuses to send before a project is selected (one inline status: "Choose a hub project to chat"). `tauri-store` is not used in remote mode; `HttpChatStore` already sends the project id on session creation. Refresh the list on focus and after a role change; a 403 `PROJECT_DENIED` from a frame clears the selection and reloads.

- [ ] **Step 4: Run it to verify it passes**

Run the node test; with the hub: the picker lists Alpha/Beta, a viewer on Beta sees Ask only, chat on Beta sends `projectId: "p2"` and the hub history is project-scoped.

- [ ] **Step 5: Commit**

```
feat(remote): pick a hub project and scope every scoped request to it
```

### Task P3.7 — Remote-safe screens and honest local-only notices

**Why.** Explorer, Terminal, Graph, Doc Gen folders, Repositories, Memory, Visual and Live capture are host-filesystem or host-process features. Showing them against a remote hub produces confusing failures; hiding them silently is worse.

**Files.**
- Modify `ui/screens/shell/sections.ts:12-120` (`SectionId`, `SECTIONS`, `visibleSections`, `isSelectable`), `Shell.tsx:99-220` (`SectionSlot`, nav), `ui/screens/settings/groups.ts:29-60`, `SettingsScreen.tsx` (filter), `ui/screens/settings/sections/NoticeSections.tsx`.
- Create `ui/screens/shell/remote-only.ts` (allowlist + notice text).
- Test `ui/screens/shell/tests/sections.test.mjs` (new), `ui/screens/settings/tests/components.test.mjs` (render).

**Interfaces.**
```ts
export const REMOTE_SECTIONS: readonly SectionId[] = ["welcome", "chat", "library", "issues", "gantt", "settings"];
export function visibleSectionsFor(mode: "local" | "remote"): readonly SectionDef[];
export function isSelectableFor(id: string, mode: "local" | "remote"): boolean;
export const REMOTE_GROUP_HIDDEN: readonly string[] = ["workspace","build","token-saving","paths","repositories","memory","code-graph","doc-gen","optional-components","self-heal"];
export const LOCAL_ONLY_NOTICE = "This screen reads files or runs processes on the local computer. It is unavailable when the app is connected to a hub.";
```
The nav in remote mode lists only `REMOTE_SECTIONS`; an attempt to deep-link another section lands on Home with a one-line `role="status"` notice. Issues and Gantt are **read-only** in remote v1: the hosted issue writes (`POST /kb/issues/create|comment|close`) are host-proof routes and are hidden behind a `Local desktop only` hint. Settings hides the groups above and keeps `server`, `mobile` (hub pairing, P4), `team`, `providers`, `model-routing`, `agent-history`, `general`, `updates`, `tool-permissions`, `agent-sdk`, `connections`, `loop-defaults`. `workspace` (the local core's feature profile), `build`, `token-saving` (installs a local CLI) and `optional-components` stay local-only. The shell's `hostAvailable()` for local-only commands becomes `isHostAvailable() && mode === "local"`, so a stray button cannot invoke a local command.

- [ ] **Step 1: Write the failing test**

```js
test("remote mode lists only the screens that work over a hub", () => {
  assert.deepEqual(visibleSectionsFor("remote").map((s) => s.id), ["welcome", "chat", "library", "issues", "gantt", "settings"]);
  assert.equal(isSelectableFor("explorer", "remote"), false);
  assert.equal(isSelectableFor("explorer", "local"), true);
  assert.match(LOCAL_ONLY_NOTICE, /local computer/);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd desktop && node --test --experimental-strip-types ui/screens/shell/tests/sections.test.mjs`
Expected: FAIL (functions missing).

- [ ] **Step 3: Write the minimal implementation**

Thread `mode` from `coreStatusStore` into the nav and Settings. `sections.ts` stays pure (the mode is a parameter, not a global). The Home screen in remote mode shows the hub project picker and three cards: "Chat", "Library", "Team"; no local "Open a folder". `SettingsScreen` filters `APP_GROUPS`/`PROJECT_GROUPS` with `REMOTE_GROUP_HIDDEN` and shows one `PartialNote` explaining why. `Shell` passes `projectRoot: null` and `projectId` (P3.6); a section not in the allowlist is never mounted.

- [ ] **Step 4: Run it to verify it passes**

Run the node test; with the hub: the toolbar has Home, Chat, Library, Issues, Gantt, Settings; Explorer/Terminal are absent; Settings does not show Paths or Repositories; the notice appears on a deep link.

- [ ] **Step 5: Commit**

```
feat(ui): remote mode offers the hub-safe screens and says why the rest are local
```

### Task P3.8 — Explicit offline fallback; never a silent local spawn

**Why.** The hub is a single host. If it is down, the user needs a way to work locally, but automatically spawning a local core would fork the data and hide the outage. The fallback is a deliberate action that restarts into local mode.

**Files.**
- Create `ui/screens/shell/remote-status.ts`, `RemoteDownBanner.tsx`.
- Modify `ui/screens/shell/Shell.tsx:340-360` (banner), `ui/screens/shell/status-store.ts`/`status-view.ts`, `ui/screens/settings/sections/ServerSection.tsx`.
- Modify `remote_proxy.rs` (health poll/state), `core_host.rs` (`remote_state`), `lib.rs` (`app_restart`).
- Test `ui/screens/shell/tests/remote-status.test.mjs`.

**Interfaces.**
```ts
export type RemoteState = "connecting" | "online" | "offline";
export function remoteFallbackAction(deps: { setMode(mode: "local"): Promise<void>; restart(): Promise<void> }): Promise<void>;
export function remoteBanner(state: RemoteState, hasSession: boolean): { title: string; body: string } | null;
```
When the proxy reports `REMOTE_UNAVAILABLE` or three consecutive failed `/health` polls (5 s interval), the shell shows `Hub unreachable` with **Retry** and **Work offline**. "Work offline" opens a native confirm ("Start the local core? The hub keeps running; chats are now local."), writes `remote_server.mode = local`, then `app_restart`. It never calls `core_start` in remote mode to spawn a local core. After the restart the local core owns the data again and its sync scheduler resumes, so MEGA/Box/SFTP snapshots continue from local mode (they are refused on a hub, P4.5).

- [ ] **Step 1: Write the failing test**

```js
test("offline shows a banner; only the explicit action switches mode and restarts", async () => {
  assert.equal(remoteBanner("online", true), null);
  assert.match(remoteBanner("offline", true).title, /unreachable/i);
  const calls = [];
  await remoteFallbackAction({ setMode: async (m) => calls.push(["mode", m]), restart: async () => calls.push(["restart"]) });
  assert.deepEqual(calls, [["mode", "local"], ["restart"]]);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd desktop && node --test --experimental-strip-types ui/screens/shell/tests/remote-status.test.mjs`
Expected: FAIL (module missing).

- [ ] **Step 3: Write the minimal implementation**

Add `app_restart` (`tauri::AppHandle::restart()`), registered and capability-granted. The proxy exposes `state()` (`connecting|online|offline`) via `core_status` (`remote_state`); the status store polls `/health` through the proxy every 5 s while remote and marks offline on transport errors only (not 401/403). The banner is non-blocking (chat history remains readable from the last responses? No: the hub is the source; show a truthful "No new data until the hub is back" line). "Retry" restarts the proxy and re-probes. Switching back to local is always available from Settings, signed in or not.

- [ ] **Step 4: Run it to verify it passes**

Run the node test; stop the hub (`systemctl stop llmide-core` on the scratch VM) → banner within 15 s; press Work offline → app restarts with a local core; start the hub again and switch back → hub session restored from the keychain.

- [ ] **Step 5: Commit**

```
feat(remote): an explicit offline fallback to the local core
```

**Phase 3 exit:** remote mode launches no local core; TLS pin probe + mismatch; proxy serves HTTP and SSE; hub login survives a restart in the keychain; the shell shows the hub project picker and only remote-safe screens; a stopped hub offers an explicit offline restart; `cargo test --lib`, `desktop && npm test`, `make test-desktop-node` green.

---

## Phase 4 — web and iPhone hub pairing, per project roles

**Outcome:** the hub serves the Host API behind nginx at `wss://<hub>/host-api/v1`; the PIN answer carries that URL and the front's pin; the web app pairs, lists projects and sends `projectId`; the phone pairs per project with its existing role screens; MEGA/sync is refused on a hub.

### Task P4.1 — Host API listener behind the hub's TLS terminator

**Why.** The browser cannot trust a self-signed listener, and a second public port is another firewall hole. In hub mode the v1 listener must bind loopback plaintext, accept only loopback peers, and trust `Origin`/`X-Forwarded-Proto` only when nginx set them.

**Files.**
- Modify `extension/core/config.mjs:265-300` (`hostApiHub`, mode precedence), `extension/server.mjs:1577-1620` (hub boot log/guard), `:1765-1795` (start listener), `extension/server/host-api-listener.mjs:31-90` (`upgradeRefusal`, bind host, limits).
- Modify `extension/CLAUDE.md` (env), `docs/reference/env-vars.md` (generated table).
- Test `extension/tests/host-api-listener-hub.test.mjs` (new).

**Interfaces.** New env `LLMIDE_HOST_API_HUB=1`. Requires `LLMIDE_HUB=1` and `LLMIDE_TLS_TERMINATED=1`; otherwise refuse the boot (`hub_host_api_requires_tls`, exit 1). Mode is `hub` when the flag is set, above `tls`/`dev`; it binds `127.0.0.1:3016` plaintext. `upgradeRefusal(req, { tls, hub, allowlist })` in hub mode:
- peer must be loopback;
- `Origin` must be exactly in `allowlist` (no wildcard);
- `x-forwarded-proto` must be `https` (nginx sets it);
- otherwise 403 `plaintext_refused` / `origin_refused`.

- [ ] **Step 1: Write the failing test**

```js
test("hub listener accepts only loopback + https-forwarded exact origins", () => {
  const allow = ["https://hub.example.com"];
  const req = (o = {}) => ({ url: "/host-api/v1", headers: { origin: "https://hub.example.com", "x-forwarded-proto": "https", ...o.headers }, socket: { remoteAddress: o.peer ?? "127.0.0.1" } });
  assert.equal(upgradeRefusal(req(), { hub: true, allowlist: allow }), null);
  assert.equal(upgradeRefusal(req({ headers: { "x-forwarded-proto": "http" } }), { hub: true, allowlist: allow }).status, 403);
  assert.equal(upgradeRefusal(req({ peer: "10.0.0.5" }), { hub: true, allowlist: allow }).status, 403);
  assert.equal(upgradeRefusal(req({ headers: { origin: "https://evil.example.com" } }), { hub: true, allowlist: allow }).status, 403);
  assert.equal(upgradeRefusal(req(), { hub: false, tls: true, allowlist: allow }), null);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd extension && node --test --test-name-pattern "hub listener accepts only loopback" tests/host-api-listener-hub.test.mjs`
Expected: FAIL (`upgradeRefusal` ignores `hub`; `x-forwarded-proto` not checked).

- [ ] **Step 3: Write the minimal implementation**

Add `hostApiHub` to config and the mode precedence. In `startHostApiListener`, `host = hub ? "127.0.0.1" : tls ? "0.0.0.0" : "127.0.0.1"`. `upgradeRefusal` gets the `hub` flag and the exact checks above. Boot logs `host_api_hub` with the port and origin count (never the origins? they are public; log one). The main server keeps binding `127.0.0.1`; nginx is the only 443. No new HTTP route.

- [ ] **Step 4: Run it to verify it passes**

Run the test; `LLMIDE_HUB=1 LLMIDE_TLS_TERMINATED=1 LLMIDE_HOST_API_HUB=1 node extension/server.mjs` listens on `127.0.0.1:3016`; without `LLMIDE_HUB` it exits 1 with `hub_host_api_requires_tls`; a `wss://` client through nginx pairs.

- [ ] **Step 5: Commit**

```
feat(hub): serve the Host API on loopback behind the hub's TLS terminator
```

### Task P4.2 — Pairing answers the hub URL and the front's certificate pin (API 129)

**Why.** The phone must know where to dial and what to pin; the web app needs the WSS URL. Today the PIN answer has `port`/`fingerprint` of the core's own listener, which a hub does not serve.

**Files.**
- Modify `extension/routes/host-api/http-routes.mjs:60-90` (PIN answer), `extension/server/host-identity.mjs` (read the front pin file), `extension/core/config.mjs` (`hostApiPublicUrl`, `hostApiFingerprintFile`).
- Modify `schema/http/host-api.schema.json` (PIN response additive fields), `schema/host-api/v1/README.md`, `extension/server.mjs:326-340` (API 129 comment), `docs/spec/api-server.md`.
- Test `extension/tests/host-api-hub-pin.test.mjs` (new).

**Interfaces.** In hub mode `POST /host-api/pin` returns:
```json
{ "pin": "123456", "expiresAt": 0, "port": 443,
  "fingerprint": "sha256:...", "addresses": ["hub.example.com"],
  "url": "wss://hub.example.com/host-api/v1" }
```
`fingerprint` is read from `LLMIDE_HOST_API_FINGERPRINT_FILE` (0644, written by P2.5), validated `^sha256:[A-Za-z0-9_-]{43}$`; `url` from `LLMIDE_HUB_PUBLIC_URL` (validated `wss://<host>[:port]/host-api/v1`). Missing/malformed either → `503 HUB_PIN_UNAVAILABLE`, never a null pin. Outside hub mode the answer is unchanged.

- [ ] **Step 1: Write the failing test**

```js
test("hub PIN carries the public WSS URL and the front fingerprint", () => {
  const answer = hubPinAnswer({ pin: "123456", expiresAt: 1, publicUrl: "wss://hub.example.com/host-api/v1", fingerprint: "sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", host: "hub.example.com" });
  assert.equal(answer.port, 443);
  assert.equal(answer.url, "wss://hub.example.com/host-api/v1");
  assert.deepEqual(answer.addresses, ["hub.example.com"]);
  assert.throws(() => hubPinAnswer({ pin: "123456", expiresAt: 1, publicUrl: "ws://hub/host-api/v1", fingerprint: "x", host: "hub" }), /HUB_PIN_UNAVAILABLE/);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd extension && node --test --test-name-pattern "hub PIN carries" tests/host-api-hub-pin.test.mjs`
Expected: FAIL (`hubPinAnswer` missing).

- [ ] **Step 3: Write the minimal implementation**

Add `hubPinAnswer` as a pure function used by the handler. Read the fingerprint file once at boot (cache) and re-read if `mtime` changes? The pin must update after a Certbot renewal; read it per PIN request (a tiny file), validate, cache for 60 s. Add the fields to the schema and the HTTP fixture; run `make inventory`? `INVENTORY.md` is generated and not a gate; run `node scripts/http-inventory.mjs --coverage`. Bump `SERVER_API_VERSION` to 129 and add the one-line v129 comment. The iPhone's `h1port` is 443 and `h1fp` is the same leaf; the host name is the `ip` field (P4.6 decides if public is allowed).

- [ ] **Step 4: Run it to verify it passes**

Run the test; `make contract-gates`; `curl -X POST https://hub/host-api/pin` with a member JWT returns `url` + `fingerprint`; the fingerprint equals `openssl` on the leaf.

- [ ] **Step 5: Commit**

```
feat(hub): pairing answers the public WSS URL and the front's certificate pin
```

### Task P4.3 — nginx WebSocket location and the pin file stage

**Why.** The Host API is a long-lived WebSocket; nginx must upgrade it, keep it open, log no paths, and pass the exact origin. The deploy must publish the pin file after every renewal.

**Files.**
- Modify `deploy/hub/llm-ide-hub.nginx.template` (`/host-api/v1` block, `access_log off`, `proxy_read_timeout 3600s`), `deploy/hub/llmide-deploy` (`nginx` stage writes the pin; `certbot renew --deploy-hook` re-writes it).
- Modify `remote_deploy.rs` (pin extraction/validation), `RemoteDeployCard`.
- Test `remote_deploy.rs` (`vhost_upgrades_host_api`), a shell test `deploy/hub/check-hub.sh` (read-only, run by the deploy verify stage).

**Interfaces.** `check-hub.sh` verifies: `nginx -t`; `systemctl is-active llmide-core`; `curl -fsS http://127.0.0.1:3457/health`; `curl -fsS https://<domain>/health`; `test -r /etc/llmide/host-api-fingerprint`; `openssl` pin equals the file; `ss -ltnp` shows no public 3457/3016. It prints `PASS`/`FAIL` lines and exits non-zero on any FAIL.

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn vhost_upgrades_the_host_api_and_keeps_it_open() {
    let v = render_vhost("hub.example.com");
    assert!(v.contains("location = /host-api/v1"));
    assert!(v.contains("proxy_http_version 1.1"));
    assert!(v.contains("proxy_set_header Upgrade $http_upgrade"));
    assert!(v.contains("proxy_set_header Connection \"upgrade\""));
    assert!(v.contains("proxy_read_timeout 3600s"));
    assert!(v.contains("access_log off;"));
    assert!(v.contains("proxy_set_header X-Forwarded-Proto https;"));
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd desktop/src-tauri && CARGO_INCREMENTAL=0 cargo test --lib remote_deploy::tests::vhost_upgrades_the_host_api_and_keeps_it_open -- --exact`
Expected: FAIL.

- [ ] **Step 3: Write the minimal implementation**

Add the block to the template, plus `location = /host-api/v1` before the generic `/` location (nginx longest-prefix exact match wins). The deploy writes `/etc/llmide/host-api-fingerprint` and installs `/etc/letsencrypt/renewal-hooks/deploy/llmide-pin.sh` (root 0755) that recomputes and writes the pin, then `systemctl reload nginx`; the core caches the file for 60 s (P4.2). The check script is installed at `/usr/local/bin/llmide-check` and run at the end of every deploy/update; the Rust side parses the PASS/FAIL lines.

- [ ] **Step 4: Run it to verify it passes**

Run the cargo test; rebuild the hub bundle (`node desktop/scripts/stage-hub-core.mjs`) and redeploy/update it so the hub runs the P4.1/P4.2 code; then `sudo /usr/local/bin/llmide-check` all PASS; `wscat`/web app pairs through nginx; `ss -ltn` shows 3016 and 3457 only on 127.0.0.1.

- [ ] **Step 5: Commit**

```
feat(hub): nginx upgrades the Host API websocket and publishes its pin
```

### Task P4.4 — Web app pairs with a hub; project picker and roles stay

**Why.** The web app already knows how to pair, list projects and send `projectId`; it needs a hub URL default, a `hostKind: "hub"` signal to hide offline-only affordances, and a CSP/origin story that works from `https://<hub>/app/`.

**Files.**
- Create `web/src/hub-copy.ts` (`isHubHost`, `hubCopy`, `syncEntryVisible`). Modify `web/src/host-api/url.ts` (hub default via `__HUB_URL__`/`VITE_HUB_URL`), `web/src/app-model.ts` (auto-connect), `web/src/App.tsx` (pairing copy), `web/src/projects/controller.ts` (already role-aware; add hub gate), `web/index.html`/`web/server.mjs` (CSP `connect-src` exact), `web/DEPLOY.md`, `web/README.md`.
- Modify `desktop/scripts/stage-hub-core.mjs`/`deploy/hub/llmide-deploy` (`web` stage: build `web/dist` with `VITE_BASE=/app/`, upload to `/var/www/llmide-web`, verify `index.html` + `manifest.webmanifest`).
- Modify `extension/routes/host-api/translator.mjs`/`gateway.mjs` (`host.hello.hostKind = config.hub ? "hub" : "desktop"`), `schema/host-api/v1` fixtures/`commands.json`? `host.hello` is a command result, not schema; update the generated types and fixtures.
- Test `web/tests/url-storage.test.mjs`, `web/tests/app.test.mjs`, `extension/tests/host-api-gateway.test.mjs` (`hello` hub kind).

**Interfaces.** `host.hello` result gains `hostKind: "desktop" | "hub"` (additive; existing clients ignore it). `isHubHost(hello)` in `web/src/app-model.ts`; when true, the web app hides "Offline sync (MEGA)" and shows "Connected to a hub; it stays online." The pairing screen pre-fills `wss://<hub>/host-api/v1` when built with `VITE_HUB_URL`; the URL validator still refuses `ws://` for any non-loopback host and refuses `http://` hosts. `projectId` sends unchanged (already implemented).

- [ ] **Step 1: Write the failing test**

```js
test("a hub host hides offline sync and keeps the project scope", async () => {
  assert.equal(isHubHost({ hostKind: "hub" }), true);
  assert.equal(isHubHost({ hostKind: "desktop" }), false);
  assert.equal(hubCopy({ hostKind: "desktop" }), null);
  assert.match(hubCopy({ hostKind: "hub" }), /stays online/);
  assert.equal(syncEntryVisible({ hostKind: "hub" }), false);
  assert.equal(syncEntryVisible({ hostKind: "desktop" }), true);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd web && node --test --test-name-pattern "hub host hides offline sync" tests/app.test.mjs`
Expected: FAIL (`isHubHost` missing; copy absent).

- [ ] **Step 3: Write the minimal implementation**

Add `hostKind` to the gateway's `host.hello` result (hub only; desktop stays `"desktop"`), regenerate Host API types (`node scripts/generate-host-api.mjs`), add the fixture. Web: `initialHostUrl()` uses `__HUB_URL__` when set; `App` renders the hub copy when `hostKind === "hub"`; the sync entry point is hidden for a hub; the URL validator is unchanged (already secure). CSP: the nginx vhost already allows `wss:`; narrow the PWA's `connect-src` to `'self' wss://<hub>` in the hub template, not a wildcard. The PWA is built with `VITE_BASE=/app/` and served at `https://<hub>/app/`; the service worker scope is `/app/`.

- [ ] **Step 4: Run it to verify it passes**

Run the web test + `npx tsc --noEmit -p .`; build with `VITE_BASE=/app/ VITE_HUB_URL=wss://hub.example.com/host-api/v1`, open `https://hub.example.com/app/`, pair, see Alpha/Beta with roles, send in Alpha; the offline sync link is absent.

- [ ] **Step 5: Commit**

```
feat(web): pair with a hub by project and hide local-only offline sync
```

### Task P4.5 — MEGA/Box/SFTP sync is local-mode only

**Why.** A hub is always on; a second encrypted snapshot path adds a source of truth, a credential, and a producer that would upload a hub DB to MEGA. Sync is the local/offline feature (ADR 0020); on a hub it must be refused, not merely hidden.

**Files.**
- Modify `extension/server.mjs:400` (`isSyncRoute` guard), `extension/routes/sync/http-routes.mjs` (early refusal), `extension/server/route-authority.mjs` (comment/class if needed), `ui/screens/settings/groups.ts`/`SyncSection.tsx` (hidden in remote), `web/src/App.tsx` (hidden for hub, P4.4).
- Modify `docs/explanation/architecture.md`, `docs/how-to/sync-box-setup.md`, `docs/how-to/run-a-hub.md` (P5.5).
- Test `extension/tests/sync-hub-refused.test.mjs` (new), `ui/screens/settings/tests/sync-section.test.mjs`.

**Interfaces.** On `config.hub`, every `/kb/sync/*` answer is `409 { error: { code: "SYNC_LOCAL_ONLY", message: "Encrypted sync is a local desktop feature. This is a hub." } }`, before auth/feature work; `/kb/sync/box/callback` stays public but answers 404? It is a browser redirect; return 409 text. The desktop Settings hides the `mobile` sync body in local mode? No: in remote mode, the `mobile` group shows only hub pairing (P4.1/P4.2), not sync. Local mode is unchanged.

- [ ] **Step 1: Write the failing test**

```js
test("a hub refuses every sync route before doing work", async () => {
  const res = await callSyncRoute({ hub: true, method: "GET", path: "/kb/sync/status" });
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, "SYNC_LOCAL_ONLY");
  const local = await callSyncRoute({ hub: false, method: "GET", path: "/kb/sync/status" });
  assert.notEqual(local.status, 409);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd extension && node --test --test-name-pattern "a hub refuses every sync route" tests/sync-hub-refused.test.mjs`
Expected: FAIL (a hub still serves sync).

- [ ] **Step 3: Write the minimal implementation**

At the top of the sync handler (and the `isSyncRoute` branch in `server.mjs`), return the 409 without touching the vault or the store. Keep the routes in `ROUTE_POLICY` (`host` class) so the old desktop behavior and the inventory stay valid; the hub refusal is earlier. The desktop's `SyncSection` is not rendered when `mode === "remote"`; `SyncDevices` is hidden too. Document the decision in ADR 0020's consequences? Do not edit the ADR; add a line to `docs/how-to/run-a-hub.md`.

- [ ] **Step 4: Run it to verify it passes**

Run the test; on the hub, Settings → Phone and browser shows hub pairing only; `curl` to `/kb/sync/status` returns 409; a local install still syncs.

- [ ] **Step 5: Commit**

```
feat(hub): encrypted sync and MEGA stay a local-desktop feature
```

### Task P4.6 — iPhone hub pairing (GATED — D2; no `ios_app/**` edits in this pass)

**Why.** The iPhone already lists projects and roles; the only blocker is `PairingInfo.canonicalPrivateHost`, which refuses public DNS names. With a Tailscale/private hub name no app change is needed. With a public domain, one small Swift change is needed and is owned by the iOS app, not this coder.

**Files (hand-off only; do not edit in this pass).**
- `ios_app/SharedProtocol/Sources/SharedProtocol/PairingInfo.swift:50` (`canonicalPrivateHost`), `:16` (`h1fp`/`h1port`).
- Tests `ios_app/SharedProtocol/Tests/SharedProtocolTests/HostApiPinningTests.swift`, `PairingInfoTests.swift`.
- Docs `docs/how-to/run-a-hub.md`, `ios_app/README.md`.

**Interfaces.** The hub's PIN answer (P4.2) already carries `url` + `fingerprint`; the QR builder (P4.4/web or the desktop `HostApiPairing.tsx`) must emit:
```
llmide://pair?ip=<hub hostname>&pin=123456&h1port=443&h1fp=sha256:...&api=1
```
The iPhone must accept `ip` as a public DNS name **only when** `h1fp` is present and the scanned scheme is `llmide://` (QR), keeping the typed-PIN rule ("a typed PIN never adopts an offered h1fp", `HostApiPinningTests.swift:88`). It must still reject userinfo/path/query and non-`wss` for non-private hosts.

- [ ] **Step 1: Write the failing test (iOS owner)** — `PairingInfoTests`: a QR with `ip=hub.example.com&h1port=443&h1fp=sha256:…` parses; a typed PIN with the same host parses but keeps no pin (`HostApiPinning` refuses with `pin_missing`); `ip=hub.example.com/evil` fails.
- [ ] **Step 2: Run it** — `cd ios_app/SharedProtocol && swift test --filter PairingInfoTests` → FAIL today (public DNS refused).
- [ ] **Step 3: Minimal implementation (iOS owner)** — add a `publicHostAllowed` flag derived from the QR + a valid `h1fp`, keep the private-name rule for typed entry, and add the hub name to the reject tests. **This task is blocked until the user lifts the `ios_app/**` freeze.**
- [ ] **Step 4: Run it** — `swift test` green; pair a real iPhone against the hub; project picker shows role-gated projects.
- [ ] **Step 5: Commit (iOS owner)** — `feat(ios): pair with a public hub host when the QR carries its certificate pin`.

**If D2 = Tailscale/private:** replace P4.6 with a manual check only: the hub is reachable at `hub.<tailnet>.ts.net`, the desktop QR uses that name, the phone pairs and lists projects. Record the check in `USER-NEEDS.md`; no `ios_app` change.

**Phase 4 exit:** hub Host API via nginx; PIN answer has URL + pin; web pairs and scopes by project; sync refused on a hub; iPhone path decided and either verified or handed off; API 129 documented; `make contract-gates` + `web` tests + `make host-api-check` green.

---

## Phase 5 — operations: updates, backups, logs, health, revoke, uninstall, docs

**Outcome:** the hub is operable for a year, not just installable for a day. The same Settings card can update it safely, take a backup, show health/logs, revoke devices, and remove it without taking the data by surprise.

### Task P5.1 — Atomic hub updates with a health gate and rollback

**Why.** A hub update must not require SSH knowledge or a maintenance window; a bad release must return to the previous one automatically, and the client API must stay compatible.

**Files.**
- Modify `remote_deploy.rs` (`remote_update_plan`, `remote_update_run`, `remote_update_rollback`), `RemoteDeployCard.tsx`, `ServerSection.tsx` (Updates row when remote).
- Modify `deploy/hub/llmide-deploy` (`update` stage: predeploy-backup, unpack new version, `nginx -t`, switch, restart, health, rollback on failure; keep 3 releases).
- Modify `desktop/scripts/stage-hub-core.mjs` (version manifest), `CHANGELOG.md`.
- Test `remote_deploy.rs` (`update_failure_restores_previous`, `update_keeps_three_releases`).

**Interfaces.** `remote_update_plan(profile) -> { current, target, notes, blockers }`; `remote_update_run(plan_id, confirmation) -> DeployReport`; the update uses the same `llmide-deploy update` stage and the same health gate as P2.6. The app's version is the target; the bundle is built by `stage-hub-core.mjs`. Only a release whose `SHA256SUMS` verifies is unpacked. The hub's `/health.apiVersion` must be ≥ the client's floor; the desktop refuses to update a hub older than 129 when it needs 129 features.

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn a_bad_update_returns_to_the_previous_release() {
    let mut fs = FakeRemoteFs::new();
    fs.install("1.2.3");
    fs.install("1.2.4");
    fs.set_health("1.2.4", false);
    let r = update_run(&mut fs, "1.2.4", Duration::from_millis(10)).unwrap_err();
    assert_eq!(r.code, "HEALTH_TIMEOUT");
    assert_eq!(fs.current(), "1.2.3");
    assert!(fs.releases().len() <= 3);
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd desktop/src-tauri && CARGO_INCREMENTAL=0 cargo test --lib remote_deploy::tests::a_bad_update_returns_to_the_previous_release -- --exact`
Expected: FAIL.

- [ ] **Step 3: Write the minimal implementation**

Refactor the P2.6 stage runner into `run_stages(fs, plan)` shared by deploy and update; the update adds `update` (which implies predeploy-backup + bundle + switch + restart + health + rollback). The UI shows current/target, the changelog link, and "Update" with the typed-domain confirmation. Downloads are not used: the bundle is built from the installed desktop app (same version), so the hub and desktop cannot drift. Prune releases after a successful switch, keeping `current`, `previous` and one older.

- [ ] **Step 4: Run it to verify it passes**

Run the cargo test; update the scratch hub twice; force a bad bundle (corrupt tar) and confirm rollback + a redacted journal tail.

- [ ] **Step 5: Commit**

```
feat(remote): update a hub atomically with a health gate and rollback
```

### Task P5.2 — Scheduled backups, backup-now, and a pre-deploy snapshot

**Why.** The hub is the only copy of the team's data. `LLMIDE_BACKUP_KEEP=7` and a daily timer are table stakes; the deploy must also snapshot an existing DB before touching it.

**Files.**
- Create `deploy/hub/llmide-backup.service` (oneshot), `deploy/hub/backup-db.mjs` (better-sqlite3 `VACUUM INTO`; no CLI dependency). No timer: the core's scheduler is the daily clock.
- Modify `deploy/hub/llmide-deploy` (`base` installs units; `backup` stage; `predeploy-backup` uses `backup-db.mjs`).
- Modify `remote_deploy.rs` (`remote_backup_now`, diagnostics row), `RemoteDeployCard.tsx`.
- Test `deploy/hub/backup-db.test.mjs` (Node, temp DB) and `remote_deploy.rs` (`backup_now_uses_a_fixed_unit`).

**Interfaces.** `remote_backup_now() -> { file: String, bytes: u64, at: i64 }` runs `sudo -n systemctl start llmide-backup.service`, waits for it, then reads the newest `data-*.db` via a fixed `ls -t` probe. The **core's own scheduler** is the daily clock (`LLMIDE_BACKUP_INTERVAL_HOURS` stays default, `LLMIDE_BACKUP_KEEP=7` from P2.3); the unit is a `oneshot` for backup-now only, so there is exactly one daily schedule and no duplicate. The `backup` stage runs `node backup-db.mjs` for the on-demand copy. Test asserts `LLMIDE_BACKUP_INTERVAL_HOURS` is not `0` (the core runs daily), `LLMIDE_BACKUP_KEEP=7`, and no `llmide-backup.timer` is installed.

- [ ] **Step 1: Write the failing test**

```js
test("backup-db writes a consistent snapshot and never overwrites one", () => {
  const dir = mkdtempSync(join(tmpdir(), "llmide-backup-"));
  const db = new Database(join(dir, "data.db"));
  db.exec("create table t(x); insert into t values (1)");
  db.close();
  const a = backupDb({ dbPath: join(dir, "data.db"), outDir: join(dir, "backups"), now: 1000 });
  const b = backupDb({ dbPath: join(dir, "data.db"), outDir: join(dir, "backups"), now: 1000 });
  assert.notEqual(a, b, "same-second names must not collide");
  assert.equal(new Database(a, { readonly: true }).prepare("select count(*) c from t").get().c, 1);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd desktop && node --test --experimental-strip-types ../deploy/hub/backup-db.test.mjs`
Expected: FAIL (script missing).

- [ ] **Step 3: Write the minimal implementation**

`backup-db.mjs` opens read-only, `VACUUM INTO` a temp name (pid + monotonic suffix), fsyncs, renames, chmod 0600, and prunes older stamps beyond `KEEP`. The helper's `backup` stage runs it as `llmide` with `LLMIDE_DB_PATH`. `predeploy-backup` stops the service, runs it, starts again, and aborts the deploy if it fails. `remote_backup_now` runs the fixed `backup` stage (not a shell command from the UI). Off-host copy stays the existing `scripts/backup-offhost.sh` runbook (P5.5), not part of v1 automation.

- [ ] **Step 4: Run it to verify it passes**

Run the node test; on the hub `Settings → Backup now` produces a new file 0600; the deploy of an existing hub creates `predeploy-*.db` before the switch.

- [ ] **Step 5: Commit**

```
feat(hub): one daily backup schedule, a backup-now stage and a pre-deploy snapshot
```

### Task P5.3 — Health, logs and diagnostics that never leak secrets

**Why.** A remote user cannot `journalctl` or `df` without SSH; the Settings card must answer "is it healthy, what changed, how full is the disk, when does the cert expire" without exposing the env file or prompts.

**Files.**
- Modify `remote_deploy.rs` (`remote_diagnostics`, `remote_logs`), `RemoteDeployCard.tsx` (diagnostics panel), `ui/screens/settings/components-model.ts` (log text).
- Create `deploy/hub/diagnostics.sh` (fixed read-only probes; prints `LLMIDE_DIAG <json>`).
- Test `remote_deploy.rs` (`logs_are_bounded_and_redacted`, `diagnostics_reports_cert_days`).

**Interfaces.**
```rust
#[tauri::command] pub async fn remote_diagnostics(target: SshTarget) -> Result<RemoteDiagnostics, String>;
#[tauri::command] pub async fn remote_logs(target: SshTarget, lines: u16) -> Result<String, String>;
pub struct RemoteDiagnostics { pub service: String, pub health: Option<HealthSummary>, pub disk_free_mb: u64, pub cert_days: Option<i64>, pub last_backup: Option<i64>, pub version: Option<String>, pub api_version: Option<u32>, pub warnings: Vec<String> }
```
`lines` is clamped to 1..=2000; the helper runs `journalctl -u llmide-core -n <n> --no-pager -o short-iso`. Before returning, Rust redacts `LLMIDE_JWT_SECRET=…`, `LLMIDE_VAULT_KEY=…`, `Bearer …`, `sk-ant-…`, and any line that contains the deploy's known secret values (held only in memory during the deploy and never persisted in the host). The panel shows the last 200 lines with a Copy button, a "Refresh" and no auto-poll (the existing log viewer pattern).

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn logs_are_bounded_and_redacted() {
    assert_eq!(clamp_lines(0), 1);
    assert_eq!(clamp_lines(5000), 2000);
    let raw = "ok\nLLMIDE_VAULT_KEY=abcdef\nAuthorization: Bearer abc.def\nsk-ant-123\n";
    let out = redact_logs(raw, &["abcdef".into()]);
    assert!(!out.contains("abcdef"));
    assert!(!out.contains("abc.def"));
    assert!(!out.contains("sk-ant-123"));
    assert!(out.contains("ok"));
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd desktop/src-tauri && CARGO_INCREMENTAL=0 cargo test --lib remote_deploy::tests::logs_are_bounded_and_redacted -- --exact`
Expected: FAIL.

- [ ] **Step 3: Write the minimal implementation**

`diagnostics.sh` runs only fixed commands: `systemctl is-active`, `systemctl show -p ActiveEnterTimestamp`, `df -Pk /var/lib/llmide`, `curl -fsS http://127.0.0.1:3457/health`, `openssl x509 -enddate`, `ls -t /var/lib/llmide/backups/data-*.db | head -1`, `cat /opt/llmide/current/VERSION`. It never cats the env file or the DB. The Rust side parses to JSON, computes `cert_days`, and warns below 14 days, disk below 2 GB, backup older than 48 h, or service not active. The UI shows warnings first.

- [ ] **Step 4: Run it to verify it passes**

Run the cargo test; on the hub the panel shows health, version, API, disk, cert days, last backup; a log with a fake secret is redacted.

- [ ] **Step 5: Commit**

```
feat(remote): bounded, redacted logs and one health/diagnostics view for the hub
```

### Task P5.4 — Revoke a device or every session; uninstall without losing data by default

**Why.** Losing a phone must be one click; removing the hub must not silently delete the team's data, and the SSH key must not stay authorized after uninstall.

**Files.**
- Modify `ui/screens/settings/sections/HostApiPairing.tsx`/`SyncDevices.tsx` (hub pairing device list uses the hub routes), `ui/screens/settings/remote-model.ts`.
- Modify `remote_deploy.rs` (`remote_revoke_key`, `remote_uninstall`, `remote_uninstall_purge`), `RemoteDeployCard.tsx` (two-step destructive dialog), `deploy/hub/llmide-deploy` (`revoke-key`, `uninstall`, `uninstall-purge`).
- Test `remote_deploy.rs` (`uninstall_keeps_data_unless_purge_is_typed`, `revoke_key_removes_only_the_exact_line`).

**Interfaces.**
```rust
#[tauri::command] pub async fn remote_uninstall(plan_id: String, confirmation: String, purge: bool) -> Result<(), String>;
#[tauri::command] pub async fn remote_revoke_key(target: SshTarget) -> Result<(), String>;
```
Uninstall steps: stop/disable service; remove `/etc/systemd/system/llmide-core.service`, daemon-reload; remove the nginx site (keep the certificate; print `certbot delete --cert-name <domain>`); remove `/usr/local/sbin/llmide-deploy` and the sudoers file **last**; `revoke-key` removes the exact `authorized_keys` line for the generated public key (compare the base64 body, rewrite atomically, 0600). `purge` also removes `/opt/llmide` and `/var/lib/llmide`, and only runs when the user types the domain and checks "delete the hub database". The UI names what stays (the DB by default) and what goes (the service, vhost, helper, key).

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn uninstall_keeps_the_data_unless_purge_is_typed() {
    let mut fs = FakeRemoteFs::new();
    fs.install("1.2.4");
    uninstall(&mut fs, "hub.example.com", false).unwrap();
    assert!(fs.path_exists("/var/lib/llmide/data.db"), "data must survive a normal uninstall");
    assert!(!fs.path_exists("/usr/local/sbin/llmide-deploy"));
    let err = uninstall(&mut fs, "wrong.example.com", true).unwrap_err();
    assert_eq!(err.code, "CONFIRMATION_MISMATCH");
    assert!(fs.path_exists("/var/lib/llmide/data.db"));
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd desktop/src-tauri && CARGO_INCREMENTAL=0 cargo test --lib remote_deploy::tests::uninstall_keeps_the_data_unless_purge_is_typed -- --exact`
Expected: FAIL.

- [ ] **Step 3: Write the minimal implementation**

`revoke-key` is a stage that reads the staged public-key body (from `/etc/llmide/authorized-key.pub`, 0600) and removes matching lines from the login user's `~/.ssh/authorized_keys` (atomic rewrite). Device revocation for the hub uses the existing `DELETE /host-api/devices/:id` through the proxy (the hub member is authorized by B2; if B2 has not landed, this is blocked). "Revoke all" calls the existing `POST /auth/logout-all` if present; if not, revoke each device and sign out locally. Uninstall is a two-step dialog, not a single button; the purge field is checked in Rust, not only in the DOM.

- [ ] **Step 4: Run it to verify it passes**

Run the cargo test; uninstall the scratch hub: service gone, vhost gone, helper gone, `data.db` still there; purge with the wrong string refuses; purge with the domain removes the data; the phone can no longer pair.

- [ ] **Step 5: Commit**

```
feat(remote): revoke devices and keys, and uninstall without deleting data by surprise
```

### Task P5.5 — Docs, runbook, rollout note and the master-plan row

**Why.** A feature that only exists in code is not operable. The user needs one page that explains the two modes, the deploy, the pin, the hub's limits, and how to get back.

**Files.**
- Create `docs/how-to/run-a-hub.md` (the operator page: two modes, deploy, TLS pin, owner window, first project, web/phone pairing, updates, backups, logs, revoke, uninstall, offline fallback, limits).
- Modify `docs/how-to/configure-remote-server.md` (phase 1 is landed; replace its per-user systemd/launchd + `ssh -N -L` Phase-2 sketch with the hub deploy, and correct "Node 20+" to the bundled Node 22.23.4), `docs/reference/env-vars.md` (all new `LLMIDE_*`), `deploy/vps/README.md` (link the plan/runbook; note the hub replaces the dormant core unit), `docs/how-to/desktop-release.md` (Settings → Server mode in the checklist), `docs/explanation/architecture.md` (two deployment shapes), `docs/how-to/project-roles.md` (hub project picker), `docs/explanation/invariants.md` (mode never spawns in remote; sync local-only), `docs/superpowers/MASTER-PLAN.md` (row), `CHANGELOG.md`.
- Modify `agent-coord/requests.md`, `BOARD.md` (P5.5 closes the request).
- Test `make docs-check`; a link checker; `mkdocs build` if available.

**Interfaces.** The page is written for a non-expert: numbered steps, the exact commands, the screens, and "what can go wrong" (DNS, sudo password, cert renewal, phone hostname policy, local-only screens). It repeats the **two hostnames** decision if the user chooses a public hub + public PWA vs one hostname with `/app/`.

- [ ] **Step 1: Write the failing test**

```bash
# The docs gate must fail while the page does not exist.
test -f docs/how-to/run-a-hub.md || { echo "missing run-a-hub.md"; exit 1; }
grep -q "LLMIDE_HOST_API_HUB" docs/reference/env-vars.md || { echo "env var missing"; exit 1; }
make docs-check
```

- [ ] **Step 2: Run it to verify it fails**

Run: `make docs-check` and the two `grep`s. Expected: FAIL (page/env row missing).

- [ ] **Step 3: Write the minimal implementation**

Write the page from the plan's Phase 2/3/4/5 sections, using the exact stage names, ports (3457 core, 3016 Host API, 443 nginx), paths, and commands. Add the env rows in the generated table format (the file is generated from `core/config.mjs`; run `python3 docs/_scripts/extract_env_vars.py` and commit the regenerated table). Add a `MASTER-PLAN` row and a `CHANGELOG` entry under the current unreleased section. Do not claim a real-hardware verification that was not run; label the scratch-VM results by date.

- [ ] **Step 4: Run it to verify it passes**

Run `make docs-check`, `make regression`, and open every new link locally. Expected: PASS.

- [ ] **Step 5: Commit**

```
docs(hub): the two server modes, the deploy, and the operator runbook
```

**Phase 5 exit:** update/rollback, backup, diagnostics, revoke and uninstall are usable from Settings; the docs page and env table are current; `make docs-check` and `make regression` green.

---

## Task count, order and push boundaries

| Phase | Tasks | Count | Push after |
|---|---|---|---|
| 1 — connection/key/SSH test | P1.1–P1.4 | 4 (2 landed, 2 new) | P1.4, after `cargo test --lib` + `desktop && npm test` |
| 2 — deploy | P2.1–P2.6 | 6 | P2.6, after a scratch-VM deploy; `make test-desktop-node` |
| 3 — desktop remote client | P3.1–P3.8 | 8 | P3.8, after `make test-desktop-node` + `cargo test --lib` |
| 4 — web/iPhone hub pairing | P4.1–P4.6 | 6 (P4.6 gated) | P4.5, after `make contract-gates` + web tests; P4.6 separately |
| 5 — operations/docs | P5.1–P5.5 | 5 | P5.5, after `make regression` + CI |
| **Total** | | **29** | **27 remaining** |

Stop for review at: after P1.4 (the SSH trust boundary), after P2.6 (the first real deploy), after P3.2 (the pin), after P4.1 (the listener), and after P4.6 if it is taken. The user's decisions D1–D11 are gates, not suggestions; the coder must not choose one silently.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| A wrong host key is trusted on first use (TOFU) | The UI shows the fingerprint and the exact `ssh-keygen -lf` command to compare on the server console; the deploy is disabled until the user ticks the confirmation. A changed key fails closed (P1.3). |
| A Certbot renewal rotates the leaf key and every desktop/phone pin breaks | `--key-type ecdsa --reuse-key`; the pin file is rewritten by the deploy hook; a rotated key shows the new fingerprint and requires explicit re-trust; the runbook documents the renewal check. |
| nginx exposes more than intended (an `/api` alias, a public 3457/3016, `/metrics`) | The vhost golden test forbids `/api`; `check-hub.sh` asserts 3457/3016 are loopback-only; `/metrics` is 404; `nginx -t` before every reload with a restore on failure. |
| A bad hub release leaves the team offline | The health gate + previous symlink rollback (P2.6/P5.1); the pre-deploy DB backup; the user keeps the local mode and can switch back. |
| Remote mode silently spawns a local core or writes a second DB | P3.1's test asserts the launcher is never called; `verified_url` is `None`; the chat archive binding is disabled; the offline fallback is an explicit restart. |
| A member registers `/etc` (or any server folder) as a project on the hub | `LLMIDE_PROJECTS_ROOT` confinement + `PROJECT_ROOT_NOT_ALLOWED`; a hub `POST /kb/projects/register { id, name }` derives the folder and `mkdir`s 0700 under the root (P2.3/P3.6); a local install is unchanged. |
| The webview is widened to a non-loopback URL | The proxy keeps the base URL loopback; `isLoopbackUrl` is unchanged; the CSP keeps 3456-3459; the proxy token is 32 bytes and loopback-only. |
| The hub refresh token is replayed to a re-pointed host | The keychain entry is bound to the exact hub URL + TLS pin; a mismatch clears it (P3.4). |
| A deploy secret leaks through argv, a log or an event | Secrets are generated in Rust and sent only over SSH stdin; the helper writes 0600; the event logger accepts stage/status only; the test asserts argv has no secret (P2.3). |
| A root helper becomes a general root shell | One fixed helper, enum stages, exact sudoers lines, no wildcard, no `eval`/`$@`, `sh -n` + a Rust test (P2.2/P2.5). |
| Remote mode hides a feature the user needs | The Home screen lists what is local-only and why; "Work offline" is one click away; the runbook names the screens (P3.7/P3.8). |
| A hub is a single host with no failover | The hub is user-owned infrastructure (ADR 0020/0021); the runbook documents the backup restore and the offline local path; no HA claim is made. |
| The iPhone cannot reach a public hub | D2 decides: Tailscale/private name (no app change) or one `PairingInfo` change by the iOS owner (P4.6). The limitation is documented, not hidden. |
| The first owner window is left open | The deploy is not "done" until `lock-registration` verifies `/auth/well-known` says closed; `check-hub.sh` includes it; the UI shows a red "Registration is still open" row. |
| A `linux-arm64` VPS is refused | P2.1 blocks it with `arch_unsupported` and the exact follow-up (add the Node arm64 pin + a stage target); x86_64 is the v1 promise. |
| The hub bundle drifts from the desktop app | The hub bundle is built from the installed desktop app's version (`stage-hub-core.mjs`); update refuses a version mismatch; `/health.version` is compared. |

## Requirement coverage (the brief → tasks)

| Requirement | Tasks |
|---|---|
| Settings Server mode + `remote_ssh_test` (landed, uncommitted) | P1.1, P1.2 |
| Connection/key storage, host-key fingerprint | P1.3, P1.4 |
| Deploy: Node 22 check, service user, `/opt/llmide`, `/var/lib/llmide`, systemd, env file | P2.1, P2.3, P2.4 |
| nginx/TLS, health check, rollback/backup, no secrets in argv/logs, explicit confirmation | P2.2, P2.5, P2.6, P5.2 |
| Desktop remote-core: connect, TLS pin, auth/pairing, project list, no local spawn, mode switch, offline fallback | P3.1–P3.8 |
| Web + iPhone hub pairing per project roles, remote project picker, `projectId`, MEGA local-only | P4.1–P4.6 |
| Operations: updates, backups, logs, health, revoke, uninstall, docs, diagnostics | P5.1–P5.5 |
| Security: keychain, host-key confirm, TLS required, no `/api`, least-privilege sudo, no shell injection, auth boundaries | Global constraints, P1.3, P1.4, P2.2, P2.5, P3.2–P3.4, P4.1 |
| Tests per task, gates, rollout/migration, risks, user decisions | Each task, "Testing gates", "Rollout and migration", "Risks", D1–D11 |

## Self-review (run before handing this plan to a coder)

- **Spec coverage:** every bullet in the user brief maps to a task in the table above. The only deliberate gap is the iOS public-host change (P4.6), which is blocked on D2 and the `ios_app/**` freeze.
- **Placeholder scan:** no placeholder markers, no "handle errors", no "similar to Task N". Each task names the exact file, the failing test, the expected failure, the minimal behavior, and the commit message.
- **Type consistency:** `ServerMode` is `local | remote` everywhere; `CoreTrust` gains `remote_pinned` (shell) / `remote-pinned` (Settings); `CoreStatus.mode` is the same string; `SshTarget`/`RemoteServerConfig` fields are `host/port/user/keyPath` in Rust (serde camelCase for the UI) and TypeScript; `remote_server` is the one prefs block (mode/host/port/user/keyPath/label, plus `knownHost` (P1.3), `hubUrl` (P2.6) and `tlsPin` (P3.2)); `DeployPlan.id`/`confirmation` are the only inputs to `remote_deploy_run`; `RemoteProject.id` is the same `projectId` the Hub API returns; `HostApiPairingOffer`/`h1fp` keep their existing shape.
- **Anchor check:** line numbers were read on `main` at `86e1bae8`; the Phase-1 in-flight commit will move `ServerSection.tsx` and `prefs.rs`, so the coder re-reads those two files before editing (the plan's task text says so).
- **Scope check:** this is one subsystem (the server mode) with five phases that each produce working software. It does not add a second service, a deploy endpoint on the hub, or a new auth scheme.

---

*Plan authored 2026-11-08 by the planner/reviewer session. No code was changed in this pass; the only files written are this plan and the three coordination docs named in REQ-017.*


