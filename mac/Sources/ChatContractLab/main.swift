import Foundation
import LlmIdeMacLib

// An executable assertion gate for the Chat slice.
//
// This exists for the same reason graph-layout-lab and graph-engine-lab do:
// a Command-Line-Tools-only toolchain has no XCTest, so `swift test` cannot
// run (see the Makefile's HAS_XCTEST guard). `swift run` works regardless, so
// pure logic extracted out of ChatEngine is asserted here instead.
//
// Consequence for the code under test: this is a SEPARATE target, so it sees
// only `public` symbols of LlmIdeMacLib — `@testable import` is available to
// test targets only. Types asserted here are therefore declared public.

var failures: [String] = []

/// Assert `condition`, recording `label` on failure.
func expect(_ condition: Bool, _ label: String) {
    if condition {
        print("  ok   \(label)")
    } else {
        failures.append(label)
        print("  FAIL \(label)")
    }
}

// `--decode <dir>`: the Swift half of scripts/conformance-agent-v2.mjs. Prints
// one JSON line per fixture saying whether it decoded and which fields the
// Swift types actually kept. Exits 0 even on a decode failure — the Node runner
// owns the pass/fail policy, this mode only reports.
if CommandLine.arguments.count >= 3, CommandLine.arguments[1] == "--decode" {
    let dir = URL(fileURLWithPath: CommandLine.arguments[2])
    let files = ((try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? [])
        .filter { $0.hasSuffix(".json") }
        .sorted()
    for name in files {
        let url = dir.appendingPathComponent(name)
        guard let data = try? Data(contentsOf: url) else {
            print(#"{"file":"\#(name)","decoded":false,"error":"unreadable"}"#)
            continue
        }
        if let captured = AgentV2Conformance.fieldReport(forJSON: data) {
            let list = captured.sorted().map { "\"\($0)\"" }.joined(separator: ",")
            print(#"{"file":"\#(name)","decoded":true,"captured":[\#(list)]}"#)
        } else {
            print(#"{"file":"\#(name)","decoded":false,"error":"AgentV2Event.decode returned nil"}"#)
        }
    }
    exit(0)
}

print("chat-contract-lab")

#if FEATURE_GRAPH
// Graph detail policy: does a node show its own body, or its file?
//
// Wrapped in #if because `Graph/` is build-excludable — in build-mac-lite/min
// these types do not exist. The lab target gets the same `featureDefines` as the
// library so the block simply vanishes there.
//
// The rule had lived as a `private` method on a View since the repo's initial
// commit, reachable by no test, which is how it came to exclude `.memoryDoc`
// unnoticed: selecting a .md document in the graph showed no content at all.
do {
    let inline = GraphNodeDisplayPolicy.rendersOwnBodyInline(kindRawValue:)

    expect(inline("memoryChunk") == true,
           "a chunk is a SECTION of a document, so it renders its own body")
    expect(inline("memoryDoc") == false,
           "a doc IS the whole file, so it renders in the file viewer")

    // Everything else names a file, or a place in one — both belong to the viewer.
    for kind in ["file", "docPage", "symbol", "function", "classType", "module", "noteFact"] {
        expect(inline(kind) == false, "\(kind) renders its file, not an inline body")
    }

    expect(inline("notAKind") == nil, "an unknown kind is nil, not a silent false")
}
#endif

// Markdown escaping — the security control, not a formatting nicety.
//
// The document body is LLM-authored text about the user's private source, and it
// is embedded inside a JS template literal (`const raw = \`…\``) in a page the
// WKWebView executes. A raw backtick or ${…} would break out of that literal.
// MarkdownRendererEscapingTests asserts exactly this and has never run once —
// it is a swift-testing file on a toolchain with no XCTest.
do {
    let line = GenerationConformance.renderedTemplateLiteralLine(for: "a ` b ${c} d \\ e")
    expect(line != nil, "the rendered document has a template-literal line to inspect")
    expect(line?.contains("\\`") == true, "a backtick is escaped, so it cannot close the literal")
    expect(line?.contains("\\${c}") == true, "${…} is escaped, so it cannot interpolate")

    // `</script` ends the HTML script-data state regardless of JS string
    // context, so it has to be broken up in the SOURCE.
    let closing = GenerationConformance.renderedTemplateLiteralLine(for: "</script>")
    expect(closing?.contains("</script") == false, "no literal </script sequence survives into the page")

    // The escaping runs over the WHOLE body before fences are parsed, so a
    // diagram's source is covered by the same rule — but it lands on a LATER
    // line of the literal, which is why this checks the full document rather
    // than the `const raw = ` line. (Asserting on that line alone reported a
    // failure that was my mistake, not the renderer's.)
    let fenced = GenerationConformance.renderedHTML(for: "```mermaid\nA-->B `x` ${y}\n```")
    expect(fenced.contains("\\`x\\`"), "a backtick inside a mermaid fence is escaped too")
    expect(fenced.contains("\\${y}"), "${…} inside a mermaid fence is escaped too")
}

// Markdown preview gating. The generated doc is where a ```mermaid dependency
// graph turns up, but the same renderer draws every chat reply — where an async
// diagram would land after the synchronous height measurement.
do {
    let withFence = "# Doc\n\n```mermaid\ngraph TD\n  A-->B\n```\n"
    let withoutFence = "# Doc\n\n```swift\nlet x = 1\n```\n"

    expect(GenerationConformance.detectsMermaidFence(withFence), "a mermaid fence is detected")
    expect(!GenerationConformance.detectsMermaidFence(withoutFence), "a swift fence is not mistaken for mermaid")

    // THE invariant: opting out keeps mermaid out, fence or no fence.
    expect(!GenerationConformance.previewShipsMermaid(markdown: withFence, enabled: false),
           "chat's renderer ships no mermaid even when the text contains a diagram")

    // And opting in does not ship 3.4 MB to a document that has no diagram.
    expect(!GenerationConformance.previewShipsMermaid(markdown: withoutFence, enabled: true),
           "a document with no diagram ships no mermaid even when enabled")

    // …and the positive case, so the assertions above cannot all be satisfied
    // by the feature simply never working.
    expect(GenerationConformance.previewShipsMermaid(markdown: withFence, enabled: true),
           "the generation preview DOES ship mermaid for a document with a diagram")
}

// GenerationRegistry — a running generation must outlive the view that started
// it. The reported bug was that leaving the Doc Gen section and coming back
// showed "not generating" while the server had actually finished the job: the
// view owned the model via @StateObject, so returning built a brand new one.
// The registry is @MainActor; top-level code here runs on the main thread but is
// not statically isolated, so state that fact rather than hopping.
MainActor.assumeIsolated {
    expect(GenerationConformance.sameModelAcrossVisits(scope: "docGen"),
           "the same scope returns the SAME model across view teardown and rebuild")
    expect(GenerationConformance.sameModelAcrossVisits(scope: "visual"),
           "the visual surface behaves the same way")
    expect(GenerationConformance.distinctModelsPerScope(),
           "Doc Gen and Visual get DIFFERENT models, so both can generate at once")
    expect(GenerationConformance.resetDropsModels(),
           "reset() clears them, so sign-out starts clean")
}

// ToolStepMergePolicy — the regression that widening the v2 progress event
// caused, and the reason recordProgress can no longer dedupe on label alone.
do {
    let d = ToolStepMergePolicy.decide

    // v2: a call opens, then finishes. ONE row, completed in place.
    expect(d(nil, nil, false, "Read", "Reading", false) == .append,
           "the first step of a turn is appended")
    expect(d("Read", "Reading", false, "Read", "Reading Foo.swift", true) == .completeLast,
           "the result for the open step completes it rather than adding a second row")

    // The exact shape that regressed: same tool, diverging labels, result
    // present. Before the fix this fell through to .append and every v2 tool
    // call persisted two rows.
    expect(d("Read", "Reading", false, "Read", "Reading Foo.swift", true) != .append,
           "a result never appends a second row for the call it belongs to")

    // Legacy: never carries a result, so only the original label-dedupe can fire.
    expect(d("read-file", "Reading a.swift", false, "read-file", "Reading a.swift", false) == .ignore,
           "a back-to-back legacy repeat is still ignored")
    expect(d("read-file", "Reading a.swift", false, "read-file", "Reading b.swift", false) == .append,
           "a legacy step for a different file is still a new row")

    // Two DIFFERENT tools must never collapse into one another.
    expect(d("Read", "Reading", false, "Bash", "Running swift build", true) == .append,
           "a different tool's result never completes the previous tool's step")

    // An already-completed step is not overwritten by the next call's result.
    expect(d("Read", "Reading Foo.swift", true, "Read", "Reading Bar.swift", true) == .append,
           "a second call to the same tool appends rather than overwriting the finished one")
}

// Wire backward compatibility. A NEWER Mac frequently talks to an OLDER server
// in this repo — a stale `node server.mjs` keeps :3456 and the fresh app adopts
// it. An event field added server-side must therefore decode as ABSENT, not as
// a decode failure that silently drops the whole event.
do {
    let oldToolUseStart = Data(#"{"type":"tool_use_start","id":"tu_1","name":"Read"}"#.utf8)
    expect(AgentV2Conformance.fieldReport(forJSON: oldToolUseStart) != nil,
           "tool_use_start from a server predating `index` still decodes")

    let newToolUseStart = Data(#"{"type":"tool_use_start","index":2,"id":"tu_1","name":"Read"}"#.utf8)
    expect(AgentV2Conformance.fieldReport(forJSON: newToolUseStart)?.contains("index") == true,
           "tool_use_start from a current server keeps `index`")
}

// ClaudeToolPresentation.icon / verb — ONE table for both engines.
//
// These mirror AgentProgressLabelTests, which is an XCTest file this toolchain
// cannot compile, let alone run. Asserting them here is the difference between
// a checked mapping and a decorative one.
do {
    let icon = AgentV2Conformance.icon(for:)

    expect(icon("read-file") == "doc.text", "read-file → doc.text")
    expect(icon("bash") == "terminal", "bash → terminal")
    expect(icon("run-bash") == "terminal", "run-bash → terminal")
    expect(icon("update-file") == "pencil", "update-file → pencil")
    expect(icon("git-op") == "arrow.triangle.branch", "git-op → branch")
    expect(icon("web-search") == "globe", "web-search → globe")
    expect(!icon("something-new").isEmpty, "an unmapped tool still gets an icon, not a blank slot")
    expect(!icon(nil).isEmpty, "a nil tool still gets an icon")

    // The regression this move fixes: the old table was keyed on the RAW wire
    // name, so every SDK built-in fell through to the generic wrench while the
    // verb beside it resolved correctly.
    expect(icon("Read") == "doc.text", "the SDK's Read shares read-file's icon")
    expect(icon("Bash") == "terminal", "the SDK's Bash shares bash's icon")
    expect(icon("Edit") == "pencil", "the SDK's Edit shares update-file's icon")
    expect(icon("mcp__llmide__read-file") == "doc.text", "an MCP-prefixed name normalizes first")
    expect(icon("Read") != "wrench.and.screwdriver", "SDK built-ins no longer fall through to the wrench")

    // Verb and icon must agree about what a tool IS — the old split let them
    // disagree on the same transcript row.
    expect(AgentV2Conformance.verb(for: "Bash").hasPrefix("Running"), "Bash's verb still says Running")
}

// ClaudeToolPresentation.salientArgument — the v2 half of what the legacy
// server does in loop.mjs toolActivityDetail. A tool line reads "Reading
// Foo.swift", not a bare "Reading", only because of this.
do {
    func s(_ tool: String?, _ args: String?) -> String? {
        AgentV2Conformance.salientArgument(tool: tool, argsJSON: args)
    }

    expect(s("Read", #"{"file_path":"/repo/mac/Sources/Foo.swift"}"#) == "Sources/Foo.swift",
           "a path shows its last two segments, not the absolute path")
    expect(s("read-file", #"{"path":"a/b/c/d.swift"}"#) == "c/d.swift",
           "llm-ide's own `path` key works alongside the SDK's file_path")
    expect(s("Bash", #"{"command":"swift build"}"#) == "swift build",
           "a command is shown whole, not path-split")
    expect(s("Grep", #"{"pattern":"TODO"}"#) == "TODO", "a search pattern is picked")
    expect(s("Read", nil) == nil, "no args → no detail")
    expect(s("Read", "") == nil, "empty args → no detail")
    expect(s("Read", "not json") == nil, "unparseable args → no detail, not a crash")
    expect(s("Read", #"{"file_path":"   "}"#) == nil, "a whitespace-only value is not a detail")
    expect(s("Bash", #"{"command":"\#(String(repeating: "x", count: 200))"}"#)?.count == 81,
           "an overlong value is capped at 80 plus the ellipsis")
    expect(s("Bash", #"{"command":"a\n\nb"}"#) == "a b", "whitespace runs collapse to one space")
}

// ChatMessage.ToolStep is PERSISTED (sessions/<uuid>.json), so widening it is a
// schema migration: a step written before the new fields existed must still
// decode, and a step written after must round-trip.
do {
    let legacy = Data(#"{"id":"1B4E28BA-2FA1-11D2-883F-0016D3CCE4A1","label":"Reading","tool":"Read","at":768000000}"#.utf8)
    expect(ChatMessageConformance.decodesToolStep(legacy), "a ToolStep written before the new fields still decodes")

    let widened = Data(#"{"id":"1B4E28BA-2FA1-11D2-883F-0016D3CCE4A1","label":"Reading","tool":"Read","at":768000000,"args":"{\"file_path\":\"/a.swift\"}","resultText":"import SwiftUI","isError":false}"#.utf8)
    expect(ChatMessageConformance.decodesToolStep(widened), "a ToolStep carrying the new fields decodes")

    let report = ChatMessageConformance.toolStepFields(forJSON: widened)
    expect(report?.contains("args") == true, "args survives the round trip")
    expect(report?.contains("resultText") == true, "resultText survives the round trip")
    expect(report?.contains("isError") == true, "isError survives the round trip")
    expect(ChatMessageConformance.toolStepFields(forJSON: legacy)?.isEmpty == true,
           "a legacy step reports no v2 fields rather than defaulting to empty strings")
}

// ChatStreamBuffer — the coalescing arithmetic, independent of scheduling.
do {
    let a = UUID(), b = UUID()
    var buf = ChatStreamBuffer()

    expect(buf.isEmpty, "new buffer is empty")
    expect(buf.append(a, "he") == nil, "same-turn append returns no batch")
    expect(buf.append(a, "llo") == nil, "second same-turn append returns no batch")

    let taken = buf.take()
    expect(taken?.id == a && taken?.text == "hello", "take() returns the joined batch")
    expect(buf.isEmpty, "take() drains the buffer")
    expect(buf.take() == nil, "take() on an empty buffer returns nil")

    // A chunk for a different turn must land the previous turn's text first,
    // never append across the boundary.
    _ = buf.append(a, "first")
    let boundary = buf.append(b, "second")
    expect(boundary?.id == a && boundary?.text == "first", "turn change flushes the previous turn")
    expect(buf.take()?.text == "second", "the new turn's text is buffered, not lost")

    _ = buf.append(a, "dropme")
    buf.discard()
    expect(buf.isEmpty && buf.take() == nil, "discard() drops without publishing")
}

// QuickChatSendPolicy — the ENTRY checks both quick surfaces ran separately.
//
// Note there are two distinct busy checks in the original flow and they behave
// differently: the entry guard returns SILENTLY, while the re-check after the
// server probe shows `busyMessage`. Only the entry gate is modelled here; the
// post-probe re-check stays at the call site with the async work it guards.
do {
    let policy = QuickChatSendPolicy()

    expect(policy.entryGate(draft: "hi", busy: false) == .proceed("hi"), "idle engine proceeds with trimmed text")
    expect(policy.entryGate(draft: "  hi  ", busy: false) == .proceed("hi"), "surrounding whitespace is trimmed")
    expect(policy.entryGate(draft: "", busy: false) == .ignore, "empty draft is a silent no-op")
    expect(policy.entryGate(draft: "   \n ", busy: false) == .ignore, "whitespace-only draft is a silent no-op")

    // Busy is checked BEFORE emptiness in both originals, and returns with no
    // message — the refusal notice belongs to the post-probe re-check only.
    expect(policy.entryGate(draft: "hi", busy: true) == .ignore, "busy at entry is SILENT, not a refusal")
    expect(policy.entryGate(draft: "", busy: true) == .ignore, "busy + empty is also silent")

    expect(
        QuickChatSendPolicy.busyMessage == "Another message is still being answered. Send this one again in a moment.",
        "the busy message is verbatim from both originals"
    )
}

// PlanEditPolicy — the rules behind the plan actions on a v2 plan reply
// (Save / Edit / Refine). Edit writes only the FILE, so these three pure
// rules are all that stands between a user's edits and llm-doc/plans/.
do {
    expect(PlanEditPolicy.refineSeed(title: "Cache warmup") == "Revise the plan \"Cache warmup\": ",
           "the refine seed names the plan the button belongs to")
    expect(PlanEditPolicy.refineSeed(title: "") == "Revise the plan: ",
           "an untitled plan seeds the bare instruction, not empty quotes")
    expect(PlanEditPolicy.refineSeed(title: "  ") == "Revise the plan: ",
           "a whitespace-only title counts as no title")

    // Only the body can block the save: a blank title falls back below.
    expect(PlanEditPolicy.canSave(content: "# Plan\n1. do it") == true, "a plan with a body saves")
    expect(PlanEditPolicy.canSave(content: "") == false, "an emptied body must not write an empty plan file")
    expect(PlanEditPolicy.canSave(content: " \n\t ") == false, "a whitespace-only body is empty too")

    expect(PlanEditPolicy.resolvedTitle(edited: "Renamed", derived: "Derived") == "Renamed",
           "the user's title wins when they left one")
    expect(PlanEditPolicy.resolvedTitle(edited: "   ", derived: "Derived") == "Derived",
           "a blanked title falls back to the one derived from the reply")
    expect(PlanEditPolicy.resolvedTitle(edited: "  Trimmed  ", derived: "Derived") == "Trimmed",
           "the saved title is trimmed — it becomes a filename slug")

    // The write guard. `messageInTranscript` is the one that isn't obvious:
    // the saved flag is stored ON the message, so a write for a message that
    // is gone (the edit sheet outlived its session) would be UNRECORDED and a
    // second write could follow it.
    expect(PlanEditPolicy.refusal(hasPendingTool: false, alreadySaved: false, messageInTranscript: true) == nil,
           "a live unsaved plan with no pending tool writes")
    expect(PlanEditPolicy.refusal(hasPendingTool: true, alreadySaved: false, messageInTranscript: true) == .pendingTool,
           "a pending proposal owns the turn")
    expect(PlanEditPolicy.refusal(hasPendingTool: false, alreadySaved: true, messageInTranscript: true) == .alreadySaved,
           "an already-saved plan is never written twice")
    expect(PlanEditPolicy.refusal(hasPendingTool: false, alreadySaved: false, messageInTranscript: false) == .messageGone,
           "a write that cannot be recorded is refused, not silently repeated")
    // Precedence: the pending tool is reported first — it is the one the user
    // can act on.
    expect(PlanEditPolicy.refusal(hasPendingTool: true, alreadySaved: true, messageInTranscript: false) == .pendingTool,
           "the pending tool outranks the other refusals")
    expect(PlanEditPolicy.refusal(hasPendingTool: false, alreadySaved: true, messageInTranscript: false) == .alreadySaved,
           "already-saved outranks a missing message")
}

// PlanExecutionSummaryPolicy — what the finish card may claim. The tracker
// finishes when the turn ends with nothing pending, which is ALSO what a
// one-step-then-"ready for step 2?" turn looks like; the card said "All 7
// steps completed" over exactly that reply.
do {
    let none = PlanExecutionSummaryPolicy.summary(
        planTitle: "Dead Code Removal", total: 7, completed: 0, hasTaskState: false, failed: false)
    expect(none.title == "Execution turn finished",
           "without task evidence the card reports the TURN finishing, not the plan")
    expect(!none.body.contains("All 7 steps"),
           "no evidence → no completion claim")
    expect(none.body.contains("reply to continue"),
           "the reader is told what to do if the agent stopped early")

    let all = PlanExecutionSummaryPolicy.summary(
        planTitle: "Dead Code Removal", total: 7, completed: 7, hasTaskState: true, failed: false)
    expect(all.title == "Execution finished" && all.body.contains("All 7 steps completed"),
           "every tracked step done → the completion claim is earned")

    let partial = PlanExecutionSummaryPolicy.summary(
        planTitle: "Dead Code Removal", total: 7, completed: 3, hasTaskState: true, failed: false)
    expect(partial.title == "Execution turn finished" && partial.body.contains("3 of 7"),
           "tracked but incomplete → says how far it got")

    let failed = PlanExecutionSummaryPolicy.summary(
        planTitle: "Dead Code Removal", total: 7, completed: 2, hasTaskState: true, failed: true)
    expect(failed.title == "Plan execution stopped" && failed.body.contains("2/7"),
           "a failure keeps its own wording")
}

// PlanEditPolicy.reusablePlanPath — one chat, one plan file. Every save
// after the first goes back into the file the chat's saved-plan card points
// at, instead of minting `<today>-<slug-of-first-heading>.md` again — which
// is how a design and the plan written from it ended up as two unrelated
// files, only one of which Execute attached.
do {
    let plans = "/Users/me/Proj/llm-doc/plans"
    expect(PlanEditPolicy.reusablePlanPath(existing: nil, plansDir: plans) == nil,
           "no saved plan yet → a fresh dated file")
    expect(PlanEditPolicy.reusablePlanPath(existing: "\(plans)/2026-09-12-dead-code.md", plansDir: plans)
               == "\(plans)/2026-09-12-dead-code.md",
           "the chat's plan file is reused as-is")
    expect(PlanEditPolicy.reusablePlanPath(existing: "\(plans)/2026-09-12-dead-code.md", plansDir: plans + "/")
               == "\(plans)/2026-09-12-dead-code.md",
           "a trailing slash on the folder changes nothing")
    expect(PlanEditPolicy.reusablePlanPath(existing: "/Users/me/Other/llm-doc/plans/2026-09-12-dead-code.md", plansDir: plans) == nil,
           "a card from a chat since re-pointed at another project must not write into the old one")
    expect(PlanEditPolicy.reusablePlanPath(existing: "\(plans)/sub/2026-09-12-dead-code.md", plansDir: plans) == nil,
           "a subfolder is not a path this app wrote")
    expect(PlanEditPolicy.reusablePlanPath(existing: "\(plans)/notes.txt", plansDir: plans) == nil,
           "only a markdown file is a plan file")
    expect(PlanEditPolicy.reusablePlanPath(existing: "", plansDir: plans) == nil,
           "an empty path is no path")
}

// PlanEditPolicy.looksLikePlan — the CONTENT half of the plan row's
// visibility. This is what fixes the reported "the plan arrived with no Save
// button": the server-resolved mode is stamped per turn and flaps across a
// planning conversation (the question turn resolves to `plan`, the turn that
// finally CONTAINS the plan does not), so the row also follows the shape of
// the reply. Conservative on purpose — a false positive puts a Save Plan
// button under an ordinary answer.
do {
    let realPlan = """
    Here is the plan, scoped to what actually survived verification.

    ## Scope, restated honestly

    Of the four items I proposed, three were mine, not yours. The duplicate
    tree exists only in the index, the ignore file is merely untidy, and the
    audit is three weeks old. What remains is worth doing, in order, with a
    revert point between each phase so the diff stays reviewable.

    ## Steps

    1. Rebuild the code index so it stops reporting files that do not exist.
    2. Collapse the duplicated .gitignore blocks into their unique lines.
    3. Re-run the dead-code audit against the rebuilt index.
    """
    expect(PlanEditPolicy.looksLikePlan(content: realPlan) == true,
           "a sectioned, enumerated plan is recognised even when the turn was not stamped plan")

    let phasePlan = """
    I will sequence this so each stage is independently revertable, and I will
    stop between them so you can read the diff before the next one starts.
    Nothing here touches the build configuration, which is the part that would
    be expensive to get wrong, and every stage leaves the tree green.

    ## Phase 1 — tag the current tree
    Cut a tag so the whole campaign can be reverted in one move.

    ## Phase 2 — delete the stale copies
    Remove the files the rebuilt index proves are unreferenced.
    """
    expect(PlanEditPolicy.looksLikePlan(content: phasePlan) == true,
           "phase headings count as steps — a plan need not use numbered lines")

    let checklistPlan = """
    # Cleanup plan

    The list below is ordered by risk: the reversible edits come first, and
    the one irreversible deletion is last so everything before it can be
    verified in place. Each item is small enough to review on its own, which
    is the point of splitting them rather than landing one large commit.

    - [ ] Rebuild the code index
    - [ ] Collapse the duplicate ignore blocks
    - [ ] Delete the verified-stale tree
    """
    expect(PlanEditPolicy.looksLikePlan(content: checklistPlan) == true,
           "a checklist plan counts")

    // Japanese is this app's primary UI language, so a JA plan has to score
    // exactly like its English twin — otherwise the row this whole rule
    // restores goes missing again for the users most likely to see it.
    let japanesePlan = """
    検証で残った作業だけに絞って、以下の計画を提案します。各段階は独立して
    元に戻せるので、差分はレビュー可能なまま保てます。ビルド設定には触れま
    せん。そこは間違えたときの手戻りが最も大きいためです。

    ## フェーズ1 — コードインデックスの再生成
    存在しないファイルを報告しなくなるまで作り直します。

    ## フェーズ2 — 重複した .gitignore の整理
    重複行をユニークな行にまとめます。
    """
    expect(PlanEditPolicy.looksLikePlan(content: japanesePlan) == true,
           "a Japanese plan with フェーズ headings counts — JA is the primary UI language")

    let japaneseNumbered = """
    確認できた事実だけで手順を書きます。順番は依存関係のとおりで、前の手順が
    終わるまで次には進みません。途中で止めても壊れない並びにしてあります。
    ビルド設定には触れません。そこは間違えたときの手戻りが最も大きいためです。

    # 不要コード削除の計画

    １．コードインデックスを再生成する
    ２．重複した .gitignore の行をまとめる
    """
    expect(PlanEditPolicy.looksLikePlan(content: japaneseNumbered) == true,
           "full-width numbering (１．) enumerates steps too")

    // Negatives — each drops exactly one of the three required signals, and
    // each is comfortably OVER minimumPlanBytes so it fails for the stated
    // reason rather than on length.
    expect(PlanEditPolicy.looksLikePlan(content: "Sure — 1. do it\n2. done") == false,
           "a two-line answer is too short to be a plan, numbered or not")

    let proseOnly = String(repeating: "This is a long prose answer with no enumerated work in it. ", count: 12)
    expect(PlanEditPolicy.looksLikePlan(content: "# Summary\n\n" + proseOnly) == false,
           "a long sectioned answer with nothing enumerated is not a plan")

    let stepsNoHeading = """
    1. Rebuild the code index so it stops reporting files that do not exist.
    2. Collapse the duplicated .gitignore blocks into their unique lines.
    3. Re-run the dead-code audit against the rebuilt index and compare it
       against the list produced before the rebuild, which is describing a
       tree that no longer matches what is actually on disk today.
    4. Write down whatever survived that comparison, because that list — not
       the original one — is the only one worth acting on afterwards.
    """
    expect(stepsNoHeading.utf8.count > PlanEditPolicy.minimumPlanBytes,
           "the unsectioned fixture must be long enough to reach the shape check")
    // Reversed deliberately. This asserted that a plan must have sections,
    // which was a judgement call and the wrong one: four numbered steps ARE a
    // plan, heading or not. What the rule actually has to exclude is a reply
    // that enumerates NO work — see the clarifying-question case below.
    expect(PlanEditPolicy.looksLikePlan(content: stepsNoHeading) == true,
           "enumerated work is the signal; a section heading is its usual company, not a requirement")

    let twoStepsNoHeading = """
    Both of those are fine to change, and neither depends on the other, so you
    can do them in either order. There is no migration involved and nothing
    else in the tree reads those two values, which is why this is short.

    1. Rename the field in the config struct.
    2. Update the one call site that reads it.
    """
    expect(PlanEditPolicy.looksLikePlan(content: twoStepsNoHeading) == false,
           "two numbered lines inside an ordinary answer are a list, not a plan")

    let oneStep = """
    # Fix

    The index is stale, which is why the earlier search reported files that
    are not on disk. Rebuilding it is a single command and changes nothing
    else in the tree, so it can be done before deciding anything larger, and
    it costs nothing to redo if the result turns out to be uninteresting.
    Everything else on the original list depends on the rebuilt index, so
    there is nothing further worth deciding until this one command has run.

    1. Rebuild the code index.
    """
    expect(oneStep.utf8.count > PlanEditPolicy.minimumPlanBytes,
           "the single-step fixture must be long enough to reach the step count")
    expect(PlanEditPolicy.looksLikePlan(content: oneStep) == false,
           "one step is a suggestion, not a plan worth writing to llm-doc/plans/")

    // The reported bug: in Plan mode the planner's FIRST move is a clarifying
    // question (both plan skills open with one), and being in plan mode used
    // to be enough on its own to show the row — so the question arrived under
    // a "Save Plan" button offering to write the question itself to
    // llm-doc/plans/. The order is question → answer → plan → save.
    let clarifyingQuestion = """
    I'll help you plan dead code removal. This looks like it needs some
    exploration first to understand scope and approach.

    Let me start by checking the project structure and whether there are
    existing tools or processes for identifying dead code. I can see this is a
    multi-platform project (Mac app, iOS app, browser extension, GraphKit
    library). Before I can create a proper plan, I need to understand the
    scope better.

    **First question:** Which parts of the codebase are you looking to clean
    up? Are we targeting:

    - The entire project (all platforms)?
    - Specific areas like the Mac app, extension, or library?
    - Or a particular subsystem you've identified as having dead code?
    """
    expect(PlanEditPolicy.looksLikePlan(content: clarifyingQuestion) == false,
           "a clarifying question enumerates options to choose between, not work to carry out")
    expect(AgentV2Selection.showsSavePlanAction(
        mode: "plan", v2Selected: true, hasPendingTool: false,
        sessionIsPlanning: true,
        contentLooksLikePlan: PlanEditPolicy.looksLikePlan(content: clarifyingQuestion)) == false,
           "plan MODE alone must not offer to save a reply that is not a plan")
    expect(AgentV2Selection.showsSavePlanAction(
        mode: "plan", v2Selected: true, hasPendingTool: false,
        sessionIsPlanning: true,
        contentLooksLikePlan: PlanEditPolicy.looksLikePlan(content: realPlan)) == true,
           "the row returns once the plan itself arrives")
    expect(AgentV2Selection.showsSavePlanAction(
        mode: nil, v2Selected: true, hasPendingTool: false,
        sessionIsPlanning: false,
        contentLooksLikePlan: true) == false,
           "a plan-shaped reply in a chat that never planned is still not offered")

    // After the chat has its plan file, work outside a plan mode is
    // execution, and its narration is plan-shaped. This is the rule that
    // stops a second file ("📋 Deliverables Created") being minted from it.
    expect(AgentV2Selection.showsSavePlanAction(
        mode: "execute", v2Selected: true, hasPendingTool: false,
        sessionIsPlanning: true, contentLooksLikePlan: true, sessionHasSavedPlan: true) == false,
           "execute-mode narration after a saved plan is not offered as a plan")
    expect(AgentV2Selection.showsSavePlanAction(
        mode: "execute", v2Selected: true, hasPendingTool: false,
        sessionIsPlanning: true, contentLooksLikePlan: true, sessionHasSavedPlan: false) == true,
           "before any save, the plan arriving on an execute-resolved turn is still offered (the flap case)")
    expect(AgentV2Selection.showsSavePlanAction(
        mode: "plan", v2Selected: true, hasPendingTool: false,
        sessionIsPlanning: true, contentLooksLikePlan: true, sessionHasSavedPlan: true) == true,
           "a plan-mode revision after a save is offered — it goes into the same file")

    // Fenced blocks are QUOTED text, not structure. Without this the shell
    // script below supplies both signals — `#` comments and `1)` lines — and
    // an ordinary explanation sprouts a Save Plan button.
    let explanationWithScript = """
    The failure comes from the script itself, not from your configuration.
    Here is the part that matters, with the two lines that decide the exit
    code; everything above it is setup and can be ignored for now.

    ```bash
    # Phase 1 of the rebuild
    1) echo "collecting"
    2) echo "comparing"
    # Phase 2 of the rebuild
    ```

    Run it again once the index is rebuilt and the exit code should change.
    """
    expect(PlanEditPolicy.looksLikePlan(content: explanationWithScript) == false,
           "a fenced script is quoted text — its comments and lists are not plan structure")

    // Sub-bullets are details OF a step, which is the rule the execute-path
    // parser (`stepLines(in:patterns:)`) already applies. The two parsers
    // must agree about the same document.
    let nestedDetails = """
    # Rebuild

    Only one thing actually needs doing here, but it has several moving parts
    worth listing so nothing is missed while it runs. None of them is a
    separate decision — they all belong to the single step below.

    1. Rebuild the code index.
        1. Drop the stale database.
        2. Re-scan the working tree.
        3. Verify the file count matches what is on disk.
    """
    expect(PlanEditPolicy.looksLikePlan(content: nestedDetails) == false,
           "indented sub-steps are details of one step, not steps of their own")
}

if failures.isEmpty {
    print("chat-contract-lab: all assertions passed")
} else {
    print("chat-contract-lab: \(failures.count) FAILED")
    exit(1)
}
