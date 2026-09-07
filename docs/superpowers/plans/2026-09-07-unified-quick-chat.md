# Unified Quick Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Mac menu-bar chat, the Mac LLM Chat sheet and the iPhone's global chat the same kind of chat as the Code Assistant panel — same project memory, same read-only tools, same streaming and markdown — sharing one conversation.

**Architecture:** A new server-side restricted mode `ask` gives read-only tools by construction. On the Mac, a new `ChatScope.quick` session is served by a single `ChatEngine` obtained from `ChatEngineRegistry`, which all three surfaces (menu bar, sheet, phone) resolve, so there is one engine and one session file. `ChatSession` gains an optional `projectId` so a project switch cannot silently continue a conversation aimed at a different repo.

**Tech Stack:** Node 20 (pure HTTP, no framework), SwiftUI / Swift 6, `node:test`, SQLite (better-sqlite3).

**Spec:** `docs/superpowers/specs/2026-09-07-unified-quick-chat-design.md` — read it before Task 1. Every decision here argues from that document.

## Global Constraints

- **Swift tests cannot run on this machine.** There is no XCTest runtime. Do **not** run `swift test` — it fails misleadingly. The Swift gate is three real builds, all from `mac/`, all needing `dangerouslyDisableSandbox`:
  - `GIT_CONFIG_GLOBAL=/dev/null swift build`
  - `GIT_CONFIG_GLOBAL=/dev/null LLMIDE_FEATURES=agent_chat,auto_tasks,mobile_sync swift build --manifest-cache none`
  - `GIT_CONFIG_GLOBAL=/dev/null LLMIDE_FEATURES=agent_chat swift build --manifest-cache none`
- **Extension tests** run from `extension/`: `node --test tests/<file>` for one file, `npm test` for all. Run `npm test` with the sandbox disabled — sandboxed runs show spurious `listen EPERM` failures in `mcp-connector-oauth-routes.test.mjs`.
- **Lint:** `./node_modules/.bin/eslint <files>` from `extension/`. Do not use `npx eslint` — it hits an npm cache `EPERM` on this machine.
- **Docs checks:** from the repo root, `.venv-docs/bin/python docs/_scripts/check_api_coverage.py` (and `check_spec_values.py`, `check_spec_citations.py`, `check_rate_limit_mapping.py`).
- **`SERVER_API_VERSION` never moves alone.** `check_spec_values.py` compares it against `docs/spec/cross-cutting.md` and `docs/spec/api-server.md`; changing the constant without those two files fails docs-check.
- **Do not commit `.skills`.** It is dirty from a concurrent session. Commit path-restricted: `git add -- <explicit paths>`, never `git add -A`.
- **Conventional Commits**, one concern per commit. End every commit message with:
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`
- **Comments explain WHY, not what** — match the surrounding density, which is high in this codebase.

---

## File Structure

| File | Responsibility |
|---|---|
`extension/llm_agent/runtime/mode-classify.mjs` | `MODES` — which mode strings the route accepts at all |
`extension/llm_agent/runtime/mode-personas.mjs` | `MODE_CONFIG` — which modes restrict tools, and their persona |
`extension/server.mjs` | `SERVER_API_VERSION` (the client's safety gate depends on it) |
`mac/Sources/LlmIdeMac/Models/ChatSession.swift` | `ChatScope.quick`, optional `projectId` |
`mac/Sources/LlmIdeMac/Services/ChatSessionStore.swift` | project-scoped listing |
`mac/Sources/LlmIdeMac/Chat/QuickChatContext.swift` (new) | the one place that answers "what project is the quick chat aimed at, and is there one" — shared by all three surfaces so the answer cannot diverge |
`mac/Sources/LlmIdeMac/Views/MenuBar/MenuBarChatView.swift` | menu-bar surface |
`mac/Sources/LlmIdeMac/Views/Shell/LlmChatSheet.swift` | sheet surface |
`mac/Sources/LlmIdeMac/Views/Shell/LlmChatViewModel.swift` | history from the store, not `/kb/agent/ask/history` |
`mac/Sources/LlmIdeMac/Services/MobileControlManager.swift` | phone `llmide_chat` arm |

`QuickChatContext.swift` is new rather than a helper inside one view because three surfaces need the identical answer; a copy in each is how the no-project message and the project targeting drift apart.

---

## Task 1: Server — the `ask` mode

**The single most safety-critical task in this plan.** `ask` must be added in **two** places. Either one alone gives the request FULL unrestricted tools:

- in `MODES` only → `restrictsTools('ask')` is false → unrestricted
- in `MODE_CONFIG` only → the route rejects the unknown mode and falls back to `execute` (`route.mjs:130-137`) → unrestricted

**Files:**
- Modify: `extension/llm_agent/runtime/mode-classify.mjs:21`
- Modify: `extension/llm_agent/runtime/mode-personas.mjs:42-57`
- Test: `extension/tests/mode-personas.test.mjs` (create if absent; check first with `ls extension/tests | grep mode`)

**Interfaces:**
- Consumes: nothing.
- Produces: the mode string `"ask"`, accepted by `/agent/v2/stream` and `/code-assist`, restricting tools to `READ_ONLY_TOOL_NAMES`. Tasks 4-8 send it.

- [ ] **Step 1: Write the failing test**

```js
// extension/tests/mode-personas.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MODES } from '../llm_agent/runtime/mode-classify.mjs';
import { restrictsTools, allowedToolNames, personaForMode } from '../llm_agent/runtime/mode-personas.mjs';
import { v2ToolPolicyForMode } from '../llm_agent/sdk/engine.mjs';

// `ask` is the quick chat's mode (menu bar / sheet / phone). Those surfaces can
// be driven while NO window is showing the chat — the menu-bar popover closes,
// and the phone has no approval UI at all — so a turn that could park on an
// approval would hang until the server's park timeout denied it. Read-only is
// therefore not a preference here, it is the thing that makes the surface safe.
test('ask mode is accepted by the route AND restricts tools', () => {
  // BOTH halves. Either alone silently yields full unrestricted access:
  // missing from MODES, the route falls back to execute; missing from
  // MODE_CONFIG, restrictsTools() is false.
  assert.ok(MODES.has('ask'), 'route must accept the mode');
  assert.equal(restrictsTools('ask'), true, 'and must restrict its tools');
});

test('ask mode cannot reach an act tool', () => {
  const names = allowedToolNames('ask');
  assert.ok(names.has('read-file'), 'reading is the point');
  assert.ok(names.has('find-code'));
  assert.ok(names.has('project_memory'), 'project memory is why this exists');
  assert.ok(!names.has('run-bash'), 'no shell');
  assert.ok(!names.has('update-file'), 'no writes');

  // The v2 path is where it is enforced for the default engine: the act tools
  // AND the native Bash/Edit/Write must be hard-disallowed, not merely absent
  // from the allowlist — absence only demotes a tool to a canUseTool consult
  // that the 'auto' tier would allow (see engine.mjs's own note at ~:812).
  const policy = v2ToolPolicyForMode('ask');
  const disallowed = new Set(policy.disallowedTools);
  assert.ok([...disallowed].some((n) => n.includes('run-bash')), 'run-bash disallowed');
  for (const native of ['Bash', 'Edit', 'Write']) {
    assert.ok(disallowed.has(native), `native ${native} disallowed`);
  }
});

test('ask mode has a Q&A persona, not a review or document one', () => {
  const persona = personaForMode('ask');
  assert.match(persona, /question/i, 'framed as answering questions');
  assert.ok(!/code-review feedback/i.test(persona), 'not the review persona');
  assert.ok(!/documentation/i.test(persona), 'not the document persona');
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd extension && node --test tests/mode-personas.test.mjs`
Expected: FAIL — `MODES.has('ask')` is false.

- [ ] **Step 3: Add `ask` to `MODES`**

In `extension/llm_agent/runtime/mode-classify.mjs:21`:

```js
// `ask` is the quick chat's mode (menu bar / sheet / phone). It is listed here
// AND in MODE_CONFIG (mode-personas.mjs) — both, always: this Set decides
// whether the route accepts the string at all, and MODE_CONFIG decides whether
// it restricts tools. With only one, a request asking for `ask` runs with FULL
// unrestricted access, which for this surface means an approval nothing can
// render. Never add a restricted mode to one without the other.
export const MODES = new Set(['plan', 'assist_plan', 'review', 'document', 'ask', 'execute']);
```

Note: `ask` is NOT added to the classifier's prompt — `mode: "auto"` must never classify a panel turn into the quick chat's mode. Verify the classifier's list is separate from `MODES`; if it enumerates `MODES` directly, exclude `ask` explicitly and add a test asserting `classifyCodeAssistMode` never returns `'ask'`.

- [ ] **Step 4: Add `ask` to `MODE_CONFIG`**

In `extension/llm_agent/runtime/mode-personas.mjs`, inside `MODE_CONFIG` (after `document`):

```js
  ask: {
    persona: 'You are in ASK mode — the user is asking a question about this '
           + 'project from a quick-chat window, not starting a work session. '
           + 'Answer directly and concisely, using the read-only tools to ground '
           + 'the answer in the actual code and in this project\'s memory rather '
           + 'than guessing. You cannot modify anything in this mode: no file '
           + 'edits, no shell commands, no git/issue/PR actions. If the user '
           + 'wants a change made, say so and tell them to ask in the '
           + 'Code Assistant panel.',
  },
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd extension && node --test tests/mode-personas.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 6: Run the neighbouring suites the mode touches**

Run: `cd extension && node --test tests/route-modes.test.mjs tests/agent-v2-engine.test.mjs tests/agent-v2-routes.test.mjs`
Expected: PASS. If `route-modes` asserts an exact `MODES` membership count, update that assertion to include `ask` and say so in the commit body.

- [ ] **Step 7: Lint and commit**

```bash
cd extension && ./node_modules/.bin/eslint llm_agent/runtime/mode-classify.mjs llm_agent/runtime/mode-personas.mjs tests/mode-personas.test.mjs
cd .. && git add -- extension/llm_agent/runtime/mode-classify.mjs extension/llm_agent/runtime/mode-personas.mjs extension/tests/mode-personas.test.mjs
git commit -m "$(cat <<'EOF'
feat(agent): add a read-only `ask` mode for the quick chat

The quick chat (menu bar, LLM Chat sheet, iPhone) can be driven while no
window is showing it — the popover closes, and the phone has no approval UI —
so a turn able to park on an approval would hang until the server's park
timeout denied it. `ask` makes read-only a property of the mode rather than a
promise: MODE_CONFIG membership gives restrictsTools(), allowedToolNames is
derived from the registry as kind === 'read', and v2ToolPolicyForMode hard-
disallows the act tools plus native Bash/Edit/Write.

Added to MODES and MODE_CONFIG together, deliberately: with only one, a
request asking for `ask` runs with FULL unrestricted access — missing from
MODES the route falls back to execute, missing from MODE_CONFIG restrictsTools
is false. The test asserts both halves for that reason.

A new mode rather than reusing review/document, whose personas are
task-specific ("give structured code-review feedback", "write documentation")
and wrong for general Q&A.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Server — version gate

The client must be able to tell that a server knows `ask`. Against an older server the mode falls back to `execute` — full act tools in a window whose approvals may be unrenderable. This is the one failure in this plan that is a safety issue rather than a cosmetic one.

**Files:**
- Modify: `extension/server.mjs` (`SERVER_API_VERSION`, currently 46 — confirm with `grep -n "const SERVER_API_VERSION" extension/server.mjs`)
- Modify: `docs/spec/cross-cutting.md`, `docs/spec/api-server.md` (the two files `check_spec_values.py` compares against)
- Modify: `docs/reference/api/openapi.yaml` (the `mode` enum on `/agent/v2/stream` and `/code-assist`)

**Interfaces:**
- Consumes: Task 1's `ask` mode.
- Produces: `SERVER_API_VERSION = 47`, the value Task 9's client gate compares against.

- [ ] **Step 1: Bump the constant with its rationale**

Append to the version history comment above `const SERVER_API_VERSION` and set it to 47:

```js
//   v47 — `mode: "ask"` accepted on /code-assist and /agent/v2/stream: a
//     read-only mode for the quick chat (menu bar / sheet / phone). NOT
//     additive in the safe direction — an older server silently resolves an
//     unknown mode to `execute`, i.e. FULL act tools for a surface whose
//     approvals may have no window to render them, so the client must gate on
//     this version before offering the quick chat rather than degrade.
const SERVER_API_VERSION = 47;
```

`ENDPOINTS` is unchanged — no new route.

- [ ] **Step 2: Update the two spec pages**

Replace `SERVER_API_VERSION = 46` with `= 47` in both `docs/spec/cross-cutting.md` and `docs/spec/api-server.md`. There is exactly one occurrence in each; verify with `grep -n "SERVER_API_VERSION = " docs/spec/*.md`.

- [ ] **Step 3: Add `ask` to the documented mode enum**

In `docs/reference/api/openapi.yaml`, find the `mode` property on `/agent/v2/stream` and on `/code-assist` (`grep -n "mode:" docs/reference/api/openapi.yaml`). Add `ask` to each enum, with the description: `'ask = read-only quick chat (menu bar / sheet / phone): no file edits, no shell, no git actions'`. **Quote any description containing a comma** — an unquoted flow scalar splits on it and silently produces a bogus schema member.

- [ ] **Step 4: Verify docs-check passes**

```bash
.venv-docs/bin/python docs/_scripts/check_spec_values.py
.venv-docs/bin/python docs/_scripts/check_api_coverage.py
.venv-docs/bin/python -c "import yaml; yaml.safe_load(open('docs/reference/api/openapi.yaml')); print('YAML OK')"
```
Expected: `OK: all 11 documented spec values match source.`, `OK: all 99 live endpoints documented.`, `YAML OK`.

- [ ] **Step 5: Commit**

```bash
git add -- extension/server.mjs docs/spec/cross-cutting.md docs/spec/api-server.md docs/reference/api/openapi.yaml
git commit -m "$(cat <<'EOF'
feat(server): bump API version for the read-only `ask` mode

An older server resolves an unknown mode to `execute` (route.mjs's documented
fallback), so a client sending `ask` to one gets FULL act tools for a surface
whose approvals may have no window to render them. That makes this a version
the client must gate on rather than degrade against, unlike v44-v46 which were
additive in the safe direction.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Mac — `ChatScope.quick` and project identity on a session

`ChatSession` has no project id and the session pointer is `chat.current.<scope>` (`ChatEngine+Session.swift:32`) — global. A chat that follows the active project, on a session with no project identity, silently continues against a different repo when the user switches. Fixing it here also retires a pre-existing defect for every scope.

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Models/ChatSession.swift:6-8` (scope enum), `:21-40` (fields, `CodingKeys`, `init(from:)`, `encode(to:)`)
- Modify: `mac/Sources/LlmIdeMac/Services/ChatSessionStore.swift:45` (`list(for:)`)

**Interfaces:**
- Consumes: nothing.
- Produces: `ChatScope.quick`; `ChatSession.projectId: String?`; `ChatSessionStore.list(for scope: ChatScope, projectId: String?) -> [ChatSession]`.

- [ ] **Step 1: Add the scope case**

`ChatSession.swift:7`:

```swift
// `quick` is the menu-bar / LLM Chat sheet / iPhone conversation — one shared
// session, distinct from the panel scopes so a quick question does not land in
// the user's working chat.
case explorer, conflicts, visual, docGen, quick
```

- [ ] **Step 2: Add the optional project id**

Beside `var scope: ChatScope?` (`:27`):

```swift
    /// Project this chat belongs to, or nil for a chat written before project
    /// identity existed. Optional so every existing session file still decodes
    /// unchanged — there is no migration step, and a nil id simply means
    /// "unknown project", which `list(for:projectId:)` treats as belonging to
    /// none rather than to all.
    ///
    /// Without this, a chat that follows the ACTIVE project (the quick chat)
    /// silently continues against a different repo when the user switches, its
    /// earlier turns discussing files that no longer exist.
    var projectId: String?
```

Add `projectId` to `CodingKeys`, decode it as `try? c.decode(String.self, forKey: .projectId)` in `init(from:)`, and encode it in `encode(to:)`. Follow exactly how the existing optional `scope` is handled in the same three places.

- [ ] **Step 3: Write the failing store test**

Swift tests cannot run here, so this step is **a plan-level requirement, not an executable gate**: add the test file for CI, and verify locally by build only.

```swift
// mac/Tests/LlmIdeMacTests/ChatSessionProjectScopingTests.swift
import XCTest
@testable import LlmIdeMacLib

final class ChatSessionProjectScopingTests: XCTestCase {
    func testListFiltersByProject() {
        let a = ChatSession(id: UUID(), scope: .quick, projectId: "proj-a")
        let b = ChatSession(id: UUID(), scope: .quick, projectId: "proj-b")
        ChatSessionStore.save(a); ChatSessionStore.save(b)
        let forA = ChatSessionStore.list(for: .quick, projectId: "proj-a")
        XCTAssertEqual(forA.map(\.id), [a.id], "a project must not see another's quick chat")
    }

    func testLegacySessionWithNoProjectIdIsNotServedToEveryProject() {
        let legacy = ChatSession(id: UUID(), scope: .quick, projectId: nil)
        ChatSessionStore.save(legacy)
        XCTAssertFalse(ChatSessionStore.list(for: .quick, projectId: "proj-a").map(\.id).contains(legacy.id),
                       "an unknown-project chat belongs to none, not to all")
    }
}
```

If `ChatSession`'s memberwise init is not accessible with those arguments, construct it the way existing tests do (`grep -rn "ChatSession(" mac/Tests | head`) and keep the assertions identical.

- [ ] **Step 4: Add project filtering to the store**

`ChatSessionStore.swift:45` — add an overload rather than changing the existing signature, so the four panel scopes keep compiling untouched:

```swift
    /// Sessions for `scope` belonging to `projectId`.
    ///
    /// A session with a nil `projectId` (written before project identity
    /// existed) belongs to NO project rather than to every one: serving it
    /// everywhere is the cross-project bleed this parameter exists to stop.
    static func list(for scope: ChatScope, projectId: String?) -> [ChatSession] {
        list(for: scope).filter { $0.projectId != nil && $0.projectId == projectId }
    }
```

- [ ] **Step 5: Make the session pointer project-aware — without this the rest of the task is inert**

`ChatEngine+Session.swift:32` is `private var pointerKey: String { "chat.current.\(scope.rawValue)" }` — one key per scope, global. So after a project switch the engine reloads *the same session id* regardless of `projectId`, and the filtered `list` above changes nothing the user sees. The pointer must carry the project too:

```swift
    /// UserDefaults key holding the last-active chat id for this scope.
    ///
    /// The `.quick` scope keys per PROJECT: that chat follows the active
    /// project, so one global pointer would reload the previous project's
    /// conversation after a switch — the cross-project bleed `projectId`
    /// exists to stop, and filtering the session LIST alone does not stop it,
    /// because the engine loads by pointer, not by list.
    ///
    /// The panel scopes keep the unsuffixed key so their existing pointers
    /// keep resolving; changing them would silently orphan every user's
    /// current chat on upgrade.
    private var pointerKey: String {
        guard scope == .quick, let project = quickChatProjectId else {
            return "chat.current.\(scope.rawValue)"
        }
        return "chat.current.\(scope.rawValue).\(project)"
    }
```

`quickChatProjectId` is a new optional `String` on `ChatEngine`, set by whoever resolves the engine (Tasks 5, 6, 8) from `QuickChatContext.projectId` before the first load. Add it beside the other engine state with a comment saying a nil value means "not a quick chat, or no project yet" and that the unsuffixed key is then used.

- [ ] **Step 6: Build all three configurations**

```bash
cd mac && GIT_CONFIG_GLOBAL=/dev/null swift build
GIT_CONFIG_GLOBAL=/dev/null LLMIDE_FEATURES=agent_chat,auto_tasks,mobile_sync swift build --manifest-cache none
GIT_CONFIG_GLOBAL=/dev/null LLMIDE_FEATURES=agent_chat swift build --manifest-cache none
```
Expected: `Build complete!` three times. A `switch` over `ChatScope` that is now non-exhaustive will fail here — fix each by handling `.quick` explicitly rather than adding a `default`, so the next case added is caught the same way.

- [ ] **Step 6: Commit**

```bash
git add -- mac/Sources/LlmIdeMac/Models/ChatSession.swift mac/Sources/LlmIdeMac/Services/ChatSessionStore.swift mac/Tests/LlmIdeMacTests/ChatSessionProjectScopingTests.swift
git commit -m "$(cat <<'EOF'
feat(mac): give a chat session a project, and add the quick scope

ChatSession carried no project id and the session pointer is global, so a chat
resumed under a different project kept talking about the previous repo — a
pre-existing defect that the quick chat, which explicitly follows the ACTIVE
project, would turn from latent into visible.

projectId is optional so every existing session file decodes unchanged with no
migration step. A nil id means "unknown project" and belongs to NONE rather
than to all: serving those everywhere is the exact bleed this stops.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Mac — `QuickChatContext`, the single answer to "which project, and is there one"

Three surfaces need the identical answer. A copy in each is how the no-project message and the project targeting drift apart.

**Files:**
- Create: `mac/Sources/LlmIdeMac/Chat/QuickChatContext.swift`
- Test: `mac/Tests/LlmIdeMacTests/QuickChatContextTests.swift`

**Interfaces:**
- Consumes: `WorkspaceRoot.resolve(config:projectStore:)`, `ProjectStore.activeProject`, `AgentContext`.
- Produces:
  - `QuickChatContext.resolve(config: AppConfig, projectStore: ProjectStore) -> QuickChatContext?` — nil when no project is active
  - `.projectId: String`, `.agentContext: AgentContext`
  - `QuickChatContext.noProjectMessage: String` — the one sentence all three surfaces show

- [ ] **Step 1: Write the file**

```swift
import Foundation

/// What the quick chat (menu bar / LLM Chat sheet / iPhone) is aimed at.
///
/// One type, three consumers, deliberately: the surfaces must agree on which
/// project a turn targets AND on what they say when there is none. Two copies
/// of that answer drift, and the failure is silent — a chat answering about
/// the wrong repo looks exactly like a chat answering about the right one.
///
/// `resolve` returns nil when no project is active. That is not an error: the
/// code pipeline cannot run without a project (the server throws
/// `workspaceRoot is required`), so the surfaces decline rather than send a
/// request that must fail.
struct QuickChatContext {
    let projectId: String
    let agentContext: AgentContext

    /// Shown by all three surfaces, and sent to the phone as a normal reply —
    /// NOT as a CommandError, which the phone renders as a failure rather than
    /// as an answer.
    static let noProjectMessage =
        "Open a project to chat about your code. This chat answers from the "
        + "active project's code and memory, so it needs one to be open."

    static func resolve(config: AppConfig, projectStore: ProjectStore) -> QuickChatContext? {
        guard let project = projectStore.activeProject else { return nil }
        guard let root = WorkspaceRoot.resolve(config: config, projectStore: projectStore) else { return nil }
        return QuickChatContext(
            projectId: project.id,
            // Same shape the panel sends (see CodeAssistantPanel+Agent.swift):
            // the server scopes its read-only file tools to this root, so
            // "where is auth handled" can resolve a real file.
            agentContext: AgentContext(workspaceRoot: homeRelativePath(root.path)))
    }
}
```

Adjust `AgentContext(...)` and `project.id` to the real initializer and identifier — check with `grep -n "struct AgentContext" -A 12 mac/Sources/LlmIdeMac/Models/*.swift` and `grep -n "struct ActiveProject" -A 8 mac/Sources/LlmIdeMac/Services/ProjectStore.swift`. If `ActiveProject` has no `id`, use its stable path-derived identifier and note the choice in a comment. Keep `indexedRepos` out unless the panel's builder is trivially reusable — the read-only tools need `workspaceRoot`; indexed repos are an enhancement, not a requirement.

- [ ] **Step 2: Add the test file (for CI; local gate is the build)**

```swift
// mac/Tests/LlmIdeMacTests/QuickChatContextTests.swift
import XCTest
@testable import LlmIdeMacLib

final class QuickChatContextTests: XCTestCase {
    func testNoProjectMessageNamesTheReason() {
        // The phone shows this verbatim, so it must explain WHY rather than
        // just refuse.
        XCTAssertTrue(QuickChatContext.noProjectMessage.contains("Open a project"))
        XCTAssertTrue(QuickChatContext.noProjectMessage.contains("memory"))
    }
}
```

- [ ] **Step 3: Build (full configuration only for this task)**

Run: `cd mac && GIT_CONFIG_GLOBAL=/dev/null swift build`
Expected: `Build complete!`

- [ ] **Step 4: Commit**

```bash
git add -- mac/Sources/LlmIdeMac/Chat/QuickChatContext.swift mac/Tests/LlmIdeMacTests/QuickChatContextTests.swift
git commit -m "$(cat <<'EOF'
feat(mac): add QuickChatContext, one answer for the quick chat's target

Three surfaces (menu bar, sheet, phone) must agree on which project a quick
chat turn targets and on what they say when none is open. A helper per surface
is how those two answers drift, and the failure is silent: a chat answering
about the wrong repo looks like one answering about the right repo.

resolve() returning nil is not an error — the code pipeline cannot run without
a project, so the surfaces decline instead of sending a request that must fail.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Mac — menu bar onto the registry engine

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Views/MenuBar/MenuBarChatView.swift` — `@State` engine (`:13`), `wireEngine()` (`:621-637`), the reply renderer (`:402`)

**Interfaces:**
- Consumes: `QuickChatContext` (Task 4), `ChatEngineRegistry.shared.engine(for: .quick, api:)`, `ChatScope.quick` (Task 3), mode `"ask"` (Task 1).
- Produces: nothing new.

- [ ] **Step 1: Replace the owned engine with the registry's**

Delete `@State private var engine: ChatEngine` and its `AgentAskTransport` construction. Resolve the shared engine instead:

```swift
    // The SAME engine the LLM Chat sheet and the phone drive: one engine per
    // conversation. Each surface holding its own would mean three engines
    // writing one session file — the concurrent-holders bug that already
    // resurrected deleted chats through persistCurrentChat.
    private var engine: ChatEngine { ChatEngineRegistry.shared.engine(for: .quick, api: api) }
```

If a `@State`-bound engine is required by this view's body (observation), keep the property but assign it from the registry in `.onAppear` rather than constructing a new one — never `ChatEngine(scope:transport:)` here.

- [ ] **Step 2: Send the project context and the `ask` mode**

Replace `wireEngine()`'s `resolveTransportInput` body (`:622-636`). The two changes are `agentContext` and `mode`:

```swift
    private func wireEngine() {
        engine.resolveTransportInput = { message, history, attachments, skills in
            let tool = AICliTool(rawValue: config.activeCLI) ?? .claudeCode
            let model = selectedModelId ?? (config.defaultModelId.isEmpty ? nil : config.defaultModelId)
            return ChatTransportInput(
                message: message,
                history: history,
                attachments: attachments,
                skills: skills,
                // Was nil, which is why this chat could neither read nor write
                // project memory — the whole point of unifying it.
                agentContext: QuickChatContext.resolve(config: config, projectStore: projectStore)?.agentContext,
                language: config.preferredLanguage.isEmpty ? nil : config.preferredLanguage,
                model: model,
                provider: ChatTransportInput.makeProvider(selectedProvider: tool.rawValue),
                // Read-only: this window can be closed while the phone drives
                // the same engine, so a turn that could park on an approval
                // would hang with nothing able to render the card.
                mode: "ask"
            )
        }
    }
```

`projectStore` must be available here — add `@EnvironmentObject private var projectStore: ProjectStore` (or match however sibling views obtain it: `grep -n "projectStore" mac/Sources/LlmIdeMac/Views/MenuBar/MenuBarChatView.swift`).

- [ ] **Step 3: Render the no-project state instead of a composer**

Where the composer is rendered, gate it:

```swift
            if QuickChatContext.resolve(config: config, projectStore: projectStore) == nil {
                Text(QuickChatContext.noProjectMessage)
                    .font(Typography.caption)
                    .foregroundStyle(theme.current.textMuted)
                    .padding(Spacing.md)
            } else {
                composer   // the existing composer view
            }
```

- [ ] **Step 4: Render markdown**

`MenuBarChatView.swift:402` renders a plain `Text`. Replace it with `SelfSizingMarkdownView` as the panel does — check its initializer with `grep -n "struct SelfSizingMarkdownView" -A 10 mac/Sources/LlmIdeMac/Views/**/SelfSizingMarkdownView.swift` and pass the same arguments the panel's message list passes.

- [ ] **Step 5: Build all three configurations**

Run the three build commands from Global Constraints.
Expected: `Build complete!` three times.

- [ ] **Step 6: Commit**

```bash
git add -- mac/Sources/LlmIdeMac/Views/MenuBar/MenuBarChatView.swift
git commit -m "$(cat <<'EOF'
feat(mac): put the menu-bar chat on the code pipeline

It passed agentContext: nil, so it neither read nor wrote project memory — a
chat that answered from nothing the user had taught the project, in a window
that looks like the one that does. Now it sends the active project's context
and `ask` mode, and renders markdown.

Uses the registry's shared .quick engine rather than owning one: the sheet and
the phone drive the same conversation, and three engines writing one session
file is the concurrent-holders bug that already resurrected deleted chats.

With no project open it declines and says why, because the code pipeline cannot
run without one.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Mac — the LLM Chat sheet onto the same engine

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Views/Shell/LlmChatSheet.swift`
- Modify: `mac/Sources/LlmIdeMac/Views/Shell/LlmChatViewModel.swift`

**Interfaces:**
- Consumes: everything Task 5 consumes; the same `.quick` engine instance.
- Produces: nothing new.

- [ ] **Step 1: Use the registry's engine instead of an owned one**

Delete `LlmChatSheet`'s own engine construction and its `AgentAskTransport`, and resolve the shared one — the same instance the menu bar uses, which is what makes the two windows one conversation:

```swift
    // The SAME engine the menu bar and the phone drive. Three surfaces each
    // owning one would be three engines writing a single session file — the
    // concurrent-holders bug that already resurrected deleted chats through
    // persistCurrentChat.
    private var engine: ChatEngine { ChatEngineRegistry.shared.engine(for: .quick, api: api) }
```

Set `engine.quickChatProjectId = QuickChatContext.resolve(config: config, projectStore: projectStore)?.projectId` before the first session load (Task 3, Step 5), or the pointer falls back to the unsuffixed key.

- [ ] **Step 2: Send the project context and the `ask` mode**

```swift
        engine.resolveTransportInput = { message, history, attachments, skills in
            let tool = AICliTool(rawValue: config.activeCLI) ?? .claudeCode
            let model = selectedModelId ?? (config.defaultModelId.isEmpty ? nil : config.defaultModelId)
            return ChatTransportInput(
                message: message,
                history: history,
                attachments: attachments,
                skills: skills,
                // Was nil, which is why this chat could neither read nor write
                // project memory — the whole point of unifying it.
                agentContext: QuickChatContext.resolve(config: config, projectStore: projectStore)?.agentContext,
                language: config.preferredLanguage.isEmpty ? nil : config.preferredLanguage,
                model: model,
                provider: ChatTransportInput.makeProvider(selectedProvider: tool.rawValue),
                // Read-only: this sheet can be dismissed while the phone drives
                // the same engine, so a turn that could park on an approval
                // would hang with nothing able to render the card.
                mode: "ask"
            )
        }
```

Match the sheet's actual property names for `selectedModelId` / `config` / `api` — check with `grep -n "@State\|@Environment\|let api" mac/Sources/LlmIdeMac/Views/Shell/LlmChatSheet.swift`.

- [ ] **Step 3: Render the no-project state instead of a composer**

```swift
            if QuickChatContext.resolve(config: config, projectStore: projectStore) == nil {
                Text(QuickChatContext.noProjectMessage)
                    .font(Typography.caption)
                    .foregroundStyle(theme.current.textMuted)
                    .padding(Spacing.md)
            } else {
                composer   // the sheet's existing composer view
            }
```

- [ ] **Step 4: Add the one-engine test (for CI; local gate is the build)**

This is the assertion that guards decision 4 against a future refactor quietly reintroducing per-surface engines:

```swift
// mac/Tests/LlmIdeMacTests/QuickChatSharedEngineTests.swift
import XCTest
@testable import LlmIdeMacLib

@MainActor
final class QuickChatSharedEngineTests: XCTestCase {
    func testQuickScopeResolvesToOneEngineInstance() {
        let api = LlmIdeAPIClient(baseURL: URL(string: "http://127.0.0.1:3456")!)
        let a = ChatEngineRegistry.shared.engine(for: .quick, api: api)
        let b = ChatEngineRegistry.shared.engine(for: .quick, api: api)
        XCTAssertTrue(a === b, "the menu bar, the sheet and the phone must share ONE engine")
    }
}
```

Construct `LlmIdeAPIClient` the way existing tests do (`grep -rn "LlmIdeAPIClient(" mac/Tests | head -3`); the registry's doc notes the same scope with a *different* `api` still returns the same engine, so the argument is not load-bearing here.

- [ ] **Step 5: Take history from the store, not `/kb/agent/ask/history`**

`LlmChatViewModel` fetches history via `AgentAskHistoryFetching` (`listAgentAskHistory` / `clearAgentAskHistory`). The engine now owns the transcript, persisted in `ChatSessionStore`. Replace the fetch with the engine's `messages`, and make "clear" call the engine's session delete — which also forgets server-side session memory, satisfying "session memory dies with the session" for this surface. Remove `AgentAskHistoryFetching` and its `extension LlmIdeAPIClient: AgentAskHistoryFetching {}`.

Leave `LlmIdeAPIClient.listAgentAskHistory` / `clearAgentAskHistory` in place if the meeting-agent surface still uses them (`grep -rn "listAgentAskHistory\|clearAgentAskHistory" mac/Sources/`); delete them only if this was the last caller.

- [ ] **Step 6: Build all three configurations**

Expected: `Build complete!` three times.

- [ ] **Step 7: Commit**

```bash
git add -- mac/Sources/LlmIdeMac/Views/Shell/LlmChatSheet.swift mac/Sources/LlmIdeMac/Views/Shell/LlmChatViewModel.swift mac/Tests/LlmIdeMacTests/QuickChatSharedEngineTests.swift
git commit -m "$(cat <<'EOF'
feat(mac): put the LLM Chat sheet on the code pipeline

Same change as the menu bar, on the same shared .quick engine, so the two
windows show one conversation. History now comes from ChatSessionStore via the
engine instead of /kb/agent/ask/history, and clearing goes through the
engine's session delete — which forgets server-side session memory too.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Mac — retire `AgentAskTransport`

**Files:**
- Delete: `mac/Sources/LlmIdeMac/Chat/AgentAskTransport.swift`, `mac/Tests/LlmIdeMacTests/AgentAskTransportTests.swift`

**Interfaces:**
- Consumes: Tasks 5 and 6 having removed both call sites.
- Produces: nothing.

- [ ] **Step 1: Confirm there are no remaining callers**

Run: `grep -rn "AgentAskTransport\|AgentAskSending" mac/Sources/ mac/Tests/`
Expected: only the two files being deleted. **If anything else appears, stop and report** — do not delete a type that still has a consumer.

- [ ] **Step 2: Delete both files and build all three configurations**

```bash
git rm mac/Sources/LlmIdeMac/Chat/AgentAskTransport.swift mac/Tests/LlmIdeMacTests/AgentAskTransportTests.swift
cd mac && GIT_CONFIG_GLOBAL=/dev/null swift build
```
Then the lite and min builds.

- [ ] **Step 3: Commit**

```bash
git commit -m "$(cat <<'EOF'
refactor(mac): delete AgentAskTransport with its last caller

Both surfaces that constructed it now use the code pipeline. /kb/agent/ask
itself stays — it is still the meeting-agent endpoint, and the only route that
accepts image content blocks.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Phone — `llmide_chat` drives the shared engine

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Services/MobileControlManager.swift:645-680`

**Interfaces:**
- Consumes: the `.quick` engine, `QuickChatContext`.
- Produces: nothing.

- [ ] **Step 1: Read the arm directly below as the template**

The `explore_chat` arm (immediately after `llmide_chat`, from ~`:680`) already proxies a phone turn through a registry `ChatEngine`. Read it in full and mirror its structure — cancellation handling, `Output` framing, and the `NotificationCenter` post.

- [ ] **Step 2: Replace the `askAgent` call**

Delete the `api.askAgent(...)` call (`:659-660`) and drive the shared engine instead, following the `explore_chat` shape. The no-project case must send the decline as a normal reply:

```swift
        guard let ctx = QuickChatContext.resolve(config: config, projectStore: projectStore) else {
            // A normal reply, NOT a CommandError: the phone renders an error as
            // a failure, and "no project is open on the Mac" is an answer.
            await server?.send(Output(commandId: chat.commandId,
                                      payload: OutputPayload(stream: QuickChatContext.noProjectMessage,
                                                             done: true)))
            return
        }
```

`chat.images` has no destination now — the code pipeline has no image path (`AgentAskTransport` hardcoded `images: []`, so nothing ever sent them). Drop the `images` mapping and add a comment saying images are unsupported on this path pending an image story on the code pipeline; do not silently accept and discard them.

- [ ] **Step 3: Build all three configurations**

Expected: `Build complete!` three times. Note the min configuration excludes `mobile_sync`, so this file may be compiled out there — that build passing proves the change respects the feature seam.

- [ ] **Step 4: Commit**

```bash
git add -- mac/Sources/LlmIdeMac/Services/MobileControlManager.swift
git commit -m "$(cat <<'EOF'
feat(mac): route the phone's chat onto the project chat

The phone called /kb/agent/ask directly, so it shared the meeting-agent
transcript while the Mac surfaces moved to the code pipeline — the two would
have silently diverged. It now drives the same shared .quick engine, mirroring
the explore_chat arm directly below it, so one conversation spans the menu bar,
the sheet and the phone.

"No project open on the Mac" is sent as a normal reply rather than a
CommandError, which the phone renders as a failure.

Images are dropped explicitly rather than silently: nothing ever sent them (the
old transport hardcoded an empty list) and the code pipeline has no image path.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Mac — gate the quick chat on server v47

Without this, a client sending `ask` to an older server gets `execute` — full act tools in a window whose approvals may be unrenderable. **This task is the plan's safety net; do not defer it.**

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Services/BackendManager.swift:560-580` (the floor's documented rationale)
- Modify: the two surfaces from Tasks 5 and 6

**Interfaces:**
- Consumes: `SERVER_API_VERSION = 47` (Task 2), `BackendManager`'s reported server version.
- Produces: nothing.

- [ ] **Step 1: Decide the mechanism and document it beside the floor**

`minimumServerApiVersion` is deliberately NOT lockstep — it is raised only when an older server would degrade a chat-path capability, and v44-v46 each declined with a recorded reason. This case is different: the degradation is a *safety* one. Raise the floor to 47 and record why:

```swift
    /// v47 DOES raise this floor, unlike v44-v46. The `ask` mode is not
    /// additive in the safe direction: an older server resolves an unknown
    /// mode to `execute`, so the quick chat would run with FULL act tools in a
    /// window whose approvals may have nothing to render them. Degrading is
    /// worse than refusing here.
    nonisolated static let minimumServerApiVersion = 47
```

If refusing to talk to a v46 server is too blunt (it disables the whole app, not just the quick chat), implement the narrower gate instead: keep the floor at 43 and have the two surfaces check `backend.apiVersion >= 47` before offering the composer, showing "Restart the server to use this chat" otherwise. **Choose the narrow gate if the blunt one would block unrelated features** — and say which you chose in the commit body.

- [ ] **Step 2: Build all three configurations, then run the whole gate**

```bash
cd extension && npm test          # sandbox disabled
cd extension && ./node_modules/.bin/eslint llm_agent/ routes/ core/ server.mjs tests/
cd .. && for s in check_api_coverage check_spec_values check_spec_citations check_rate_limit_mapping; do .venv-docs/bin/python docs/_scripts/$s.py; done
```
Expected: 0 test failures; no NEW lint problems (three pre-existing ones in `tests/agent-v2-engine.test.mjs` — 1 unused `meta`, 2 `require-yield` — are on HEAD and not yours); all four docs checks OK.

- [ ] **Step 3: Commit**

```bash
git add -- mac/Sources/LlmIdeMac/Services/BackendManager.swift mac/Sources/LlmIdeMac/Views/MenuBar/MenuBarChatView.swift mac/Sources/LlmIdeMac/Views/Shell/LlmChatSheet.swift
git commit -m "$(cat <<'EOF'
fix(mac): gate the quick chat on a server that knows `ask`

An older server resolves an unknown mode to `execute`, so sending `ask` to one
would give the quick chat FULL act tools in a window whose approvals may have
nothing to render them. Unlike v44-v46, this version is not additive in the
safe direction, so the client refuses rather than degrades.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Manual verification (owed by a human — nothing above proves these)

Swift tests do not run on this machine and no automated check exercises a real window. After Task 9:

1. Menu-bar chat with a project open: ask "where is auth handled?" — the reply cites real files, and `grep skill_invoked extension/kb/server.log` shows `find-code`/`read-file` calls tagged `engine`.
2. Ask something the project taught it earlier — `project_memory` appears in that log.
3. Ask it to edit a file — it declines and points at the panel; **no approval card appears anywhere**.
4. Close the project: both the menu bar and the sheet show the decline message and no composer.
5. Open the menu bar and the sheet together: the same transcript, and a turn started in one streams in the other.
6. From the phone with a project open: the reply matches what the Mac shows. With no project: the decline message as a reply, not an error.
7. Switch projects, reopen the menu bar: a DIFFERENT quick conversation, not the previous project's.
8. Delete the quick chat, then ask a new question: nothing from the deleted conversation is recalled.
9. **The stale-server case, which nothing automated covers and which is the one unsafe failure mode.** Point the app at a v46 server (or check out the previous server commit and run it): the quick chat must REFUSE rather than answer. If it answers, `ask` fell back to `execute` and that window just got full act tools — stop and fix Task 9 before shipping.
