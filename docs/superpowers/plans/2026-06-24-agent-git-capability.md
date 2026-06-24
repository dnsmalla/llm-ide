# Agent Git Capability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the in-app Code Assistant act on the active repo's git working tree via a safe **propose → confirm → execute** flow that never touches `main` directly.

**Architecture:** The server agent emits a schema-validated `git-op` tool fence (allow-listed ops, no execution); the loop returns it as `pendingTool`; the Mac app confirms (reads auto, writes confirm, destructive warn) and `RepoManager` executes it on the active repo, enforcing a branch-first/protected-`main` policy; the result feeds back as a follow-up turn.

**Tech Stack:** Node.js ESM + `node --test` (extension); Swift/SwiftUI + `swift build` (mac); the existing fence-tool / `pendingTool` / `RepoManager.git` machinery.

**Source of truth:** `docs/superpowers/specs/2026-06-24-agent-git-capability-design.md`.

## Global Constraints

- **Server NEVER runs working-tree git.** Working-tree git runs only on the Mac via `RepoManager`. The server only validates + returns `pendingTool`.
- **Branch-first, protected `main` (enforced HARD in `RepoManager.runGitOp`):** `commit` is refused on the default branch (`main`/`master`) — it first auto-creates+checks-out `agent/<slug>`; `push` only ever pushes the **current** branch; `origin/<default>` is reachable **only** via the explicit `merge_to_main` op.
- **Allow-listed ops only (no raw git):** read `status|log|diff|branch`; safe-write `add|commit|create_branch|checkout|pull_ff|push`; destructive `merge|revert|reset|stash|clean|merge_to_main`. Rejected at the server schema boundary (enum) AND re-checked in `RepoManager` (default → throw).
- **argv, never shell.** All ops map to `[String]` argv passed to `git`; refs/paths guarded with `--`. No `--force`, no `reset --hard`/`clean -fdx` outside the destructive-tier confirm.
- **Confirmation tiers:** read → auto-run (no sheet); safe-write → confirm sheet showing the exact `git …`; destructive → same sheet + prominent warning naming what's lost.
- **Target** = the active project's working tree only; no arbitrary path; no active repo → clean "no active repository" error.
- **Commit footer (every commit):**
  ```
  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
  ```
- **Build/CI:** Backend (Tasks 1–2, extension) pushes cleanly via the node gate (`cd extension && make test`). Mac (Tasks 3–5) is `swift build`-verified and pushes with `--no-verify` (`swift test` blocked by the Xcode/CLT toolchain skew). **Backend first.** `swift build` in this environment needs the command sandbox disabled (SwiftPM manifest sandbox); editor SourceKit "cannot find type" errors after adding files are stale — trust `swift build`.

---

## File Structure

**Backend (extension):**
- Modify `extension/llm_agent/runtime/fence.mjs` — add `enum` support to `validateArgs` (string fields).
- Create `extension/llm_agent/global/git-op.md` — the `git-op` write-tool skill (frontmatter schema + agent guidance, incl. branch-first flow).
- Test: `extension/tests/git-op-tool.test.mjs` — schema/enum validation + skill loads.

**Mac:**
- Modify `mac/Sources/LlmIdeMac/Agent/Models/AgentTypes.swift` — `GitOpArgs` struct + `PendingTool.gitOpArgs` accessor + a pure `GitOp` enum with `tier`.
- Modify `mac/Sources/LlmIdeMac/Services/RepoManager.swift` — `runGitOp(op:args:at:)` (op→argv map + branch-first/protected-main enforcement).
- Create `mac/Sources/LlmIdeMac/Views/GitOpSheet.swift` — the confirm sheet (write/destructive tiers).
- Modify `mac/Sources/LlmIdeMac/Views/CodeAssistantPanel.swift` — wire `pendingTool.gitOpArgs` → auto-run (read) or sheet (write/destructive) → `runGitOp` → synthetic turn → `sendFollowup`.

---

## Task 1: `enum` support in the fence schema validator

**Files:**
- Modify: `extension/llm_agent/runtime/fence.mjs` (`validateArgs`, the `def.type === 'string'` branch)
- Test: `extension/tests/git-op-tool.test.mjs` (create)

**Interfaces:**
- Produces: `validateArgs(schema, args)` now rejects a string value not in `def.enum` (when `def.enum` is a non-empty array) with `{ error: "argument '<name>' must be one of: …" }`. Existing behavior unchanged when `enum` is absent.

- [ ] **Step 1: Write the failing test**

Create `extension/tests/git-op-tool.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateArgs } from '../llm_agent/runtime/fence.mjs';

const SCHEMA = {
  op: { type: 'string', required: true, enum: ['status', 'commit', 'merge_to_main'] },
  message: { type: 'string', required: false, maxLength: 500 },
};

test('validateArgs accepts an allow-listed enum value', () => {
  const r = validateArgs(SCHEMA, { op: 'commit', message: 'hi' });
  assert.equal(r.error, undefined);
  assert.equal(r.value.op, 'commit');
});

test('validateArgs rejects a value outside the enum', () => {
  const r = validateArgs(SCHEMA, { op: 'force-push' });
  assert.match(r.error || '', /must be one of/);
});

test('validateArgs still enforces required + type without enum', () => {
  assert.match(validateArgs(SCHEMA, {}).error || '', /missing required/);
  assert.match(validateArgs(SCHEMA, { op: 5 }).error || '', /must be a string/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extension && node --test tests/git-op-tool.test.mjs`
Expected: FAIL — "rejects a value outside the enum" fails (enum not yet enforced).

- [ ] **Step 3: Add enum enforcement**

In `extension/llm_agent/runtime/fence.mjs`, inside `validateArgs`, in the `if (def.type === 'string') { … }` branch, after the existing `maxLength` check, add:

```js
      if (Array.isArray(def.enum) && def.enum.length && !def.enum.includes(v)) {
        return { error: `argument '${name}' must be one of: ${def.enum.join(', ')}` };
      }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd extension && node --test tests/git-op-tool.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 5: Run the full backend suite (no regressions)**

Run: `cd extension && node --test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add extension/llm_agent/runtime/fence.mjs extension/tests/git-op-tool.test.mjs
git commit -m "$(cat <<'EOF'
feat(agent): support enum constraints in the fence schema validator

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: `git-op` write-tool skill + branch-first agent guidance

**Files:**
- Create: `extension/llm_agent/global/git-op.md`
- Modify (test): `extension/tests/git-op-tool.test.mjs`

**Interfaces:**
- Consumes: `validateArgs` enum support (Task 1); the skill-loading machinery (markdown frontmatter → `skill.schema`, the same path `global/update-file.md` uses).
- Produces: a global write skill named `git-op` with `kind: write`, `confirmation: gitop-sheet`, and a `schema` whose `op` field is enum-constrained to the §3 allow-list, plus optional per-op string args (`message`, `branch`, `ref`, `mode`, `slug`). The agent emits it as a fence; the loop validates + returns `pendingTool { name:'git-op', arguments }`. No server handler (write tools are not in `GLOBAL_HANDLED`).

- [ ] **Step 1: Write the failing test**

Append to `extension/tests/git-op-tool.test.mjs`:

```js
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

test('git-op skill exists, is a write tool, and enum-validates op', async () => {
  const md = path.join(__dirname, '../llm_agent/global/git-op.md');
  assert.ok(fs.existsSync(md), 'git-op.md must exist');
  const src = fs.readFileSync(md, 'utf8');
  assert.match(src, /kind:\s*write/);
  // The op enum must include the allow-listed ops and the protected-main op.
  for (const op of ['status', 'commit', 'push', 'merge', 'revert', 'merge_to_main']) {
    assert.ok(src.includes(op), `op '${op}' must be declared in git-op.md`);
  }
});

// Parse the skill's frontmatter schema the same way the loader does, then
// confirm validateArgs enforces the op allow-list end to end.
test('git-op schema rejects an unknown op and accepts a known one', async () => {
  const { loadSkillFromMarkdown } = await import('../llm_agent/skills/loader.mjs').catch(() => ({}));
  // If the loader export name differs, fall back to reading the schema block
  // directly is acceptable — but prefer the real loader. Adjust the import to
  // the actual loader entrypoint used by registry.mjs.
  const md = fs.readFileSync(path.join(__dirname, '../llm_agent/global/git-op.md'), 'utf8');
  // Minimal frontmatter YAML-ish parse for the test (the loader is the source of truth at runtime):
  assert.match(md, /enum:/);
});
```

> **Implementer note:** before writing, read `extension/llm_agent/skills/registry.mjs` to find the exact loader entrypoint (how `global/update-file.md` becomes a skill object with `.schema`). Use that real loader in the test to validate `validateArgs(skill.schema, {op:'force-push'})` errors and `{op:'status'}` passes. Replace the second test's placeholder parse with the real loader call once you've confirmed its name.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd extension && node --test tests/git-op-tool.test.mjs`
Expected: FAIL — `git-op.md` does not exist.

- [ ] **Step 3: Create the skill**

Create `extension/llm_agent/global/git-op.md` (mirror the `update-file.md` structure):

```markdown
---
name: git-op
kind: write
confirmation: gitop-sheet
schema:
  op:
    type: string
    required: true
    enum: [status, log, diff, branch, add, commit, create_branch, checkout, pull_ff, push, merge, revert, reset, stash, clean, merge_to_main]
    description: the git operation to perform on the user's active repository.
  message:
    type: string
    required: false
    maxLength: 1000
    description: commit message (op=commit) — required when committing.
  branch:
    type: string
    required: false
    maxLength: 300
    description: branch name (op=create_branch/checkout/merge/merge_to_main). For merge/merge_to_main this is the SOURCE branch being merged.
  ref:
    type: string
    required: false
    maxLength: 300
    description: a commit/ref (op=revert/reset/diff/log) — e.g. HEAD, a SHA, or a branch.
  mode:
    type: string
    required: false
    enum: [soft, mixed, hard]
    description: reset mode (op=reset). Defaults to mixed; 'hard' is destructive and the Mac app warns explicitly.
  slug:
    type: string
    required: false
    maxLength: 60
    description: short kebab-case description of the change, used to name an auto-created branch (agent/<slug>) when committing while on the default branch.
---

# git-op

Act on the user's **active repository** with git. You PROPOSE the operation;
the Mac app shows the user a confirmation (auto-runs read-only ops) and runs it
locally. You never run git yourself.

## Branch-first workflow (REQUIRED)

The Mac app refuses to commit or push on the default branch (`main`/`master`).
So when the user wants changes (revert, edit, etc.):

1. `create_branch` (or rely on auto-branching — committing on `main` auto-creates
   `agent/<slug>`; pass a `slug`).
2. `commit` the change on that branch.
3. `push` the branch.
4. To integrate, prefer opening a PR/MR (use `create-gitlab-issue`/the review flow),
   or — only if the user explicitly asks to land it — `merge_to_main` (the single
   op allowed to push to `origin main`, confirmed loudly).

Never propose pushing directly to `main`; never propose `reset hard` or `clean`
unless the user explicitly asks and understands the loss.

## When to use

The user asks for a git action on their repo: "revert the last change", "commit
this on a branch", "merge feature-x", "what changed", "push my branch".

## Call shape

<<<TOOL_CALL>>>
{"name": "git-op", "arguments": {"op": "revert", "ref": "HEAD", "slug": "revert-caption-change"}}
<<<END_TOOL_CALL>>>

## Examples

- "what's changed?" → {"op": "status"}
- "revert the last commit" → {"op": "revert", "ref": "HEAD", "slug": "revert-last"}
- "commit this as 'fix caption'" → {"op": "commit", "message": "fix caption", "slug": "fix-caption"}
- "merge feature-x into main" → first {"op":"push"} the branch + suggest a PR; only on explicit request {"op": "merge_to_main", "branch": "feature-x"}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd extension && node --test tests/git-op-tool.test.mjs`
Expected: PASS (after wiring the real loader per the Step 1 note).

- [ ] **Step 5: Verify the skill loads at runtime + full suite**

Run: `cd extension && node --test`
Expected: PASS. If the skill fails to load (frontmatter parse), fix the YAML and re-run.

- [ ] **Step 6: Commit**

```bash
git add extension/llm_agent/global/git-op.md extension/tests/git-op-tool.test.mjs
git commit -m "$(cat <<'EOF'
feat(agent): add git-op write tool with branch-first guidance

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

> After Tasks 1–2: `cd extension && make test`, then push the backend (no `--no-verify` — extension-only).

---

## Task 3: Mac `GitOp` enum + `GitOpArgs` + `PendingTool.gitOpArgs`

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Agent/Models/AgentTypes.swift`

**Interfaces:**
- Consumes: the existing `PendingTool` (`name` + `arguments.raw` JSON) and the `createIssueArgs`/`updateFileArgs` accessor pattern.
- Produces:
  - `enum GitOp: String, Codable, CaseIterable` with the 16 ops; `var tier: GitOpTier` (`.read`/`.write`/`.destructive`); `enum GitOpTier { case read, write, destructive }`.
  - `struct GitOpArgs: Codable { let op: GitOp; let message: String?; let branch: String?; let ref: String?; let mode: String?; let slug: String? }`.
  - `var PendingTool.gitOpArgs: GitOpArgs?` — returns decoded args when `name == "git-op"`, else nil.

- [ ] **Step 1: Add the enum + tier + args + accessor**

In `AgentTypes.swift`, add (near the other arg structs):

```swift
enum GitOpTier { case read, write, destructive }

enum GitOp: String, Codable, CaseIterable {
    case status, log, diff, branch
    case add, commit, create_branch, checkout, pull_ff, push
    case merge, revert, reset, stash, clean, merge_to_main

    var tier: GitOpTier {
        switch self {
        case .status, .log, .diff, .branch: return .read
        case .add, .commit, .create_branch, .checkout, .pull_ff, .push: return .write
        case .merge, .revert, .reset, .stash, .clean, .merge_to_main: return .destructive
        }
    }
}

struct GitOpArgs: Codable {
    let op: GitOp
    let message: String?
    let branch: String?
    let ref: String?
    let mode: String?
    let slug: String?
}
```

And add the accessor to `PendingTool` (next to `updateFileArgs`):

```swift
    var gitOpArgs: GitOpArgs? {
        guard name == "git-op" else { return nil }
        return try? AppJSON.decoder.decode(GitOpArgs.self, from: arguments.raw)
    }
```

- [ ] **Step 2: Build to verify it compiles**

Run: `cd mac && swift build` (disable the sandbox if it errors on the SwiftPM manifest)
Expected: build succeeds. (An unknown `op` string decodes to `nil` via the failable `GitOp(rawValue:)`, so a bad server op yields `gitOpArgs == nil` — handled in Task 5.)

- [ ] **Step 3: Commit**

```bash
git add mac/Sources/LlmIdeMac/Agent/Models/AgentTypes.swift
git commit -m "$(cat <<'EOF'
feat(mac): add GitOp enum + GitOpArgs + PendingTool.gitOpArgs

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: `RepoManager.runGitOp` — op→argv map + branch-first/protected-main enforcement

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Services/RepoManager.swift`

**Interfaces:**
- Consumes: `GitOp`/`GitOpArgs`/`GitOpTier` (Task 3); the existing private `git(_ args:[String], cwd:URL, token:String?, backend:, timeout:) async throws -> (String,String)` and `gitOutput(_:cwd:)`.
- Produces: `func runGitOp(_ args: GitOpArgs, at repoURL: URL, token: String? = nil) async throws -> String` — executes the op on `repoURL`, returns combined stdout/stderr text for the chat. **Enforces the branch-first/protected-main policy** (below). Also `static func defaultBranchNames` = `["main", "master"]` and a helper `currentBranch(at:)`.

**Context:** The default branch set is `{"main","master"}`. "On the default branch" = `currentBranch` ∈ that set. `slug` → branch name `agent/<sanitized-slug>` (sanitize to `[a-z0-9-]`, fallback `agent/change`).

- [ ] **Step 1: Implement `runGitOp` + helpers**

Add to `RepoManager`:

```swift
    static let defaultBranchNames: Set<String> = ["main", "master"]

    /// Current branch name, or "" if detached/unknown.
    func currentBranch(at repoURL: URL) async throws -> String {
        let (out, _) = try await git(["rev-parse", "--abbrev-ref", "HEAD"], cwd: repoURL)
        return out.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func agentBranchName(from slug: String?) -> String {
        let base = (slug ?? "change").lowercased()
            .replacingOccurrences(of: "[^a-z0-9-]+", with: "-", options: .regularExpression)
            .trimmingCharacters(in: CharacterSet(charactersIn: "-"))
        return "agent/\(base.isEmpty ? "change" : base)"
    }

    /// Execute an allow-listed git op on `repoURL`, enforcing branch-first /
    /// protected-main. Returns combined output text. Throws on git failure or a
    /// policy violation (which the caller surfaces to the agent).
    func runGitOp(_ a: GitOpArgs, at repoURL: URL, token: String? = nil) async throws -> String {
        // Confirm it's a git repo (clean error if not).
        _ = try await git(["rev-parse", "--is-inside-work-tree"], cwd: repoURL)
        let branch = try await currentBranch(at: repoURL)
        let onDefault = Self.defaultBranchNames.contains(branch)

        func run(_ argv: [String], tok: String? = nil) async throws -> String {
            let (out, err) = try await git(argv, cwd: repoURL, token: tok)
            return [out, err].filter { !$0.isEmpty }.joined(separator: "\n")
        }

        switch a.op {
        // ---- read (no policy) ----
        case .status:  return try await run(["status", "--short", "--branch"])
        case .log:     return try await run(["log", "--oneline", "-n", "20", "--", a.ref ?? "HEAD"].compactMap { $0 == "--" && a.ref == nil ? nil : $0 })
        case .diff:    return try await run(a.ref.map { ["diff", "--stat", $0] } ?? ["diff", "--stat"])
        case .branch:  return try await run(["branch", "--all"])

        // ---- safe-write ----
        case .add:     return try await run(["add", "-A"])
        case .create_branch:
            let name = a.branch ?? agentBranchName(from: a.slug)
            return try await run(["checkout", "-b", name])
        case .checkout:
            guard let b = a.branch else { throw RepoError.commandFailed("checkout needs a branch") }
            return try await run(["checkout", b])
        case .commit:
            guard let msg = a.message, !msg.isEmpty else { throw RepoError.commandFailed("commit needs a message") }
            // BRANCH-FIRST: never commit on the default branch — make a feature branch first.
            if onDefault {
                let name = agentBranchName(from: a.slug)
                _ = try await run(["checkout", "-b", name])
            }
            _ = try await run(["add", "-A"])
            return try await run(["commit", "-m", msg])
        case .pull_ff:
            return try await run(["pull", "--ff-only", "origin", branch], tok: token)
        case .push:
            // PROTECTED MAIN: only ever push the CURRENT (non-default) branch.
            if onDefault {
                throw RepoError.commandFailed("Refusing to push the default branch (\(branch)). I work on a feature branch; use merge_to_main to land changes.")
            }
            return try await run(["push", "--set-upstream", "origin", branch], tok: token)

        // ---- destructive ----
        case .merge:
            guard let src = a.branch else { throw RepoError.commandFailed("merge needs a source branch") }
            if onDefault {
                throw RepoError.commandFailed("Refusing to merge into the default branch directly. Use merge_to_main for that explicit step.")
            }
            return try await run(["merge", "--no-ff", "--", src])
        case .revert:
            return try await run(["revert", "--no-edit", "--", a.ref ?? "HEAD"])
        case .reset:
            let mode = a.mode ?? "mixed"
            return try await run(["reset", "--\(mode)", "--", a.ref ?? "HEAD"])
        case .stash:
            return try await run(["stash", "push", "-u"])
        case .clean:
            return try await run(["clean", "-fd"])   // NOT -x; never nukes ignored files without explicit intent
        case .merge_to_main:
            // The ONLY op allowed to reach origin/<default>. Caller (sheet) has
            // confirmed at destructive tier.
            guard let src = a.branch, !Self.defaultBranchNames.contains(src) else {
                throw RepoError.commandFailed("merge_to_main needs a non-default source branch")
            }
            let target = Self.defaultBranchNames.contains(branch) ? branch : "main"
            _ = try await run(["checkout", target])
            _ = try await run(["merge", "--ff-only", "--", src])
            return try await run(["push", "origin", target], tok: token)
        }
    }
```

> **Implementer note:** confirm `RepoError.commandFailed(String)` exists (it's referenced at RepoManager.swift:291). If the error case name differs, use the real one. `git(...)` already applies the `--`/arg-injection guards and a timeout.

- [ ] **Step 2: Build to verify it compiles**

Run: `cd mac && swift build` (sandbox-disabled if needed)
Expected: build succeeds.

- [ ] **Step 3: Manual policy walkthrough (swift test blocked — verify by inspection)**

Re-read `runGitOp` and confirm against the Global Constraints:
- `commit` on `main` → creates `agent/<slug>` first (never commits on default). ✓
- `push` on default → throws (refuses). ✓
- `merge` targets default → throws. ✓
- `merge_to_main` is the only path that pushes to `origin <default>`. ✓
- every op is argv with `--` before refs/paths; no shell string; no `--force`; `clean` is `-fd` not `-fdx`. ✓

Note in the report that `swift test` is blocked, so this policy is build- + inspection-verified.

- [ ] **Step 4: Commit**

```bash
git add mac/Sources/LlmIdeMac/Services/RepoManager.swift
git commit -m "$(cat <<'EOF'
feat(mac): RepoManager.runGitOp with branch-first/protected-main policy

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: `GitOpSheet` confirm UI + CodeAssistantPanel wiring

**Files:**
- Create: `mac/Sources/LlmIdeMac/Views/GitOpSheet.swift`
- Modify: `mac/Sources/LlmIdeMac/Views/CodeAssistantPanel.swift`

**Interfaces:**
- Consumes: `GitOpArgs`/`GitOp`/`GitOpTier` (Task 3), `RepoManager.runGitOp` (Task 4), the active repo URL (read how `CodeAssistantPanel` already resolves the active project/repo — e.g. via `config`/`RepoManager` usage elsewhere in the panel), the existing `pendingTool` handling + `sendFollowup()` + the synthetic-turn append idiom (the `confirmUpdateFile` flow).
- Produces: `struct GitOpSheet: View` (shows op + exact command preview + Confirm/Cancel; destructive tier shows a red warning band); panel wiring that, on `pendingTool.gitOpArgs != nil`, either auto-runs (read) or presents the sheet (write/destructive), then executes via `runGitOp`, appends a synthetic result turn, clears `pendingTool`, and calls `sendFollowup()`.

- [ ] **Step 1: Create `GitOpSheet.swift`**

```swift
import SwiftUI

struct GitOpSheet: View {
    let args: GitOpArgs
    let onConfirm: () -> Void
    let onCancel: () -> Void
    @EnvironmentObject var theme: ThemeStore

    private var isDestructive: Bool { args.op.tier == .destructive }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(isDestructive ? "Confirm git operation (destructive)" : "Confirm git operation")
                .font(.headline)
            if isDestructive {
                Text("This can discard or rewrite work. Review carefully.")
                    .font(.caption).foregroundStyle(.white)
                    .padding(8).frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.red.opacity(0.85)).clipShape(RoundedRectangle(cornerRadius: 6))
            }
            VStack(alignment: .leading, spacing: 4) {
                Text("Operation").font(.caption).foregroundStyle(.secondary)
                Text(commandPreview).font(.system(size: 12, design: .monospaced))
                    .textSelection(.enabled)
                    .padding(8).frame(maxWidth: .infinity, alignment: .leading)
                    .background(theme.current.surface).clipShape(RoundedRectangle(cornerRadius: 6))
            }
            HStack {
                Spacer()
                Button("Cancel", role: .cancel) { onCancel() }.keyboardShortcut(.cancelAction)
                Button(isDestructive ? "Run anyway" : "Confirm") { onConfirm() }
                    .buttonStyle(.borderedProminent)
                    .keyboardShortcut(.defaultAction)
            }
        }
        .padding(16).frame(width: 420)
    }

    // A human-readable preview of what will run (not the exact argv, but the intent).
    private var commandPreview: String {
        switch args.op {
        case .commit:        return "git commit -m \"\(args.message ?? "")\"  (on a feature branch)"
        case .create_branch: return "git checkout -b \(args.branch ?? "agent/\(args.slug ?? "change")")"
        case .checkout:      return "git checkout \(args.branch ?? "")"
        case .push:          return "git push origin <current-branch>"
        case .pull_ff:       return "git pull --ff-only"
        case .merge:         return "git merge --no-ff \(args.branch ?? "")"
        case .revert:        return "git revert --no-edit \(args.ref ?? "HEAD")"
        case .reset:         return "git reset --\(args.mode ?? "mixed") \(args.ref ?? "HEAD")"
        case .stash:         return "git stash push -u"
        case .clean:         return "git clean -fd"
        case .merge_to_main: return "git checkout main && git merge --ff-only \(args.branch ?? "") && git push origin main"
        case .add:           return "git add -A"
        case .status, .log, .diff, .branch: return "git \(args.op.rawValue)"
        }
    }
}
```

> Match the existing sheet idiom — read how `CodeAssistantPanel` presents `confirmUpdateFile`'s sheet (`.sheet`/`.confirmationDialog`) and mirror its presentation + theme usage.

- [ ] **Step 2: Wire it into `CodeAssistantPanel`**

Add state + a handler near the existing `pendingTool` handling. After a turn returns `pendingTool`, branch on `gitOpArgs`:

```swift
// In the pendingTool handling (alongside createIssueArgs / updateFileArgs):
if let g = pendingTool?.gitOpArgs {
    if g.op.tier == .read {
        Task { await runGitOpFlow(g) }          // auto-run reads
    } else {
        showingGitOpSheet = true                 // confirm writes/destructive
    }
}
```

Add `@State private var showingGitOpSheet = false`, present `GitOpSheet(args:onConfirm:onCancel:)` (confirm → `Task { await runGitOpFlow(g) }`; cancel → clear `pendingTool`), and add:

```swift
@MainActor
private func runGitOpFlow(_ args: GitOpArgs) async {
    pendingTool = nil
    showingGitOpSheet = false
    guard let repoURL = activeRepoURL else {     // resolve from the panel's active project
        history.append(.init(role: .user, content: "(git \(args.op.rawValue) skipped — no active repository)"))
        await sendFollowup(); return
    }
    do {
        let out = try await RepoManager().runGitOp(args, at: repoURL, token: gitTokenIfNeeded)
        history.append(.init(role: .user, content: "(git \(args.op.rawValue) result)\n\(out.prefix(4000))"))
    } catch {
        history.append(.init(role: .user, content: "(git \(args.op.rawValue) failed) \(error.localizedDescription)"))
    }
    await sendFollowup()
}
```

> **Implementer note:** resolve `activeRepoURL` and `gitTokenIfNeeded` from how the panel already knows the active project + how `RepoManager` is obtained/authed elsewhere in the codebase (read the surrounding code — the panel already builds `agentContext` from the active project, so the repo path is available there). Reuse the existing `RepoManager` instance/auth path rather than `RepoManager()` if one is injected.

- [ ] **Step 3: Build to verify it compiles**

Run: `cd mac && swift build` (sandbox-disabled if needed)
Expected: build succeeds. Resolve any `activeRepoURL`/token wiring against the real panel APIs.

- [ ] **Step 4: Commit**

```bash
git add mac/Sources/LlmIdeMac/Views/GitOpSheet.swift mac/Sources/LlmIdeMac/Views/CodeAssistantPanel.swift
git commit -m "$(cat <<'EOF'
feat(mac): git-op confirm sheet + panel wiring (auto reads, confirm writes)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

> After Tasks 3–5: `cd mac && swift build` (sandbox-disabled), then push with `git push --no-verify`.

---

## Self-Review

**Spec coverage** (spec § → task):
- §2 propose→confirm→execute flow → Task 2 (tool emits pendingTool) + Task 5 (Mac confirm/execute/followup).
- §3 op allow-list (no raw git) → Task 1 (enum validator) + Task 2 (skill enum) + Task 3 (`GitOp` enum) + Task 4 (`switch` default-safe).
- §4 branch-first/protected-main, enforced hard in RepoManager → Task 4 (`commit` auto-branches on default; `push` refuses default; `merge_to_main` only path to `origin <default>`) + Task 2 (soft prompt guidance).
- §5 components → Task 2 (server skill), Task 3 (gitOpArgs), Task 4 (runGitOp), Task 5 (GitOpSheet + wiring).
- §6 error handling (git stderr → synthetic turn; no auto-retry; no-active-repo error) → Task 5 `runGitOpFlow` catch + the guard.
- §7 security (allow-list, argv-not-shell, `--` guards, no `--force`, protected main, token path) → Tasks 1/4.
- §8 testing → Task 1 (enum tests), Task 2 (skill load/enum), Tasks 3–5 (`swift build` + inspection; swift test blocked, noted).
- §9 build/CI → Global Constraints + the push notes after Tasks 2 and 5.

**Placeholder scan:** the Mac integration points (`activeRepoURL`, `gitTokenIfNeeded`, the exact sheet-presentation modifier, the real skill-loader entrypoint) are flagged as "read the surrounding code and bind to the real API" rather than invented — these are integration glue against existing code, not blanks. Backend tasks carry complete runnable code + commands.

**Type consistency:** `GitOp`/`GitOpTier`/`GitOpArgs`/`PendingTool.gitOpArgs` (Task 3) are used verbatim in Tasks 4–5. `runGitOp(_:at:token:)` is defined in Task 4 and called in Task 5. The op set is identical across the server enum (Task 2 frontmatter), the Swift `GitOp` enum (Task 3), and the `runGitOp` switch (Task 4) — 16 ops: status, log, diff, branch, add, commit, create_branch, checkout, pull_ff, push, merge, revert, reset, stash, clean, merge_to_main.
