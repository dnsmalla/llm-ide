# Agent Git Capability — Design

**Status:** approved design (2026-06-24)
**Goal:** Let the in-app Code Assistant act on the active repository's git working tree — so a user can ask it to commit, branch, push, merge, revert, etc. — through a safe **propose → confirm → execute** flow that **never touches `main` directly**. Today the agent has no git tool and correctly refuses such requests.

---

## 1. Overview

The agent (server-side) **proposes** a git operation as a `pendingTool`; the **Mac app confirms** it; the Mac **`RepoManager` executes** it on the active project's working tree; the result is fed back as a follow-up turn so the agent can report/continue. This reuses the exact pattern already used by `create-gitlab-issue` and `update-file`.

Two hard invariants:
1. **The server never runs working-tree git.** It is multi-user and has no checkout; its only git use stays `agents/github-pr.mjs` (a controlled clone). Working-tree git runs only on the Mac, via the existing `RepoManager` `git(args, cwd:, token:)` wrapper.
2. **Branch-first, protected `main`.** No commit or push ever lands on the default branch (`main`/`master`) except through an explicit, separately-confirmed merge step. (§4.)

---

## 2. Architecture / data flow

```
User asks (e.g. "revert the caption change", "merge feature X")
        │
        ▼
Global agent (server) emits a `git-op` tool fence
        │  loop.mjs validateArgs(skill.schema, …) — allow-list enforced
        ▼
runAgentLoop returns pendingTool { name: 'git-op', arguments: { op, args } }   ← server does NOT execute
        │
        ▼
Mac app receives pendingTool → PendingTool.gitOpArgs
        │   read op  → auto-run (no sheet)
        │   write op → GitOpSheet confirm (shows exact `git …`)
        │   destructive → GitOpSheet with prominent warning
        ▼
RepoManager.runGitOp(op:args:at: activeRepoURL)   ← branch-first policy ENFORCED here
        │   maps the allow-listed op → guarded git(args, cwd:) calls
        ▼
Result (stdout / exit / stderr) appended as a synthetic user turn → sendFollowup() → agent summarizes
```

---

## 3. Operation allow-list (no raw git)

`op` is a closed enum, validated by the server schema and re-checked by `RepoManager`. Three tiers:

- **read** (auto-run, no confirm): `status`, `log`, `diff`, `branch` (list).
- **safe-write** (confirm sheet): `add`, `commit`, `create_branch`, `checkout` (existing branch), `pull_ff` (`pull --ff-only`), `push` (current branch).
- **destructive** (confirm sheet + prominent warning): `merge`, `revert`, `reset`, `stash`, `clean`, and `merge_to_main` (the explicit integration step, §4).

Anything outside the enum is rejected at the schema boundary. Args are passed as **argv**, never a shell string; paths/refs are guarded with `--` exactly as the existing `RepoManager` clone path does.

---

## 4. Branch-first, protected-`main` policy (core safety rule)

Enforced **in `RepoManager.runGitOp` (hard, authoritative)** and reinforced **in the agent prompt (soft, so the agent proposes the right flow)**:

- **`commit`** is allowed only on a **non-default** branch. If the working tree is on `main`/`master`, `runGitOp` **first auto-creates and checks out a new branch** `agent/<slug>` (slug from the op's short description), then commits there. It will not commit on the default branch.
- **`push`** pushes the **current (feature) branch** (`push --set-upstream origin <branch>`). A push whose target is the default branch is **refused** outside the explicit merge step.
- **Landing on `main` = `merge_to_main`**, a distinct destructive-tier op that is the *only* path allowed to reach `origin/main`. Default integration is **push branch + open PR/MR** (reusing the agent's existing create-MR/PR); `merge_to_main` (local `git merge` into the default branch + `push origin main`) is offered as an explicitly-confirmed alternative.
- The auto-created branch name is **shown in the confirm sheet** so the user can see/adjust it before anything runs.

Net effect: an ordinary commit/push can never surprise-overwrite `main`; a "revert" lands on a reviewable branch; a "merge" goes branch → PR/MR (or the explicit `merge_to_main`).

---

## 5. Components

### 5.1 Server — `git-op` tool (skill + schema)
- A new agent skill (markdown + frontmatter schema, the same mechanism as `create-gitlab-issue`/`update-file`) declaring the `git-op` tool: `{ op: <enum §3>, args: {...} }` with per-op arg shapes (e.g. `commit.message`, `create_branch.name`, `checkout.branch`, `merge.branch`, `revert.ref`, `reset.mode+ref`, `merge_to_main.branch`).
- Registered in `GLOBAL_HANDLED` so routing knows it; the global/internal agent prompt is updated to (a) emit `git-op` for git requests and (b) follow the branch-first flow (propose `create_branch`→`commit`→`push`→PR for changes; never propose a direct `main` push).
- The loop validates the fence against the schema and returns it as `pendingTool` — **no server execution**.

### 5.2 Mac — confirm + execute
- `PendingTool.gitOpArgs` — typed accessor decoding `{ op, args }` (mirrors `createIssueArgs`/`updateFileArgs`).
- `Views/.../GitOpSheet.swift` — a confirm sheet showing the **exact `git` command(s)**, the target branch, and a prominent warning band for destructive ops. Read ops skip the sheet (auto-run).
- `RepoManager.runGitOp(op:args:at: URL) async throws -> String` — maps each allow-listed op to guarded `git(args, cwd:)` calls and **enforces §4**. Reuses the existing token-injection + `.git/config` scrub for `push`/`pull`.
- Wiring in `CodeAssistantPanel` mirrors the `confirmUpdateFile`/`confirmCreateIssue` flow: execute → append synthetic result turn → `sendFollowup()`.

### 5.3 Scope/target
Always the **active project's** working tree (the repo the chat is bound to). Never an arbitrary path; if there is no active git repo, the op returns a clean "no active repository" error.

---

## 6. Error handling
- Git failures (merge conflict, non-fast-forward, dirty tree, detached HEAD) return **stderr into the synthetic turn**, so the agent explains and proposes next steps. Nothing is retried or force-resolved automatically.
- `RepoManager` already caps git with a timeout → surfaced as a clean timeout error.
- A blocked action (e.g. attempted commit/push on `main`) returns an explanatory error the agent relays ("I work on a branch — created `agent/…` instead"), never silently.

---

## 7. Security
- Closed op allow-list; schema rejects unknown ops; **argv, never shell** (no metachar injection); refs/paths guarded with `--`.
- Protected `main`: only `merge_to_main` may reach `origin/main`, and only via an explicit destructive-tier confirm.
- No `--force` push, no `reset --hard`/`clean -fdx` without the destructive-tier confirm naming exactly what is lost.
- Push auth uses the existing per-backend token path (already scrubs secrets from `.git/config`).

---

## 8. Testing
- **Server (node `--test`):** `git-op` schema validation — valid ops/args pass; unknown op, raw-git string, missing required args rejected. Prompt/routing: `git-op` in `GLOBAL_HANDLED`.
- **Mac (`swift build`-verified; `swift test` blocked by the toolchain skew):** `RepoManager.runGitOp` op→argv mapping (pure, unit-testable) and the **branch-first policy** (on `main` + `commit` → creates `agent/…` first; `push` of default branch refused; only `merge_to_main` reaches `origin main`); the read/write/destructive **tier classification** that drives the sheet.

---

## 9. Build / CI
Spans both sides. Backend (extension: skill, schema, prompt, GLOBAL_HANDLED, tests) pushes cleanly via the node gate — do it **first**. Mac (PendingTool.gitOpArgs, GitOpSheet, RepoManager.runGitOp, panel wiring) is `swift build`-verified and pushes with `--no-verify` (swift test blocked).

---

## 10. Out of scope / future
- A compact **git-status snapshot in `agentContext`** so read questions need no round-trip (nice UX, bloats every request — deferred).
- **Raw `git <args>`** composition (rejected for safety; allow-list only).
- Multi-repo / non-active-repo targeting.
- Conflict *resolution* assistance (v1 surfaces the conflict; resolving is manual).
