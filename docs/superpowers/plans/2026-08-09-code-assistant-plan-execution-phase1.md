# Code Assistant Chat — Plan Execution Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the macOS Code Assistant chat show a live plan checklist as a multi-step task runs, stop and explain instead of ploughing ahead when a step fails, and render bash output / file diffs as rich collapsible blocks instead of raw text dumps — implementing Phase 1 of `docs/superpowers/specs/2026-08-09-code-assistant-plan-execution-and-modes-design.md`.

**Architecture — deviation from the spec, found during planning:** The spec proposed a new client-side `PlanTimelineStore` to "track steps, decide auto-run vs. gate, stop on failure." Reading the actual code changed that: the task/plan state machine **already lives entirely server-side** — the model self-reports progress via a `task-update` tool call (`extension/llm_agent/global/task-update.md`), the server tracks it in `extension/llm_agent/runtime/handlers/session-tasks.mjs`, and `hasPendingWork()` there already drives the "auto-continue vs. stop" decision (`continueNeeded`) that reaches the Mac client once per round-trip. A parallel client-side store would just be a second, driftable copy of that state. So Phase 1's real shape is: (1) teach the server's task state machine a `failed` status and to stop offering more work once one appears, (2) teach its prompt to explain-and-ask on failure and close with a real summary, (3) make the Mac client **render** the task list it already receives (`CodeAssistantAgentState.agentPendingTasks`) as a checklist instead of not showing it at all, and (4) fix one real gap where multi-file edits stall (`sendFollowup` auto-chains a `git-op` but never an `update-file`). No new Swift class is introduced.

Also corrected: the spec assumed bash execution needed a server-side wire-shape change. It doesn't — `BashService.execute()` (`mac/Sources/LlmIdeMac/Services/BashService.swift`) already runs `/bin/zsh` **locally on the Mac** and returns a structured `ExecutionResult{exitCode, stdout, stderr, duration}`; only the Mac-side code that flattens it into a chat turn needs to change.

**Tech Stack:** Node.js (`node --test`) for the server pieces; Swift/SwiftUI for the Mac client. No new dependencies.

---

### Task 1: `hasPendingWork` stops reporting work once a task has failed

**Files:**
- Modify: `extension/llm_agent/runtime/handlers/session-tasks.mjs`
- Test: `extension/tests/session-tasks.test.mjs` (new)

Today, `hasPendingWork` returns `true` whenever any task is `pending`/`in_progress` — it has no concept of `failed`. Once Task 3/4 teach the model to mark a step `failed` and stop, this function must also stop reporting `continueNeeded: true` for the OTHER still-pending tasks behind it — otherwise the Mac client's 0.8s "Continue working on your pending tasks" auto-continue reflex (`CodeAssistantPanel+Session.swift`'s `finishStreamingTurn`) fires again and pushes the model straight past the failure it was just told to stop at.

- [ ] **Step 1: Write the failing tests**

```javascript
// extension/tests/session-tasks.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionTaskStore } from '../llm_agent/runtime/handlers/session-tasks.mjs';

test('hasPendingWork is true while a task is pending', () => {
  const store = sessionTaskStore();
  store.createTask('u1', 's1', 'Do the thing');
  assert.equal(store.hasPendingWork('u1', 's1'), true);
});

test('hasPendingWork is true while a task is in_progress', () => {
  const store = sessionTaskStore();
  const t = store.createTask('u1', 's2', 'Do the thing');
  store.updateTask('u1', 's2', t.id, { status: 'in_progress' });
  assert.equal(store.hasPendingWork('u1', 's2'), true);
});

test('hasPendingWork is false once all tasks are completed or skipped', () => {
  const store = sessionTaskStore();
  const a = store.createTask('u1', 's3', 'A');
  const b = store.createTask('u1', 's3', 'B');
  store.updateTask('u1', 's3', a.id, { status: 'completed' });
  store.updateTask('u1', 's3', b.id, { status: 'skipped' });
  assert.equal(store.hasPendingWork('u1', 's3'), false);
});

test('hasPendingWork is false once any task has failed, even with other tasks still pending', () => {
  const store = sessionTaskStore();
  const a = store.createTask('u1', 's4', 'A — will fail');
  store.createTask('u1', 's4', 'B — still pending behind the failure');
  store.updateTask('u1', 's4', a.id, { status: 'failed' });
  assert.equal(store.hasPendingWork('u1', 's4'), false);
});

test('sessions are isolated by userId:sessionId key', () => {
  const store = sessionTaskStore();
  const t = store.createTask('u1', 'sA', 'A');
  store.updateTask('u1', 'sA', t.id, { status: 'failed' });
  // A different session must not see the other session's failure.
  store.createTask('u2', 'sB', 'B');
  assert.equal(store.hasPendingWork('u2', 'sB'), true);
});
```

- [ ] **Step 2: Run the tests to verify the last one fails**

Run: `cd extension && node --test tests/session-tasks.test.mjs`
Expected: 4 pass, 1 FAIL (`hasPendingWork is false once any task has failed...`) — today's implementation ignores `failed` entirely and would return `true` because task B is still `pending`.

- [ ] **Step 3: Fix `hasPendingWork`**

In `extension/llm_agent/runtime/handlers/session-tasks.mjs`, replace:

```javascript
    hasPendingWork(userId, sessionId) {
      const tasks = store.get(key(userId, sessionId)) ?? [];
      return tasks.some((t) => t.status === 'pending' || t.status === 'in_progress');
    },
```

with:

```javascript
    hasPendingWork(userId, sessionId) {
      const tasks = store.get(key(userId, sessionId)) ?? [];
      // A failed task means the agent was told to stop and ask, not push
      // through the remaining list — so a failure anywhere in the session's
      // tasks overrides any OTHER task still sitting at pending/in_progress.
      if (tasks.some((t) => t.status === 'failed')) return false;
      return tasks.some((t) => t.status === 'pending' || t.status === 'in_progress');
    },
```

- [ ] **Step 4: Run the tests to verify they all pass**

Run: `cd extension && node --test tests/session-tasks.test.mjs`
Expected: 5 pass.

- [ ] **Step 5: Commit**

```bash
cd /Users/dinesh.malla/llm-ide
git add extension/llm_agent/runtime/handlers/session-tasks.mjs extension/tests/session-tasks.test.mjs
git commit -m "fix(server): stop auto-continue once any session task is marked failed"
```

---

### Task 2: Extract `taskStatusIcon` and add a `failed` glyph

**Files:**
- Modify: `extension/llm_agent/runtime/handlers/session-tasks.mjs`
- Modify: `extension/llm_agent/runtime/route.mjs`
- Test: `extension/tests/session-tasks.test.mjs`

The task-list block injected into the model's own prompt (`route.mjs:192-201`, `## Your current task list`) computes its `[x]`/`[~]`/`[-]`/`[ ]` icon inline with a ternary chain that has no `failed` case. Extracting it into a small exported function makes it unit-testable without spinning up the whole route handler (same reasoning as `parseClaudeStreamJSON` in the streaming plan).

- [ ] **Step 1: Write the failing test**

Append to `extension/tests/session-tasks.test.mjs`:

```javascript
import { taskStatusIcon } from '../llm_agent/runtime/handlers/session-tasks.mjs';

test('taskStatusIcon maps every status to its legend glyph', () => {
  assert.equal(taskStatusIcon('pending'), '[ ]');
  assert.equal(taskStatusIcon('in_progress'), '[~]');
  assert.equal(taskStatusIcon('completed'), '[x]');
  assert.equal(taskStatusIcon('skipped'), '[-]');
  assert.equal(taskStatusIcon('failed'), '[!]');
  assert.equal(taskStatusIcon('something-unknown'), '[ ]');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd extension && node --test tests/session-tasks.test.mjs`
Expected: FAIL — `taskStatusIcon is not a function` (not exported yet).

- [ ] **Step 3: Add `taskStatusIcon` to `session-tasks.mjs`**

Add near the top of `extension/llm_agent/runtime/handlers/session-tasks.mjs`, before `sessionTaskStore`:

```javascript
/**
 * Legend glyph for a task's status, used both in the prompt block the model
 * sees (`route.mjs`) and anywhere else a compact text rendering is needed.
 * An unrecognised status renders as pending rather than throwing — a stray
 * status string must never break prompt construction.
 */
export function taskStatusIcon(status) {
  switch (status) {
    case 'completed': return '[x]';
    case 'skipped': return '[-]';
    case 'in_progress': return '[~]';
    case 'failed': return '[!]';
    default: return '[ ]';
  }
}
```

- [ ] **Step 4: Wire it into `route.mjs`**

In `extension/llm_agent/runtime/route.mjs`, change the import (line 24):

```javascript
import { tasks } from './handlers/session-tasks.mjs';
```

to:

```javascript
import { tasks, taskStatusIcon } from './handlers/session-tasks.mjs';
```

Then replace lines 196-200:

```javascript
    const taskLines = sessionTasks.map((t) => {
      const icon = t.status === 'completed' ? '[x]' : t.status === 'skipped' ? '[-]' : t.status === 'in_progress' ? '[~]' : '[ ]';
      return `- ${icon} (id:${t.id}) ${t.title}`;
    }).join('\n');
    personaBase += `\n\n## Your current task list\n${taskLines}\n\nLegend: [ ] pending  [~] in_progress  [x] completed  [-] skipped`;
```

with:

```javascript
    const taskLines = sessionTasks.map((t) => `- ${taskStatusIcon(t.status)} (id:${t.id}) ${t.title}`).join('\n');
    personaBase += `\n\n## Your current task list\n${taskLines}\n\nLegend: [ ] pending  [~] in_progress  [x] completed  [-] skipped  [!] failed`;
```

- [ ] **Step 5: Run the test file, then the full server suite**

Run: `cd extension && node --test tests/session-tasks.test.mjs`
Expected: 6 pass.

Run: `cd extension && npm test 2>&1 | tail -20`
Expected: all tests pass (no other file references the old inline ternary).

- [ ] **Step 6: Commit**

```bash
git add extension/llm_agent/runtime/handlers/session-tasks.mjs extension/llm_agent/runtime/route.mjs extension/tests/session-tasks.test.mjs
git commit -m "feat(server): extract taskStatusIcon, add a failed glyph to the task-list prompt block"
```

---

### Task 3: Teach `task-update` about the `failed` status

**Files:**
- Modify: `extension/llm_agent/global/task-update.md`

This is the tool-schema file the model reads (`enum: [pending, in_progress, completed, skipped]`, `task-update.md:12`) — `session-tasks.mjs`'s `updateTask` (already read during planning) sets `task.status = status` verbatim with no enum enforcement of its own, so the model choosing `"failed"` will flow straight through once it's told the option exists here.

- [ ] **Step 1: Add `failed` to the schema enum**

In `extension/llm_agent/global/task-update.md`, change:

```yaml
  status:
    type: string
    required: false
    enum: [pending, in_progress, completed, skipped]
    description: New status for the task
```

to:

```yaml
  status:
    type: string
    required: false
    enum: [pending, in_progress, completed, skipped, failed]
    description: New status for the task
```

- [ ] **Step 2: Document when to use it**

In the same file, change:

```markdown
## When to use

- Mark a task `in_progress` when you start it.
- Mark it `completed` when you finish it.
- Mark it `skipped` if it turns out not to be needed.
```

to:

```markdown
## When to use

- Mark a task `in_progress` when you start it.
- Mark it `completed` when you finish it.
- Mark it `skipped` if it turns out not to be needed.
- Mark it `failed` if the tool result for this task indicates an error (a
  non-zero exit code, a rejected API call, an exception). Do this INSTEAD of
  `completed` — never mark a task completed when its result was actually a
  failure. After marking a task failed, the system stops offering you the
  remaining pending tasks automatically; see the "Multi-turn autonomous work"
  rules for what to do next.
```

- [ ] **Step 3: Verify the file still loads without error**

Run: `cd extension && node -e "import('./llm_agent/skills/index.mjs').then(m => m.globalSkills()).then(s => console.log(s.find(x => x.name === 'task-update') ? 'task-update loaded OK' : 'MISSING'))"`
Expected: `task-update loaded OK`. (If `globalSkills` isn't the right entry point, run `grep -rn "globalSkills\|loadSkillFile\|task-update.md" extension/llm_agent/skills/*.mjs` first to find the actual loader function and adjust the command — the point of this step is confirming the YAML frontmatter still parses, not the exact invocation.)

- [ ] **Step 4: Commit**

```bash
git add extension/llm_agent/global/task-update.md
git commit -m "feat(server): add a failed status to the task-update tool schema"
```

---

### Task 4: Prompt rules — stop and ask on failure, close with a real summary

**Files:**
- Modify: `extension/llm_agent/global/prompt.md`

`prompt.md:86-96` ("Multi-turn autonomous work") already tells the model to keep going without asking permission and to report at the end — that's most of what the user asked for. Two things are missing: explicit failure handling, and a stronger bar for what "report naturally" means at the very end.

- [ ] **Step 1: Add a failure-handling rule and strengthen the final report rule**

In `extension/llm_agent/global/prompt.md`, replace the numbered list at lines 90-94:

```markdown
2. **Track progress.** Before starting a task call `task-update` with `status: "in_progress"`. When done, call `task-update` with `status: "completed"`.
3. **Keep going.** After completing a task, immediately start the next pending one in the same turn. The system auto-continues turns when tasks remain — you don't need to ask the user for permission to continue.
4. **Report naturally.** At the end of each turn, briefly describe what you just did and what's next. The user sees a live task list.
5. **Stop when done.** When all tasks are `completed` or `skipped`, your final turn says so and the auto-continue stops.
```

with:

```markdown
2. **Track progress.** Before starting a task call `task-update` with `status: "in_progress"`. When done, call `task-update` with `status: "completed"`.
3. **Keep going.** After completing a task, immediately start the next pending one in the same turn. The system auto-continues turns when tasks remain — you don't need to ask the user for permission to continue.
4. **Stop and ask on failure.** If a tool result for the current task indicates an error (non-zero exit code, a rejected API call, a thrown exception), call `task-update` with `status: "failed"` — do not mark it `completed` and do not start the next pending task. Explain what failed, why, and what you'd suggest next, then end your turn and wait for the user. The system will not auto-continue once a task is `failed`. Never automatically retry a failed step.
5. **Report naturally.** At the end of each turn, briefly describe what you just did and what's next. The user sees a live task list.
6. **Stop when done.** When all tasks are `completed`, `skipped`, or one is `failed`, your final turn is a proper close-out, not a one-liner: a short, professional summary of what changed (files touched, commands run and their results, PRs/issues created), followed by any suggested follow-ups. Treat it the way you'd write a final status update to a colleague, not a running commentary.
```

- [ ] **Step 2: Sanity-check the file still parses as valid Markdown with no broken references**

Run: `cd extension && node -e "import('fs').then(fs => { const t = fs.readFileSync('llm_agent/global/prompt.md','utf8'); console.log(t.includes('Stop and ask on failure') && t.includes('professional summary') ? 'OK' : 'MISSING TEXT'); })"`
Expected: `OK`.

- [ ] **Step 3: Commit**

```bash
git add extension/llm_agent/global/prompt.md
git commit -m "feat(server): prompt rules for stop-and-ask on task failure + a real close-out summary"
```

---

### Task 5: `AgentTask.status` becomes a real enum, with a `failed` case

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Agent/Models/AgentTypes.swift`

Today `AgentTask.status` is a bare `String` (`"pending" | "in_progress" | "completed" | "skipped"`, comment-documented only). There is no `AgentTask(...)` constructor anywhere in the Swift codebase other than `Decodable` synthesis from the server's JSON (verified via `grep -rn "AgentTask(" mac/Sources/LlmIdeMac/` — no matches), so this is a safe, additive type change.

- [ ] **Step 1: Replace the `status` field's type**

In `mac/Sources/LlmIdeMac/Agent/Models/AgentTypes.swift`, replace:

```swift
struct AgentTask: Codable, Identifiable {
    let id: String
    let title: String
    let status: String  // "pending" | "in_progress" | "completed" | "skipped"
}
```

with:

```swift
/// Mirrors the server's task-tracking status strings exactly (see
/// `extension/llm_agent/runtime/handlers/session-tasks.mjs`'s
/// `taskStatusIcon` and `task-update.md`'s schema enum) — the raw values
/// below are NOT freely renameable, they must match the wire strings.
enum AgentTaskStatus: String, Codable {
    case pending
    case inProgress = "in_progress"
    case completed
    case skipped
    case failed
}

struct AgentTask: Codable, Identifiable {
    let id: String
    let title: String
    let status: AgentTaskStatus
}
```

- [ ] **Step 2: Build to verify nothing else assumed `status` was a `String`**

Run: `swift build --package-path mac --product LlmIdeMac 2>&1 | tail -30`
Expected: `Build of product 'LlmIdeMac' complete!` (no call site compares `agentPendingTasks[...].status` against a raw string literal — confirmed via `grep -rn "\.status ==" mac/Sources/LlmIdeMac/ | grep -i task` turning up no matches before this change).

- [ ] **Step 3: Commit**

```bash
git add mac/Sources/LlmIdeMac/Agent/Models/AgentTypes.swift
git commit -m "feat(mac): AgentTask.status becomes AgentTaskStatus, adds a failed case"
```

---

### Task 6: `PlanTimelineCard` — render the task checklist

**Files:**
- Create: `mac/Sources/LlmIdeMac/Views/CodeAssistant/PlanTimelineCard.swift`
- Modify: `mac/Sources/LlmIdeMac/Views/CodeAssistant/ChatMessageList.swift`
- Modify: `mac/Sources/LlmIdeMac/Views/CodeAssistant/CodeAssistantPanel.swift`

`CodeAssistantAgentState.agentPendingTasks` is already populated by `finishStreamingTurn` every time the server sends a `tasks` field — it is simply never rendered anywhere today. This task only adds the view and wires it in; no new state.

- [ ] **Step 1: Write `PlanTimelineCard`**

```swift
// mac/Sources/LlmIdeMac/Views/CodeAssistant/PlanTimelineCard.swift
import SwiftUI

/// Live checklist for the current multi-step task, pinned above the
/// assistant's reply. Purely presentational — `tasks` is whatever the
/// server last sent in `CodeAssistantAgentState.agentPendingTasks`; this
/// view owns no state of its own and makes no decisions about auto-run or
/// failure handling (that lives server-side, see
/// docs/superpowers/plans/2026-08-09-code-assistant-plan-execution-phase1.md).
struct PlanTimelineCard: View {
    let tasks: [AgentTask]
    @EnvironmentObject var theme: ThemeStore

    private var isRunning: Bool {
        tasks.contains { $0.status == .pending || $0.status == .inProgress }
    }

    private var doneCount: Int {
        tasks.filter { $0.status == .completed || $0.status == .skipped || $0.status == .failed }.count
    }

    private func icon(for status: AgentTaskStatus) -> (name: String, color: Color) {
        switch status {
        case .pending: return ("circle", theme.current.textMuted)
        case .inProgress: return ("arrow.triangle.2.circlepath", theme.current.accent)
        case .completed: return ("checkmark.circle.fill", theme.current.success)
        case .skipped: return ("minus.circle", theme.current.textMuted)
        case .failed: return ("xmark.circle.fill", theme.current.danger)
        }
    }

    var body: some View {
        if isRunning {
            VStack(alignment: .leading, spacing: 6) {
                ForEach(tasks) { task in
                    let (name, color) = icon(for: task.status)
                    HStack(spacing: 6) {
                        Image(systemName: name)
                            .font(.system(size: 11))
                            .foregroundStyle(color)
                        Text(task.title)
                            .font(.system(size: 12))
                            .foregroundStyle(task.status == .pending ? theme.current.textMuted : theme.current.text)
                            .lineLimit(1)
                            .truncationMode(.tail)
                        Spacer(minLength: 0)
                    }
                }
            }
            .padding(10)
            .background(theme.current.surface)
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(theme.current.border, lineWidth: 1))
            .cornerRadius(8)
            .frame(maxWidth: 720, alignment: .leading)
        } else {
            HStack(spacing: 6) {
                let failed = tasks.contains { $0.status == .failed }
                Image(systemName: failed ? "exclamationmark.triangle.fill" : "checkmark.circle.fill")
                    .font(.system(size: 10))
                    .foregroundStyle(failed ? theme.current.danger : theme.current.success)
                Text("\(doneCount)/\(tasks.count) steps complete")
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(theme.current.textMuted)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background(theme.current.surface2)
            .clipShape(Capsule())
        }
    }
}
```

- [ ] **Step 2: Add a `tasks` parameter to `ChatMessageList` and render the card**

In `mac/Sources/LlmIdeMac/Views/CodeAssistant/ChatMessageList.swift`, add a new property near the other plain lets (after `let pendingTool: PendingTool?` at line 12):

```swift
    let pendingTool: PendingTool?
    /// Current multi-step task list — `CodeAssistantAgentState.agentPendingTasks`,
    /// rendered as a live checklist above the latest assistant turn.
    let tasks: [AgentTask]
```

Then in the `ForEach(history)` loop (lines 55-58), insert the card immediately before `turnView(turn)`:

```swift
                        ForEach(history) { turn in
                            if turn.role == .assistant, turn.id == lastAssistantTurnId, !tasks.isEmpty {
                                PlanTimelineCard(tasks: tasks)
                                    .padding(.bottom, 4)
                                    .transition(.opacity)
                            }
                            turnView(turn)
                                .id(turn.id)
                                .transition(.opacity.combined(with: .scale(scale: 0.97, anchor: .bottom)))
```

- [ ] **Step 3: Pass `agent.agentPendingTasks` from the call site**

In `mac/Sources/LlmIdeMac/Views/CodeAssistant/CodeAssistantPanel.swift`, in the `ChatMessageList(...)` call (line 290), add the new argument after `pendingTool: agent.pendingTool,`:

```swift
            ChatMessageList(
                history: history,
                showModelPicker: showModelPicker,
                pendingTool: agent.pendingTool,
                tasks: agent.agentPendingTasks,
                busy: busy,
```

- [ ] **Step 4: Build to verify**

Run: `swift build --package-path mac --product LlmIdeMac 2>&1 | tail -30`
Expected: `Build of product 'LlmIdeMac' complete!`

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/Views/CodeAssistant/PlanTimelineCard.swift mac/Sources/LlmIdeMac/Views/CodeAssistant/ChatMessageList.swift mac/Sources/LlmIdeMac/Views/CodeAssistant/CodeAssistantPanel.swift
git commit -m "feat(mac): render agentPendingTasks as a live plan timeline checklist"
```

---

### Task 7: `DiffStats` — a small, shared line-diff summary

**Files:**
- Create: `mac/Sources/LlmIdeMac/Agent/Models/DiffStats.swift`

`UpdateFileSheet.swift` already has its own private `DiffRow`/`diffRows` (full row-by-row diff for the big sheet view, `CollectionDifference`-based) — deliberately left untouched per the spec's "tap opens the existing UpdateFileSheet, unchanged." This is a separate, smaller type: just `+N -M` counts and a few preview lines, for the compact card preview in Task 8. Duplicating ~15 lines of counting logic here is cheaper and lower-risk than reaching into the sheet's private view internals.

- [ ] **Step 1: Write the type**

```swift
// mac/Sources/LlmIdeMac/Agent/Models/DiffStats.swift
import Foundation

/// Compact line-diff summary for a pending-action preview (see
/// `PendingActionCard`'s `update-file` branch) — added/removed line counts
/// plus a handful of preview lines, computed with the same
/// `CollectionDifference` approach `UpdateFileSheet`'s own diff view uses,
/// kept as a separate small type rather than reusing that view's private
/// `DiffRow` (this only needs counts + a preview, not every row).
struct DiffStats {
    let added: Int
    let removed: Int
    let previewLines: [String]

    static func compute(old: String, new: String, previewLineCount: Int = 3) -> DiffStats {
        let oldLines = old.components(separatedBy: "\n")
        let newLines = new.components(separatedBy: "\n")
        let diff = newLines.difference(from: oldLines)
        var added = 0
        var removed = 0
        var preview: [String] = []
        for change in diff {
            switch change {
            case .insert(_, let line, _):
                added += 1
                if preview.count < previewLineCount { preview.append("+ \(line)") }
            case .remove(_, let line, _):
                removed += 1
                if preview.count < previewLineCount { preview.append("- \(line)") }
            }
        }
        return DiffStats(added: added, removed: removed, previewLines: preview)
    }
}
```

- [ ] **Step 2: Build to verify**

Run: `swift build --package-path mac --product LlmIdeMac 2>&1 | tail -20`
Expected: `Build of product 'LlmIdeMac' complete!` (new file, nothing references it yet — this just proves it compiles standalone).

- [ ] **Step 3: Commit**

```bash
git add mac/Sources/LlmIdeMac/Agent/Models/DiffStats.swift
git commit -m "feat(mac): add DiffStats, a compact line-diff summary for preview UI"
```

---

### Task 8: Inline diff preview on the `update-file` pending-action card

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Agent/Views/PendingActionCard.swift`
- Modify: `mac/Sources/LlmIdeMac/Views/CodeAssistant/ChatMessageList.swift`
- Modify: `mac/Sources/LlmIdeMac/Views/CodeAssistant/CodeAssistantPanel.swift`

The original file content needed for a diff isn't on `PendingTool` at all — it lives in the matching chat attachment, found via `CodeAssistantPanel.matchingAttachment(for:)`. That method only exists on `CodeAssistantPanel`, so the diff is computed there and threaded down as a plain, already-computed value — `ChatMessageList`/`PendingActionCard` don't need to know about attachments at all.

- [ ] **Step 1: Add a `diffPreview` parameter to `PendingActionCard`**

In `mac/Sources/LlmIdeMac/Agent/Views/PendingActionCard.swift`, add a new property after `let onOpen: () -> Void` (line 11):

```swift
    let onOpen: () -> Void
    /// Precomputed diff stats for the `update-file` variant — nil for every
    /// other tool, or when no attachment matched the proposed path (the
    /// card still shows, just without the preview; the full sheet's own
    /// guard is unaffected).
    var diffPreview: DiffStats?
```

Then, in the `updateFileArgs` branch (lines 55-63), add the preview below the existing "N lines proposed" text:

```swift
                    } else if let args = pendingTool.updateFileArgs {
                        Text(filenameSuffix(args.path))
                            .font(.system(size: 13, weight: .semibold))
                            .lineLimit(1)
                            .truncationMode(.middle)
                        Text("\(args.content.components(separatedBy: "\n").count) lines proposed")
                            .font(.system(size: 12))
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                        if let diff = diffPreview {
                            Text("+\(diff.added) −\(diff.removed)")
                                .font(.system(size: 11, weight: .medium, design: .monospaced))
                                .foregroundStyle(.secondary)
                            ForEach(Array(diff.previewLines.enumerated()), id: \.offset) { _, line in
                                Text(line)
                                    .font(.system(size: 10, design: .monospaced))
                                    .foregroundStyle(line.hasPrefix("+") ? .green : (line.hasPrefix("-") ? .red : .secondary))
                                    .lineLimit(1)
                                    .truncationMode(.tail)
                            }
                        }
```

- [ ] **Step 2: Thread `diffPreview` through `ChatMessageList`**

In `mac/Sources/LlmIdeMac/Views/CodeAssistant/ChatMessageList.swift`, add a property alongside `tasks` (added in Task 6):

```swift
    let tasks: [AgentTask]
    /// Precomputed diff stats for the current `update-file` pendingTool, if
    /// any — see CodeAssistantPanel.pendingUpdateFileDiff.
    let diffPreview: DiffStats?
```

Then update the `PendingActionCard` construction (lines 62-94) to pass it:

```swift
                                PendingActionCard(pendingTool: pt, diffPreview: diffPreview) {
```

- [ ] **Step 3: Compute the preview in `CodeAssistantPanel` and pass it down**

In `mac/Sources/LlmIdeMac/Views/CodeAssistant/CodeAssistantPanel.swift`, add a computed property near `matchingAttachment`'s call sites (anywhere in the `CodeAssistantPanel` struct body is fine — e.g. just above `baseContent`):

```swift
    /// Diff stats for the current `update-file` pendingTool, if the agent
    /// proposed one and its path matches an attached file. Computed once per
    /// render rather than inside `ChatMessageList` so that view stays free of
    /// attachment-matching logic.
    private var pendingUpdateFileDiff: DiffStats? {
        guard let args = agent.pendingTool?.updateFileArgs,
              let match = matchingAttachment(for: args.path) else { return nil }
        return DiffStats.compute(old: match.content, new: args.content)
    }
```

Then add the argument to the `ChatMessageList(...)` call (line 290):

```swift
            ChatMessageList(
                history: history,
                showModelPicker: showModelPicker,
                pendingTool: agent.pendingTool,
                tasks: agent.agentPendingTasks,
                diffPreview: pendingUpdateFileDiff,
                busy: busy,
```

- [ ] **Step 4: Build to verify**

Run: `swift build --package-path mac --product LlmIdeMac 2>&1 | tail -30`
Expected: `Build of product 'LlmIdeMac' complete!`

- [ ] **Step 5: Commit**

```bash
git add mac/Sources/LlmIdeMac/Agent/Views/PendingActionCard.swift mac/Sources/LlmIdeMac/Views/CodeAssistant/ChatMessageList.swift mac/Sources/LlmIdeMac/Views/CodeAssistant/CodeAssistantPanel.swift
git commit -m "feat(mac): compact inline diff preview on the update-file pending-action card"
```

---

### Task 9: Bash results carry the command line, not just output

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Views/CodeAssistant/CodeAssistant+Bash.swift`

`BashService.ExecutionResult` already has everything (`exitCode`, `stdout`, `stderr`, `duration`) — the gap is that `runBashCommand` never puts the actual command text into the chat turn, so nothing downstream (Task 10's view) can show `$ <command>`. This also standardizes the "no output" success message to include the exit code, matching the other two cases.

- [ ] **Step 1: Update the formatting**

In `mac/Sources/LlmIdeMac/Views/CodeAssistant/CodeAssistant+Bash.swift`, replace:

```swift
        let result = await bashService.execute(args.command, workingDirectory: args.workingDirectory)

        // Format the result for the chat
        let output: String
        if result.isSuccess {
            if result.output.isEmpty {
                output = "(bash completed successfully - no output)"
            } else {
                output = "(bash result - exit code: \(result.exitCode))\n\(result.output)"
            }
        } else {
            output = "(bash failed - exit code: \(result.exitCode))\n\(result.output)"
        }

        history.append(.init(role: .user, content: output))
```

with:

```swift
        let result = await bashService.execute(args.command, workingDirectory: args.workingDirectory)

        // Format the result for the chat. The header line (parsed back out by
        // CommandOutputView.parse) always carries the exit code so success and
        // failure render consistently; the command line lets the view show
        // "$ <command>" without needing a second, id-keyed channel.
        let header = result.isSuccess
            ? "(bash result - exit code: \(result.exitCode))"
            : "(bash failed - exit code: \(result.exitCode))"
        let body = result.output.isEmpty ? "(no output)" : result.output
        let output = "\(header)\n$ \(args.command)\n\(body)"

        history.append(.init(role: .user, content: output))
```

- [ ] **Step 2: Build to verify**

Run: `swift build --package-path mac --product LlmIdeMac 2>&1 | tail -20`
Expected: `Build of product 'LlmIdeMac' complete!`

- [ ] **Step 3: Commit**

```bash
git add mac/Sources/LlmIdeMac/Views/CodeAssistant/CodeAssistant+Bash.swift
git commit -m "feat(mac): include the command line in bash-result chat turns"
```

---

### Task 10: `CommandOutputView` — collapsible bash output block

**Files:**
- Create: `mac/Sources/LlmIdeMac/Views/CodeAssistant/CommandOutputView.swift`
- Modify: `mac/Sources/LlmIdeMac/Views/CodeAssistant/ChatMessageList.swift`

Bash-result turns are the plain-text `(bash ...)`-prefixed convention `isToolNotice`/`toolNoticeView` already parse for their icon (`ChatMessageList.swift:236-245`). This task adds a second, richer parse for specifically bash turns and renders `CommandOutputView` instead of the generic capsule when it matches; every other tool notice (issue created, git op result, etc.) is unaffected.

- [ ] **Step 1: Write `CommandOutputView` and its parser**

```swift
// mac/Sources/LlmIdeMac/Views/CodeAssistant/CommandOutputView.swift
import SwiftUI

/// Parsed view of a bash-result chat turn, produced by
/// `CodeAssistant+Bash.swift`'s `"(bash result - exit code: N)\n$ <command>\n<output>"`
/// convention (also matches the `"(bash failed - ...)"` / `"(bash blocked - ...)"`
/// variants). Returns nil for anything that isn't a bash-result turn, so
/// `ChatMessageList` can fall back to the generic tool-notice capsule.
struct BashResultDisplay {
    let exitCode: Int?
    let isFailure: Bool
    let command: String?
    let output: String

    static func parse(_ content: String) -> BashResultDisplay? {
        guard content.hasPrefix("(bash ") else { return nil }
        var lines = content.components(separatedBy: "\n")
        guard !lines.isEmpty else { return nil }
        let header = lines.removeFirst()
        let isFailure = header.contains("failed") || header.contains("blocked")
        var exitCode: Int?
        if let range = header.range(of: "exit code: ") {
            let digits = header[range.upperBound...].prefix { $0.isNumber || $0 == "-" }
            exitCode = Int(digits)
        }
        var command: String?
        if let first = lines.first, first.hasPrefix("$ ") {
            command = String(first.dropFirst(2))
            lines.removeFirst()
        }
        return BashResultDisplay(exitCode: exitCode, isFailure: isFailure, command: command, output: lines.joined(separator: "\n"))
    }
}

/// Collapsible command-output block: always shows the command line and a
/// status glyph; output collapses to the first few lines with a "Show full
/// output" toggle, so a long build/test log doesn't dominate the transcript.
struct CommandOutputView: View {
    let display: BashResultDisplay
    @EnvironmentObject var theme: ThemeStore
    @State private var expanded = false

    private let collapsedLineCount = 6

    private var outputLines: [String] {
        display.output.components(separatedBy: "\n")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let command = display.command {
                Text("$ \(command)")
                    .font(.system(size: 11, weight: .medium, design: .monospaced))
                    .foregroundStyle(theme.current.text)
                    .textSelection(.enabled)
            }
            HStack(spacing: 4) {
                Image(systemName: display.isFailure ? "xmark.circle.fill" : "checkmark.circle.fill")
                    .font(.system(size: 10))
                    .foregroundStyle(display.isFailure ? theme.current.danger : theme.current.success)
                Text(display.exitCode.map { "exit \($0)" } ?? (display.isFailure ? "failed" : "done"))
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(theme.current.textMuted)
            }
            if !display.output.isEmpty {
                let shown = expanded ? outputLines : Array(outputLines.prefix(collapsedLineCount))
                Text(shown.joined(separator: "\n"))
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(theme.current.textMuted)
                    .textSelection(.enabled)
                if outputLines.count > collapsedLineCount {
                    Button(expanded ? "Show less" : "Show full output") { expanded.toggle() }
                        .buttonStyle(.plain)
                        .font(.system(size: 10))
                        .foregroundStyle(theme.current.accent)
                }
            }
        }
        .padding(8)
        .frame(maxWidth: 720, alignment: .leading)
        .background(theme.current.surface2)
        .cornerRadius(6)
    }
}
```

- [ ] **Step 2: Route bash-result turns to it in `ChatMessageList`**

In `mac/Sources/LlmIdeMac/Views/CodeAssistant/ChatMessageList.swift`, change the `turnView` function's tool-notice branch (line 269-270):

```swift
    private func turnView(_ turn: LlmIdeAPIClient.CodeAssistTurn) -> some View {
        if isToolNotice(turn) {
            toolNoticeView(turn)
        } else {
```

to:

```swift
    private func turnView(_ turn: LlmIdeAPIClient.CodeAssistTurn) -> some View {
        if isToolNotice(turn) {
            if let bash = BashResultDisplay.parse(turn.content) {
                CommandOutputView(display: bash)
            } else {
                toolNoticeView(turn)
            }
        } else {
```

- [ ] **Step 3: Build to verify**

Run: `swift build --package-path mac --product LlmIdeMac 2>&1 | tail -30`
Expected: `Build of product 'LlmIdeMac' complete!`

- [ ] **Step 4: Commit**

```bash
git add mac/Sources/LlmIdeMac/Views/CodeAssistant/CommandOutputView.swift mac/Sources/LlmIdeMac/Views/CodeAssistant/ChatMessageList.swift
git commit -m "feat(mac): render bash results as a collapsible command-output block"
```

---

### Task 11: Fix the missing `update-file` auto-chain in `sendFollowup`

**Files:**
- Modify: `mac/Sources/LlmIdeMac/Views/CodeAssistant/CodeAssistantPanel+Session.swift`

This is the real "run steps one by one until goal" gap. `runTurn`'s tail (lines 168-190) auto-applies an `update-file` pendingTool in Auto edit mode AND auto-runs a `git-op`; `sendFollowup`'s tail (lines 454-464) only re-checks `git-op`. A plan with two file edits back-to-back — "update A, then update B" — auto-applies A (from `runTurn`), but the follow-up round-trip that then proposes updating B stalls on the pending-action card instead of continuing, because `sendFollowup` never re-checks `updateFileArgs`.

- [ ] **Step 1: Add the missing check**

In `mac/Sources/LlmIdeMac/Views/CodeAssistant/CodeAssistantPanel+Session.swift`, replace the tail of `sendFollowup` (lines 454-464):

```swift
        // Chain the NEXT git op hands-free when allowed — this is what lets
        // "commit and push" finish without a card: commit auto-runs on the
        // primary turn, the agent then proposes push on this follow-up, and we
        // auto-run it too. runGitOpFlow resets `busy = false` itself before its
        // own sendFollowup, so the re-entry isn't blocked by the `guard !busy`
        // even though our `busy` is still true here. The recursion (and so any
        // looping agent) is bounded by autoGitOpsThisTurn.
        if let g = agent.pendingTool?.gitOpArgs, shouldAutoRunGitOp(g) {
            autoGitOpsThisTurn += 1
            await runGitOpFlow(g)
        }
    }
```

with:

```swift
        // Chain the NEXT step hands-free when allowed — this is what lets a
        // multi-step plan (e.g. "update A, then update B" or "commit and
        // push") finish without a card for every step. Mirrors runTurn's own
        // auto-apply/auto-run checks; without this, only the FIRST step of a
        // plan (checked in runTurn) would auto-run and every step after it
        // would stall on a pending-action card even in Auto edit mode.
        if editMode == .auto, let pt = agent.pendingTool, let args = pt.updateFileArgs {
            // confirmUpdateFile does its own exact-path matching and safely
            // returns .failure (leaving the card up) if nothing matches —
            // same discard-the-result pattern runTurn's own auto-apply uses.
            _ = await confirmUpdateFile(args, finalContent: args.content)
        } else if let g = agent.pendingTool?.gitOpArgs, shouldAutoRunGitOp(g) {
            // runGitOpFlow resets `busy = false` itself before its own
            // sendFollowup, so the re-entry isn't blocked by the `guard !busy`
            // even though our `busy` is still true here. The recursion (and
            // so any looping agent) is bounded by autoGitOpsThisTurn.
            autoGitOpsThisTurn += 1
            await runGitOpFlow(g)
        }
    }
```

- [ ] **Step 2: Build to verify**

Run: `swift build --package-path mac --product LlmIdeMac 2>&1 | tail -30`
Expected: `Build of product 'LlmIdeMac' complete!`

- [ ] **Step 3: Manual verification (no XCTest available in this environment — established limitation)**

Run the server locally (`cd extension && node server.mjs`) and the Mac app in Auto edit mode. Attach two files, and ask for a change that touches both (e.g. "rename `foo` to `bar` in both A.swift and B.swift"). Confirm BOTH edits apply without either one showing a pending-action card, and that the plan timeline (Task 6) shows both steps reaching the completed glyph.

- [ ] **Step 4: Commit**

```bash
git add mac/Sources/LlmIdeMac/Views/CodeAssistant/CodeAssistantPanel+Session.swift
git commit -m "fix(mac): auto-chain update-file (not just git-op) in sendFollowup

A multi-file-edit plan previously stalled on a pending-action card
after the first file, even in Auto edit mode, because sendFollowup's
tail only re-checked gitOpArgs."
```

---

### Task 12: Full regression pass

**Files:** none (verification only)

- [ ] **Step 1: Full server test suite**

Run: `cd extension && npm test 2>&1 | tail -30`
Expected: all tests pass, including the new `session-tasks.test.mjs`.

- [ ] **Step 2: Server lint**

Run: `cd extension && npx eslint llm_agent/runtime/handlers/session-tasks.mjs llm_agent/runtime/route.mjs tests/session-tasks.test.mjs`
Expected: no output (clean).

- [ ] **Step 3: Mac build**

Run: `swift build --package-path mac --product LlmIdeMac 2>&1 | tail -20`
Expected: `Build of product 'LlmIdeMac' complete!`

- [ ] **Step 4: Manual verification checklist** (no XCTest in this environment — this is the verification of record for the Mac side)

Run the server locally and the Mac app, then check:
- [ ] Give Code Assistant a multi-step task (e.g. "search for TODOs in this repo, then summarize them"). The plan timeline card appears above the reply, steps flip from ○ to ⟳ to ✓ as round-trips complete, and it collapses to "N/N steps complete" once done.
- [ ] Force a failing step (e.g. ask it to run a command you know will fail, like `exit 1`, or reference a nonexistent file). Confirm: the task shows ✗, no further steps auto-run, and the model's final message explains the failure and asks how to proceed — not a "Continue working on your pending tasks" auto-continue.
- [ ] A successful bash command renders as a collapsible `$ command` block with an exit-code glyph; a command with long output shows "Show full output" and expands correctly.
- [ ] An `update-file` pending-action card shows the `+N −M` line-count summary and a few preview lines before you tap it; tapping still opens the full, unchanged `UpdateFileSheet`.
- [ ] In Auto edit mode, a two-file edit plan applies both files without either showing a card (Task 11's fix).
- [ ] The final assistant message after a fully-completed multi-step plan reads as an actual summary (what changed, what ran, results) rather than a one-line "Done."

- [ ] **Step 5: Commit any final fixes found during manual verification, or confirm clean**

```bash
git status --short
```

---

## Self-Review Notes (from the plan author, not a task to execute)

- **Spec coverage**: all of Phase 1's spec components map to a task — task-status data model (Task 5), plan timeline UI (Task 6), diff preview (Tasks 7-8), command output blocks (Tasks 9-10), auto-continue/stop-on-failure (Tasks 1-4, 11), regression (Task 12). Phase 1's originally-spec'd "server bash-result wire shape" item is intentionally NOT a task — Task 9's exploration found bash runs entirely client-side, so there is no wire shape to change.
- **Type consistency checked**: `AgentTaskStatus`'s raw values (Task 5) match exactly what `taskStatusIcon` (Task 2) and `task-update.md`'s schema enum (Task 3) emit/accept — `pending`, `in_progress`, `completed`, `skipped`, `failed`. `PlanTimelineCard` (Task 6) and `sendFollowup`'s new check (Task 11) both switch on the same five cases. `DiffStats.compute` (Task 7)'s signature (`old:new:previewLineCount:`) matches exactly how Task 8 calls it (`old: match.content, new: args.content`). `BashResultDisplay.parse` (Task 10)'s expected input format matches exactly what Task 9 produces (`"(bash ... exit code: N)\n$ <command>\n<output>"`).
- **No placeholders**: every step shows the real diff against code read directly from the repository during planning (line numbers cited throughout are from the current `main` branch as of 2026-08-09); no step says "add appropriate handling" without showing the handling.
- **Deferred to Phase 2's own plan** (not this one): mode picker, auto-classification, Plan/Review/Document routing, per-step skill auto-routing — per the spec's own phasing, and because that plan should account for however Phase 1's task-list rendering actually behaves once merged, not the current speculative shape.
