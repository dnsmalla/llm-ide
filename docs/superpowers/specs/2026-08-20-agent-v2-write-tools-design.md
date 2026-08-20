# Agent v2 Write Tools + Default-On — P3 Design

- **Date:** 2026-08-20
- **Status:** Approved design, pre-implementation
- **Precedes:** P3 implementation plan (writing-plans)
- **Groundwork:** P1 spec ([2026-08-18-agent-v2-engine-design.md](2026-08-18-agent-v2-engine-design.md)); P2 spec ([2026-08-19-agent-tools-registry-design.md](2026-08-19-agent-tools-registry-design.md)); 2026-08-20 Mac-chat review that traced the "not interactive, shows unnecessary text" complaint to the legacy fence loop being the default engine (reply-hygiene fixes shipped in `181a8ed`)

## 1. Context

P1/P2 shipped the SDK engine read-and-answer: native `Read`/`Glob`/`Grep`/`WebSearch`/`WebFetch` plus the llmide registry tools, with act tools (`run-bash`, `task-create`, `task-update`) gated through `canUseTool`'s blocked → auto → always-allow → human ladder. Native `Edit`/`Write`/`Bash` are denied with "Writes and shell commands arrive in the next engine release" ([engine.mjs](../../../extension/llm_agent/sdk/engine.mjs), `DENY_NEXT_RELEASE`).

This is that release. The v2 engine is the route to a Claude-Code-equivalent chat experience (multi-step edits, real tool loop, mid-turn approvals), but today it cannot change a file, and the whole engine hides behind a default-off beta toggle. **P3 goal:** open native `Edit`/`Write`/`Bash` behind the existing approval machinery, give the Mac approval card a diff preview, and flip the engine default to on for new Anthropic chats.

## 2. Locked decisions

| # | Decision | Choice |
|---|---|---|
| W1 | Execution model | **Hybrid** — `Edit`/`Write` execute natively in the SDK subprocess (server-side), approval card on the Mac per use; auto-apply ("Bypass") rides the existing per-(user, tool) always-allow rows, no new mode machinery |
| W2 | Shell | **Native `Bash`, unified** — gated by the existing `runBashGate(command)`; `mcp__llmide__run-bash` is disallowed on v2 to avoid offering two shells (legacy keeps it unchanged) |
| W3 | Scope | **Tools + default-on in one effort** — ship order §7 keeps the risk staged inside the branch |
| W4 | Path safety | Server-side containment gate replaces legacy's client-side path check: `Edit`/`Write` targets must realpath-resolve under `workspaceRoot` or `additionalDirectories`; escapes (symlink, `..`) and project-less chats are hard-denied |
| W5 | Approval payload | `approval_request` gains a structured `args` field (capped) so the Mac can render a real diff; `argsSummary` stays for back-compat |
| W6 | Always-allow granularity | Per (user, toolName) — `'Edit'`, `'Write'`, `'Bash'` — same table and semantics as P2 (`kb/tool-approvals.mjs`); blocked tier and the containment gate are never bypassed by always-allow |

Non-goals for P3: checkpoints/rewind, `NotebookEdit`/`MultiEdit`, phone-side approval answering, per-directory allow scopes, retiring the legacy engine.

## 3. Server — native-tool branch in `canUseTool`

`Edit`/`Write`/`Bash` stay **out of `allowedTools`** so the SDK consults `canUseTool` on every use. The current catch-all deny is replaced by a native branch that mirrors the act-tool ladder exactly (gate first, unconditionally; always-allow only shortcuts the prompt tier):

- **`Bash`** — `runBashGate(input.command)`:
  - `blocked` → deny "Command blocked for safety."
  - `auto` → allow.
  - `prompt` → `hasAlwaysAllow(userId, 'Bash')` → allow; else park a `ToolApproval` (same `registerDecision` registry: 300 s park, abort-on-disconnect, tenancy check).
- **`Edit` / `Write`** — new containment gate `writePathGate(filePath, { workspaceRoot, additionalDirectories })`:
  - No `workspaceRoot` (project-less chat) → deny with an actionable message ("open a project to let the agent edit files").
  - Realpath-resolve the target's parent (the file itself may not exist for `Write`); deny unless the resolved path is strictly under an allowed root. Symlink escapes and `..` traversal are thereby `blocked`-tier — never promptable, never always-allowable.
  - Passing the gate → `hasAlwaysAllow(userId, 'Edit'|'Write')` → allow; else park a `ToolApproval`.
- Any other unknown tool keeps a deny (message updated — no longer "next release").

Mode policy: restricted modes (`plan`/`assist_plan`/`review`/`document`) add `Edit`, `Write`, `Bash` to `disallowedTools` in `v2ToolPolicyForMode` — same roster philosophy as P2 (belt: canUseTool re-checks `restrictsTools(mode)` for the native names, braces: disallowedTools removes them from model context). v2 additionally always disallows `mcp__llmide__run-bash` (W2).

`always-allow` answers from the card call `setAlwaysAllow(userId, toolName)` with the **native** tool name; the existing `run-bash` rows keep gating legacy only.

## 4. Wire + Mac — diff-capable approval card

**Wire:** the `approval_request` event (ToolApproval kind) gains `args`, a structured object per tool, each field capped at 20 000 chars with a `truncated: true` marker when cut:

```json
{ "type": "approval_request", "kind": "ToolApproval", "toolName": "Edit",
  "argsSummary": "...unchanged...",
  "args": { "filePath": "...", "oldString": "...", "newString": "..." } }
```

- `Edit` → `{ filePath, oldString, newString, truncated? }`
- `Write` → `{ filePath, contentPreview, totalChars, truncated? }`
- `Bash` → `{ command }`

**Mac:** `AgentV2Approval` decodes optional `args` (older servers → nil → today's summary rendering; decode-tolerant like the existing `kind` default). The ToolApproval card renders per tool:

- `Bash` — the command in a monospace block (what `argsSummary` shows today, formalized).
- `Edit` — an old/new diff preview, reusing the diff rendering the legacy `UpdateFileSheet` flow already has.
- `Write` — file path + content preview with a "new file / overwrite" label.

Actions stay allow / deny / **always-allow** (labelled with the tool: "Always allow Edit"). No decision-route changes — `POST /agent/v2/decision` already carries `action`.

## 5. Default-on

`chat.useAgentV2` flips its **unset-default to true**:

- `AgentV2Selection.toggleEnabled` → `defaults.object(forKey:) == nil ? true : defaults.bool(forKey:)` (an explicit user `false` is honored forever).
- The two `@AppStorage(AgentV2Selection.toggleKey)` declarations change `= false` → `= true`.
- Everything else stands: D3 clean cut (existing chats stay legacy), Anthropic-provider-only, the 404 stale-server fallback with its banner, and the per-chat engine stamp at creation.
- Settings copy updates from "beta opt-in" phrasing to "on by default; turn off to use the classic engine for new chats".

## 6. Testing

**Server (node:test):**
- canUseTool native branch: gate ordering (blocked never bypassed by always-allow), Bash auto/prompt tiers, Edit/Write containment (inside root, `..` escape, symlink escape, project-less deny, new-file Write in an existing dir), always-allow shortcut per tool name, restricted-mode denial, unknown-tool deny message.
- `v2ToolPolicyForMode`: run-bash disallowed on v2 in every mode; Edit/Write/Bash disallowed in restricted modes.
- events: `approval_request.args` shapes, 20k caps + `truncated` marker, absent for AskUserQuestion.

**Mac (swift-testing):**
- `AgentV2Approval` decode: with `args`, without `args` (old server), unknown tool.
- `AgentV2Selection`: unset → true, explicit false → false, explicit true → true; `engineForNewChat` follows.

**Regression:** legacy loop and P2 registry suites unchanged; the existing v2 engine tests (deny path) update to the new branch.

## 7. Ship order (one branch, staged commits)

1. `feat(server)`: containment gate + canUseTool native branch + mode policy + wire `args` (+ tests) — toggle still default-off, so exposure is opt-in.
2. `feat(mac)`: approval-card diff rendering + `args` decode (+ tests).
3. `feat(mac)`: default-on flip + settings copy (+ tests) — last, so everything under it is already verified.

Risk register: the write-execution locus moves from the Mac client to the SDK subprocess (operator user). The containment gate is the load-bearing replacement for the legacy client-side path refusal; its tests (symlink/`..`) are the non-negotiable part of commit 1. Rollback for any stage is a single-commit revert; stage 3 alone reverts the user-facing default.
