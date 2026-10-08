import Foundation
import JavaScriptCore
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

// The structural-repair pass in parseMarkdown. Its three line-based transforms
// (list wrap, \n\n -> </p><p>, \n -> <br>) know nothing about block structure
// and emit markup no browser accepts: <br> against list edges, and <p>
// wrapping block elements. The browser repairs the nesting by closing the
// paragraph early, leaving an EMPTY <p> that still costs its 14px margin and a
// 1.6 line-height — which is what opened ~80pt of dead space through the middle
// of any reply with spaced-out bullets.
//
// These assert the repair steps are PRESENT; the block after this one runs
// the parser itself under JavaScriptCore to check what it produces. What this pins is that the steps are not quietly dropped, and
// that the ORDER holds: the join must precede the <ul> wrap, and the repairs
// must follow the <br> substitution, or each one silently does nothing.
do {
    let page = GenerationConformance.renderedHTML(for: "- a\n\n- b\n")

    guard let joinAt = page.range(of: "<\\/li>\\n{2,}(?=<li[ >])")?.lowerBound,
          let wrapAt = page.range(of: "(<li>.*<\\/li>\\n?)+")?.lowerBound,
          let brAt = page.range(of: "html.replace(/\\n/g, '<br>')")?.lowerBound,
          let stripAt = page.range(of: "<br>\\s*(?=<\\/?(?:ul|ol|blockquote|table|h[1-6]|hr|div|li)\\b)")?.lowerBound,
          let emptyAt = page.range(of: "<p>\\s*<\\/p>")?.lowerBound
    else {
        expect(false, "the parseMarkdown repair pass is missing from the rendered template")
        exit(1)
    }

    expect(joinAt < wrapAt,
           "blank-line-separated bullets are joined BEFORE the <ul> wrap, or each bullet gets its own list")
    expect(brAt < stripAt,
           "the <br> cleanup runs AFTER \\n becomes <br>, or there are no breaks to clean")
    expect(stripAt < emptyAt,
           "empty paragraphs are dropped LAST, after the block hoist creates them")
    // The hoist itself — a block element can never legally live inside <p>.
    expect(page.contains("(<(?:ul|ol|blockquote|table|h[1-6]|hr|div)\\b)"),
           "block opens are hoisted out of the enclosing paragraph")
    expect(page.contains("(\\x00(?:CODE|TABLE)\\d+\\x00)"),
           "code/table placeholders are hoisted too — they expand into block elements after this")
}

// parseMarkdown BEHAVIOUR — executed, not just pattern-matched: the template's
// parser script runs under JavaScriptCore with a stubbed DOM. Numbered lists
// used to become bare <li> after the <ul> wrap (one empty-paragraph gap per
// item, numbering lost), and emphasis ran over inline code.
do {
    let page = GenerationConformance.renderedHTML(for: "x")
    let script = page.components(separatedBy: "<script>")
        .first { $0.contains("function parseMarkdown") }?
        .components(separatedBy: "</script>").first ?? ""
    let ctx = JSContext()!
    ctx.evaluateScript("var window = this; var document = { body: { scrollHeight: 0 }, "
        + "getElementById: function() { return { innerHTML: '' }; }, "
        + "querySelectorAll: function() { return []; }, createElement: function() { return {}; } };")
    ctx.evaluateScript(script)
    func parse(_ md: String) -> String {
        ctx.objectForKeyedSubscript("parseMarkdown")?.call(withArguments: [md])?.toString() ?? ""
    }
    expect(parse("Steps:\n\n1. a\n\n2. b\n\nDone") == "<p>Steps:</p><ol><li>a</li><li>b</li></ol><p>Done</p>",
           "spaced numbered items render as ONE <ol> with no empty paragraphs")
    expect(parse("3. c\n4. d").contains("<ol start=\"3\">"), "a continued list keeps its start number")
    expect(parse("- a\n\n- b").contains("<ul><li>a</li>"), "bullets are unchanged")
    expect(parse("`__init__` and `a*b*c`").contains("<code>__init__</code> and <code>a*b*c</code>"),
           "emphasis never runs inside inline code")
    expect(parse("my_var_name and _this_").contains("my_var_name and <em>this</em>"),
           "underscores inside a word stay literal; real _emphasis_ still works")
    let hostile = parse("[a](http://x/`\" onmouseover=\"alert(1)//`)")
    expect(!hostile.contains("\" onmouseover") && hostile.contains("&quot;"),
           "inline code inside a link URL is escaped into the href, never restored as markup")
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

// Sticky-mode release — the picker follows the resolved mode and then STAYS
// there, which keeps a mode specific to the work. The cost is that it never
// leaves on its own: a chat that planned something answered every later
// message as a planner. The lifecycle releases it back to Auto, the only
// setting that re-decides the next turn.
do {
    let planStages = ModePolicy.planStages
    expect(ModePolicy.releasesStickyMode(current: "plan", releasing: planStages),
           "a saved plan hands Plan back to Auto")
    expect(ModePolicy.releasesStickyMode(current: "assist_plan", releasing: planStages),
           "and Assist Plan too")
    expect(!ModePolicy.releasesStickyMode(current: "auto", releasing: planStages),
           "Auto is already released; releasing it again would be a change that changes nothing")
    // The guard that matters: a mode the user picked by hand is not the
    // flow's to undo. Saving a plan while in Execute leaves Execute alone.
    expect(!ModePolicy.releasesStickyMode(current: "execute", releasing: planStages),
           "a save never overrules a deliberately-picked Execute")
    expect(!ModePolicy.releasesStickyMode(current: "review", releasing: planStages),
           "nor any other mode outside the stage being released")
    // The end of a RUN releases the mode that run set, and nothing else.
    let runStages = ModePolicy.runStages
    expect(ModePolicy.releasesStickyMode(current: "execute", releasing: runStages),
           "a finished run hands Execute back")
    expect(!ModePolicy.releasesStickyMode(current: "review", releasing: runStages),
           "but still not a mode the run never set")
    expect(ModePolicy.autoMode == "auto",
           "the release target is the wire value the server classifies on")
    expect(ModePolicy.runAndReviewStages == ModePolicy.runStages.union(ModePolicy.reviewStage),
           "dismissing a finished run releases the run's modes AND Code Review — one set, built from the others")
    expect(ModePolicy.reviewStage == ["review"],
           "releasing a review takes back Code Review only")
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

    // The plan bindings' triage contract (extension/llm_agent/runtime/
    // plan-pipeline.mjs TRIAGE_CLAUSE): a plan-mode reply to a request with
    // nothing to change opens with "**Nothing to execute.**". Its findings are
    // naturally a sectioned, numbered list — plan-shaped — and it used to get
    // Save/Execute, then fail at Execute with no step that had anything to do.
    let nothingToExecute = """
    **Nothing to execute.** The CSV export this asks for is already wired end to end.

    ## What I checked

    1. The export button in ReportView calls ExportService.csv(for:) with the current filter applied.
    2. ExportService writes UTF-8 with a BOM, so Excel opens Japanese text correctly.
    3. The test suite covers both the empty and the filtered case in ExportServiceTests.
    4. The Settings toggle that hides the button defaults to on, so every user already sees it today.
    """
    expect(nothingToExecute.utf8.count >= PlanEditPolicy.minimumPlanBytes,
           "the triage fixture is long enough to fail on the marker, not on length")
    expect(PlanEditPolicy.looksLikePlan(content: nothingToExecute) == false,
           "a reply that opens with the triage marker is an answer, never a plan")
    expect(PlanEditPolicy.looksLikePlan(content: "Nothing to execute: already done.\n\n" + nothingToExecute) == false,
           "the marker counts without bold and with a colon too")
    expect(PlanEditPolicy.looksLikePlan(content: "# Nothing to execute.\n\n" + nothingToExecute) == false,
           "the marker counts as a heading too — the Agent engine opens documents with a # title")
    expect(PlanEditPolicy.looksLikePlan(content: "> **Nothing to execute**\n\n" + nothingToExecute) == false,
           "and as a quote")

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

    // Both of these were SAVED as plans, executed against, and reviewed. They
    // are quoted from the files that resulted, because the failure is not
    // hypothetical: a planner numbers its questions exactly the way it would
    // number steps, and the flow downstream cannot tell the difference — the
    // execute prompt read the first one back as "Steps: 1. … 2. … 3. …".
    let numberedQuestions = """
    I can see the project has dead code analysis tooling set up (scripts and a
    removal-candidates file), but there are currently no findings identified yet.
    Before I create a plan, I need to clarify what you're looking for:

    **Spike classification**: This looks like a feasibility question — we need to
    understand the scope of dead code in the project first, then decide how to
    tackle it.

    A few quick questions:

    1. **Should we first run the dead code analysis** to identify candidates (Swift
    and TypeScript/JavaScript files), or do you already have a list of specific
    dead code you want removed?

    2. **Scope** — are we analyzing the entire codebase, or specific areas?

    3. **After we identify dead code, what's the removal strategy?**

    Once I understand your intent, I can propose an analysis + removal process.
    """
    expect(PlanEditPolicy.looksLikePlan(content: numberedQuestions) == false,
           "numbered QUESTIONS are not enumerated work, however many there are")

    let endsByAsking = """
    ## Design: Clear Session Lifecycle

    **Core idea:** Create an explicit `ChatSessionManager` that owns all session
    state transitions and lifecycle operations, making the flow easy to trace.

    **Changes:**

    1. **Add `ChatSessionManager`** — a new service that becomes the single
    interface for all session operations.
    2. **Move persistence behind it** so views never touch the store directly.
    3. **Route ChatEngine through it** instead of direct store calls.

    **Files touched:** Create `Services/ChatSessionManager.swift`, update Views
    and ChatEngine to use it instead of direct store calls.

    Does this approach make sense for what you're trying to achieve?
    """
    expect(PlanEditPolicy.looksLikePlan(content: endsByAsking) == false,
           "a proposal that ends by asking is waiting on an answer, not ready to run")

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

// PlanTranscriptPolicy — which reply is a DOCUMENT and which saved-plan card
// holds a written plan. Decided by turn order, because content sniffing
// cannot tell a design from the plan written out of it: both look like plans.
do {
    let design = UUID(), writeAsk = UUID(), doc = UUID(), savedPlan = UUID()
    let marks = PlanTranscriptPolicy.mark([
        .init(id: design, kind: .planResult),
        .init(id: writeAsk, kind: .user, isPlanWriteRequest: true),
        .init(id: doc, kind: .assistant),
        .init(id: savedPlan, kind: .planResult),
    ])
    expect(marks.documentReplies == [doc],
           "only the reply to the write request is the document")
    expect(marks.writtenPlanCards == [savedPlan],
           "the card saved after that reply holds the written plan")
    expect(!marks.writtenPlanCards.contains(design),
           "the design card it was written FROM is not the written plan")

    // A question mid-write is conversation: the user's answer disarms, so
    // the agent's next reply is not hidden behind a one-line summary.
    let question = UUID(), answer = UUID(), afterAnswer = UUID()
    let interrupted = PlanTranscriptPolicy.mark([
        .init(id: UUID(), kind: .user, isPlanWriteRequest: true),
        .init(id: question, kind: .assistant),
        .init(id: answer, kind: .user),
        .init(id: afterAnswer, kind: .assistant),
    ])
    expect(interrupted.documentReplies == [question],
           "a plain user message disarms the marker")
    expect(!interrupted.documentReplies.contains(afterAnswer),
           "the reply after it renders normally")

    let none = PlanTranscriptPolicy.mark([
        .init(id: UUID(), kind: .user),
        .init(id: UUID(), kind: .assistant),
        .init(id: UUID(), kind: .planResult),
    ])
    expect(none.documentReplies.isEmpty && none.writtenPlanCards.isEmpty,
           "an ordinary chat marks nothing")

    // The one-turn flow: the request, the reply that carries design AND plan,
    // then the card once the user presses Save. No write request precedes the
    // document, so the ORDER rule above marks nothing — the reply is a
    // document because its text is what the card below now holds.
    let ask = UUID(), oneTurnDoc = UUID(), card = UUID()
    let oneTurn = PlanTranscriptPolicy.mark([
        .init(id: ask, kind: .user),
        .init(id: oneTurnDoc, kind: .assistant, isSavedPlanSource: true),
        .init(id: card, kind: .planResult),
    ])
    expect(oneTurn.documentReplies == [oneTurnDoc],
           "a saved reply collapses — the card renders the same markdown below it")

    // Before Save there is no card, so the reply is the only copy of the plan
    // and must stay readable.
    let unsaved = UUID()
    let beforeSave = PlanTranscriptPolicy.mark([
        .init(id: UUID(), kind: .user),
        .init(id: unsaved, kind: .assistant),
    ])
    expect(beforeSave.documentReplies.isEmpty,
           "an unsaved plan reply is not collapsed — nothing else is showing it")
}

// PlanReviewPolicy.updatesPlanAfterFix — the ONE path that writes a plan to
// disk without the user asking for it, so every leg of the gate is pinned.
do {
    expect(PlanReviewPolicy.updatesPlanAfterFix(
        verdict: .changesRequested, turnChangedCode: true,
        isPlanUpdateTurn: false, hasPlanFile: true),
           "review asked for changes and this turn edited a file — the plan is now stale")

    expect(!PlanReviewPolicy.updatesPlanAfterFix(
        verdict: .pass, turnChangedCode: true,
        isPlanUpdateTurn: false, hasPlanFile: true),
           "a passing review leaves no findings to fix, so an edit is ordinary work")
    expect(!PlanReviewPolicy.updatesPlanAfterFix(
        verdict: .unclear, turnChangedCode: true,
        isPlanUpdateTurn: false, hasPlanFile: true),
           "nor does a review that claimed nothing")
    // Two meanings, one gate: a plan nobody reviewed is not this flow — AND a
    // review whose rewrite has already LANDED is done with it. The panel
    // clears `reviewVerdict` when a plan-update reply lands
    // (CodeAssistantPanel+Session), so the second and third fix turns of one
    // review round stop spawning a full plan-regeneration turn each. A new
    // review re-arms exactly one more.
    expect(!PlanReviewPolicy.updatesPlanAfterFix(
        verdict: nil, turnChangedCode: true,
        isPlanUpdateTurn: false, hasPlanFile: true),
           "no verdict, no rewrite — unreviewed, or already brought level by the last update")

    expect(!PlanReviewPolicy.updatesPlanAfterFix(
        verdict: .changesRequested, turnChangedCode: false,
        isPlanUpdateTurn: false, hasPlanFile: true),
           "a turn that only talked about the findings changed nothing to describe")
    expect(!PlanReviewPolicy.updatesPlanAfterFix(
        verdict: .changesRequested, turnChangedCode: true,
        isPlanUpdateTurn: true, hasPlanFile: true),
           "the update turn must not trigger another update — that is the loop")
    expect(!PlanReviewPolicy.updatesPlanAfterFix(
        verdict: .changesRequested, turnChangedCode: true,
        isPlanUpdateTurn: false, hasPlanFile: false),
           "with no saved plan there is nothing to update — this never CREATES one")

    // Tool names arrive on a ToolStep in either engine's spelling.
    for name in ["Edit", "Write", "MultiEdit", "NotebookEdit",
                 "mcp__llmide__update-file", "update-file"] {
        expect(PlanReviewPolicy.isCodeChangingTool(name), "\(name) writes to a file")
    }
    for name in ["Read", "Grep", "mcp__llmide__read-file", "mcp__llmide__find-code",
                 "AskUserQuestion", ""] {
        expect(!PlanReviewPolicy.isCodeChangingTool(name), "\(name) does not")
    }

    let msg = PlanReviewPolicy.planUpdateMessage(planTitle: "Clear Session Lifecycle")
    expect(msg.contains("Clear Session Lifecycle"), "the update names the plan it rewrites")
    expect(msg.contains("Do not modify any files in this turn"),
           "the fixing already happened — this turn only moves the document")
}

// PlanReviewPolicy — the verdict gates Push, so it is read off an explicit
// marker line, not inferred from prose, and a reply that echoes the prompt's
// own menu of verdicts is unclear rather than a coin flip.
do {
    let pass = """
    No blocking issues found.

    \(PlanReviewPolicy.verdictMarker) PASS
    """
    expect(PlanReviewPolicy.verdict(from: pass) == .pass, "an explicit PASS reads as pass")

    let changes = """
    `foo.swift:12` drops the error.

    **\(PlanReviewPolicy.verdictMarker) CHANGES**
    """
    expect(PlanReviewPolicy.verdict(from: changes) == .changesRequested,
           "markdown emphasis around the marker doesn't hide it")

    let echoed = "\(PlanReviewPolicy.verdictMarker) PASS or \(PlanReviewPolicy.verdictMarker) CHANGES"
    expect(PlanReviewPolicy.verdict(from: echoed) == .unclear,
           "the prompt's menu echoed back is not a verdict")

    // Only the first word after the marker is the verdict — a PASS that
    // explains itself must not be downgraded by a word in its own reasoning,
    // which is what made the push dialog warn over a clean review.
    let justified = "\(PlanReviewPolicy.verdictMarker) PASS — no changes required, nothing failed"
    expect(PlanReviewPolicy.verdict(from: justified) == .pass,
           "a PASS that explains itself is still a PASS")
    expect(PlanReviewPolicy.verdict(from: "\(PlanReviewPolicy.verdictMarker) MAYBE") == .unclear,
           "a marker with an unreadable verdict claims nothing")

    // The prompt offers the two verdicts as adjacent lines. A reply that
    // quotes that menu back ends on CHANGES, which read as a requested
    // change over a review that had in fact passed.
    let quotedMenu = """
    You asked me to end with one of:

    \(PlanReviewPolicy.verdictMarker) PASS        — if nothing found would block merging to main
    \(PlanReviewPolicy.verdictMarker) CHANGES     — if anything found should be fixed first

    Nothing blocking. \(PlanReviewPolicy.verdictMarker) PASS
    """
    expect(PlanReviewPolicy.verdict(from: quotedMenu) == .pass,
           "the prompt's two-line menu quoted back is skipped for the real verdict")

    let menuOnly = PlanReviewPolicy.reviewMessage(planTitle: "X", baseBranch: "main")
    expect(PlanReviewPolicy.verdict(from: menuOnly) == .unclear,
           "the prompt itself states no verdict — the menu is not a conclusion")

    expect(PlanReviewPolicy.verdict(from: "Looks great to me!") == .unclear,
           "positive prose with no marker claims nothing")

    // Scanned from the end: a reply that restates the instruction first and
    // concludes afterwards is read off its conclusion.
    let restated = """
    I was asked to end with \(PlanReviewPolicy.verdictMarker) PASS or CHANGES.

    Found a null deref.

    \(PlanReviewPolicy.verdictMarker) CHANGES
    """
    expect(PlanReviewPolicy.verdict(from: restated) == .changesRequested,
           "the LAST marker line wins, not the echoed instruction")

    // The release rule the finish card now depends on. Commit used to reach
    // `dismissPlanExecution` on its common "nothing to commit" path and
    // release the picker as a side effect; with Commit gone, the RUN's end
    // has to do it or the chat answers "I want a plan to…" as an Execute turn.
    let runStagesNow = ModePolicy.runStages
    expect(ModePolicy.releasesStickyMode(current: "execute", releasing: runStagesNow),
           "a settled run hands Execute back to Auto without waiting for Dismiss")
    expect(!ModePolicy.releasesStickyMode(current: "auto", releasing: runStagesNow),
           "releasing Auto changes nothing")
    expect(!ModePolicy.releasesStickyMode(current: "review", releasing: runStagesNow),
           "a run never set Code Review, so settling must not take it away")

    expect(!PlanReviewPolicy.allowsPush(reviewed: false),
           "Push stays locked until a review has run")
    expect(PlanReviewPolicy.allowsPush(reviewed: true),
           "a finished review unlocks it, whatever it concluded")
    expect(!PlanReviewPolicy.warnsBeforePush(.pass),
           "a clean review confirms without a warning")
    expect(PlanReviewPolicy.warnsBeforePush(.changesRequested)
           && PlanReviewPolicy.warnsBeforePush(.unclear)
           && PlanReviewPolicy.warnsBeforePush(nil),
           "anything else warns before merging to the default branch")

    let msg = PlanReviewPolicy.reviewMessage(planTitle: "Dead Code Removal", baseBranch: "main")
    expect(msg.contains(PlanReviewPolicy.verdictMarker),
           "the prompt asks for exactly the marker the parser looks for")
    expect(msg.contains("Do not modify any files"),
           "a review is not a fix")
}

// PlanRequestPolicy — the composer's one-tap escape from "I asked for a plan
// and got an Execute turn". The chip costs attention every time it is wrong,
// so it fires only on an explicit ASK, never on the word "plan" appearing.
do {
    expect(PlanRequestPolicy.looksLikePlanRequest("i want a plan to remove the dead code."),
           "the message that started this: an explicit ask")
    expect(PlanRequestPolicy.looksLikePlanRequest("Write me a plan for the migration"),
           "write me a plan")
    expect(PlanRequestPolicy.looksLikePlanRequest("デッドコードを消すプランを作って"),
           "Japanese asks count — JA is the primary UI language")
    expect(PlanRequestPolicy.looksLikePlanRequest("計画を立ててください"),
           "計画を立てる is the same ask")

    expect(!PlanRequestPolicy.looksLikePlanRequest("execute the plan"),
           "acting on an existing plan is not asking for one")
    expect(!PlanRequestPolicy.looksLikePlanRequest("I plan to refactor this later"),
           "\"plan\" as a verb about oneself is not a request")
    expect(!PlanRequestPolicy.looksLikePlanRequest("the plan is saved already"),
           "naming a plan is not asking for one")
    expect(!PlanRequestPolicy.looksLikePlanRequest("プランを実行して"),
           "nor in Japanese")
    expect(!PlanRequestPolicy.looksLikePlanRequest(""),
           "an empty composer offers nothing")

    // WHERE it is offered. Auto would classify the request into Plan by
    // itself, so the chip there would be pure noise.
    expect(PlanRequestPolicy.offersPlanSwitch(draft: "i want a plan to X", currentMode: "execute"),
           "Execute answers a planning request as work — offer the switch")
    expect(PlanRequestPolicy.offersPlanSwitch(draft: "i want a plan to X", currentMode: "document"),
           "so does any other non-plan mode")
    expect(!PlanRequestPolicy.offersPlanSwitch(draft: "i want a plan to X", currentMode: "auto"),
           "Auto re-decides per turn and will reach Plan on its own")
    expect(!PlanRequestPolicy.offersPlanSwitch(draft: "i want a plan to X", currentMode: "plan"),
           "already in Plan")
    expect(!PlanRequestPolicy.offersPlanSwitch(draft: "i want a plan to X", currentMode: "assist_plan"),
           "Assist Plan plans too")
    expect(!PlanRequestPolicy.offersPlanSwitch(draft: "fix the failing test", currentMode: "execute"),
           "ordinary work in Execute is exactly right — say nothing")
}

// ModePolicy.pickerMode — the picker follows the mode the server resolved,
// but ONLY while it sits on Auto. A mode the user picked by hand is theirs;
// and Auto resolving to Auto is not a move.
do {
    expect(ModePolicy.pickerMode(current: "auto", resolved: "plan") == "plan",
           "on Auto, the picker follows the resolved mode")
    expect(ModePolicy.pickerMode(current: "auto", resolved: "auto") == nil,
           "Auto resolving to Auto is not a move")
    expect(ModePolicy.pickerMode(current: "execute", resolved: "plan") == nil,
           "a hand-picked mode is never overruled by the server")
    expect(ModePolicy.pickerMode(current: "auto", resolved: "not-a-mode") == nil,
           "an unknown wire value moves nothing")
}

// ModePolicy.Selection — provenance. Releases act only on a mode the FLOW
// set; a hand-pick is never taken away (it used to be: a hand-picked Execute
// was released when a run settled, because releases keyed on the string).
do {
    let flowExecute = ModePolicy.Selection(mode: "execute", setByFlow: true)
    let userExecute = ModePolicy.Selection(mode: "execute", setByFlow: false)
    expect(ModePolicy.releasesStickyMode(flowExecute, releasing: ModePolicy.runStages),
           "a flow-set Execute is released when its run settles")
    expect(!ModePolicy.releasesStickyMode(userExecute, releasing: ModePolicy.runStages),
           "a hand-picked Execute is NOT released by the run lifecycle")
    expect(!ModePolicy.Selection(mode: "auto", setByFlow: true).setByFlow,
           "Auto carries no provenance")
}

// ModePolicy.releasesAtWorkEnd — one-piece-of-work modes the flow set go back
// to Auto when the work settles; multi-turn planning stays; a live plan run
// keeps its Execute; a hand-pick stays. Before this, a classified Execute or
// Document stuck for the rest of the chat and nothing was classified again.
do {
    let flow = { ModePolicy.Selection(mode: $0, setByFlow: true) }
    expect(ModePolicy.releasesAtWorkEnd(flow("execute"), planRunActive: false),
           "a classified Execute is released when the work is over")
    expect(ModePolicy.releasesAtWorkEnd(flow("document"), planRunActive: false),
           "a classified Document is released too")
    expect(ModePolicy.releasesAtWorkEnd(flow("review"), planRunActive: false),
           "and a classified Review")
    expect(!ModePolicy.releasesAtWorkEnd(flow("plan"), planRunActive: false),
           "Plan is a multi-turn conversation — it stays until the plan is saved")
    expect(!ModePolicy.releasesAtWorkEnd(flow("assist_plan"), planRunActive: false),
           "so is Assist Plan")
    expect(!ModePolicy.releasesAtWorkEnd(flow("execute"), planRunActive: true),
           "a live plan run keeps its Execute until the run settles")
    expect(!ModePolicy.releasesAtWorkEnd(ModePolicy.Selection(mode: "execute", setByFlow: false),
                                         planRunActive: false),
           "a hand-picked Execute survives the end of the work")
    // The legacy engine's mode lands on the terminal event and the picker
    // follows it a view-update later — the release must count it.
    let pending = ModePolicy.selection(.auto, afterPendingResolution: "execute")
    expect(pending == flow("execute"), "a pending follow counts as flow-set")
    expect(ModePolicy.releasesAtWorkEnd(pending, planRunActive: false),
           "so a turn that resolved Execute on Auto does not park the picker there")
    expect(ModePolicy.selection(flow("plan"), afterPendingResolution: "execute") == flow("plan"),
           "off Auto, a resolution changes nothing")
}

// ModePolicy.pickerSelectionAfterSessionChange — a chat gets its own picker
// back; a chat never seen this run starts on Auto.
do {
    let planning = ModePolicy.Selection(mode: "plan", setByFlow: true)
    expect(ModePolicy.pickerSelectionAfterSessionChange(remembered: planning) == planning,
           "switching back mid-pipeline restores Plan (was: dropped to Auto)")
    expect(ModePolicy.pickerSelectionAfterSessionChange(remembered: nil) == .auto,
           "a new or never-seen chat starts on Auto")
}

// ModePolicy.pickerModeAfterSessionChange — a cleared, new or switched
// conversation starts on Auto, from ANY origin. The one rule that overrules a
// hand-picked mode: a mode is chosen for a conversation, not for the panel,
// and the conversation it was chosen for is gone.
do {
    expect(ModePolicy.pickerModeAfterSessionChange(from: "plan") == ModePolicy.autoMode,
           "a flow-set mode does not survive the conversation it was set in")
    expect(ModePolicy.pickerModeAfterSessionChange(from: "execute") == ModePolicy.autoMode,
           "a hand-picked mode does not carry into a different conversation")
    expect(ModePolicy.pickerModeAfterSessionChange(from: "auto") == ModePolicy.autoMode,
           "Auto stays Auto")
    expect(ModePolicy.pickerModeAfterSessionChange(from: "not-a-mode") == ModePolicy.autoMode,
           "an unknown origin lands on Auto too — there is nothing else safe to land on")
    expect(ModePolicy.knownModes.contains(ModePolicy.pickerModeAfterSessionChange(from: "review")),
           "the landing mode is one the picker can actually hold")
}

// PlanTurnLanding — what a finished turn does to the chat's plan file, decided
// in one place from the last two messages. Order matters: a review landing
// never also rewrites the plan.
do {
    func turn(parked: Bool = false, update: Bool = false, review: Bool = false, done: Bool = true,
              saved: Bool = false, looksLikePlan: Bool = true, changedCode: Bool = false,
              verdict: PlanReviewVerdict? = nil, hasPlan: Bool = true) -> PlanTurnLanding.Turn {
        .init(pendingToolParked: parked, lastUserIsPlanUpdate: update, lastUserIsPlanReview: review,
              replyDone: done, replyAlreadySaved: saved, replyLooksLikePlan: looksLikePlan,
              turnChangedCode: changedCode, reviewVerdict: verdict, hasPlanFile: hasPlan)
    }
    expect(PlanTurnLanding.actions(for: turn(update: true)) == [.savePlanReply],
           "the reply to an update turn IS the rewritten plan — save it")
    expect(PlanTurnLanding.actions(for: turn(update: true, looksLikePlan: false)) == [],
           "an update turn that answered with a question leaves the old plan alone")
    expect(PlanTurnLanding.actions(for: turn(update: true, saved: true)) == [],
           "an already-saved reply is not saved twice")
    expect(PlanTurnLanding.actions(for: turn(changedCode: true, verdict: .changesRequested)) == [.updatePlanAfterFix],
           "review asked for changes and this turn edited a file — rewrite the plan")
    expect(PlanTurnLanding.actions(for: turn(update: true, changedCode: true, verdict: .changesRequested)) == [.savePlanReply],
           "the update turn itself never triggers another update — that is the loop")
    expect(PlanTurnLanding.actions(for: turn(changedCode: true, verdict: .changesRequested, hasPlan: false)) == [],
           "with no plan file there is nothing to update — this never CREATES one")
    expect(PlanTurnLanding.actions(for: turn(review: true)) == [.landReview],
           "the Review button's turn lands its verdict")
    expect(PlanTurnLanding.actions(for: turn(review: true, done: false)) == [.landReview],
           "a review lands even when the reply is not marked done (stopped review still releases the card)")
    expect(PlanTurnLanding.actions(for: turn(parked: true, update: true)) == [],
           "a parked proposal defers every landing to the answer")
}

// PlanExecutionTracker — the plan-run state machine the engine drives. Its two
// transition rules used to be inline `if`s in ChatEngine.finishStreamingTurn.
do {
    func tracker() -> PlanExecutionTracker {
        PlanExecutionTracker(planTitle: "t", steps: ["a", "b"], planCardMessageId: UUID())
    }
    func task(_ status: AgentTaskStatus) -> AgentTask {
        AgentTask(id: UUID().uuidString, title: "x", status: status)
    }
    var t = tracker()
    expect(t.settleInterrupted() && t.phase == .failed,
           "a Stop mid-run lands on .failed — the phase whose card carries Dismiss")
    expect(!t.settleInterrupted(),
           "settling an already-settled tracker is a no-op")

    t = tracker()
    expect(!t.apply(tasks: [task(.pending)], continueNeeded: true, pendingToolParked: false) && t.phase == .running,
           "pending tasks with the chain continuing keep the run open")
    expect(t.apply(tasks: [task(.completed)], continueNeeded: false, pendingToolParked: false) && t.phase == .finished,
           "all tasks completed and the chain ended: finished, release the picker")

    t = tracker()
    expect(t.apply(tasks: [task(.failed)], continueNeeded: true, pendingToolParked: false) == false && t.phase == .failed,
           "a failed task settles the tracker even mid-chain, but does NOT release while the chain continues")

    t = tracker()
    expect(!t.apply(tasks: [], continueNeeded: nil, pendingToolParked: false) && t.phase == .running,
           "an empty list with an external turn's nil carries no evidence — stay running")
    expect(!t.apply(tasks: [], continueNeeded: false, pendingToolParked: true) && t.phase == .running,
           "an empty list with a parked proposal is a card mid-plan, not the end")
    expect(t.apply(tasks: [], continueNeeded: false, pendingToolParked: false) && t.phase == .finished,
           "an empty list finishes only when the turn itself ended the chain")

    t = tracker()
    t.reviewPhase = .running
    expect(t.releaseInterruptedReview() && t.reviewPhase == .none,
           "a stopped review releases the finish card")
    expect(!t.releaseInterruptedReview(),
           "and nothing happens when no review was running")
}

// AgentV2Usage.billableTokens — the chat bubble's headline. Prompt caching is
// a pre-payment, not a discount (write 1.25×, read 0.1×), so a flat sum makes
// a cold turn and a warm turn look identical when they differ ~10× in cost.
// The two fixtures below are REAL turns from this install's usage ledger.
do {
    func billable(input: Int, output: Int, read: Int, write: Int?) -> Int {
        TokenCostPolicy.billableTokens(input: input, output: output, cacheRead: read, cacheWrite: write)
    }
    // Ledger id=497: a one-word "hello" on a cold cache. Everything was
    // WRITTEN, which bills ABOVE face value — the flat sum understated it.
    let coldProcessed = 20 + 6 + 0 + 52_102
    let cold = billable(input: 20, output: 6, read: 0, write: 52_102)
    expect(cold == 20 + 6 + Int((52_102.0 * 1.25).rounded()),
           "a cold turn bills ABOVE its raw count — every token was a 1.25× write")
    expect(cold > coldProcessed,
           "so the weighted headline must exceed the flat sum here, not undercut it")

    // Ledger id=487: a warm follow-up in the same chat. Nearly all of it was
    // READ at 0.1×, so the flat sum overstated the cost by roughly 10×.
    let warmProcessed = 20 + 6 + 52_592 + 228
    let warm = billable(input: 20, output: 6, read: 52_592, write: 228)
    expect(warm < warmProcessed / 8,
           "a warm turn bills under an eighth of its raw count")
    expect(cold > warm * 8,
           "cold vs warm is the ~10× gap the flat sum hid — the whole point of weighting")

    // A turn from a server too old to send cacheCreationTokens must not be
    // read as "zero writes billed at 1.25" — nil is unknown, and unknown
    // contributes nothing rather than silently inventing a cost.
    expect(billable(input: 100, output: 50, read: 1_000, write: nil) == 100 + 50 + 100,
           "an absent cache-write count contributes nothing, it is not a zero-cost claim")
    expect(billable(input: 0, output: 0, read: 0, write: 0) == 0,
           "an empty turn is zero, not a rounding artefact")
    expect(TokenCostPolicy.cacheWriteMultiplier > 1 && TokenCostPolicy.cacheReadMultiplier < 1,
           "caching is a pre-payment: writes cost MORE than fresh input, reads much less")
}

// Ask mode — read-only, the cheapest mode, and now pickable in the panel
// rather than only sendable by the quick chat / menu bar / phone.
do {
    // `knownModes` gates whether a server-resolved mode may move the picker,
    // and a mode the picker can hold but this set omits fails SILENTLY — no
    // error, the picker just never follows. Adding Ask hit exactly that, so
    // the set is now derived from the enum rather than hand-listed; these
    // two assertions pin the property that derivation buys.
    expect(ModePolicy.knownModes.contains("ask"),
           "Ask is resolvable — the quick chat has always sent it, the panel can now pick it")
    expect(ModePolicy.knownModes.count >= 7,
           "every picker mode is present, not a hand-copied subset that silently lost one")
    expect(ModePolicy.pickerMode(current: "auto", resolved: "ask") == "ask",
           "so a turn the server resolved to Ask moves the picker there, like any other mode")

    // A hand-picked Ask is the user's choice, so no lifecycle release takes it
    // back — `releasesStickyMode` only ever undoes a mode the FLOW set.
    for stages in [ModePolicy.planStages, ModePolicy.runStages,
                   ModePolicy.runAndReviewStages, ModePolicy.reviewStage] {
        expect(!ModePolicy.releasesStickyMode(current: "ask", releasing: stages),
               "a run ending never drags the user out of Ask — they chose it")
    }

    // Ask is not a planning mode, so asking for a plan from it still offers
    // the switch rather than answering the request read-only and silently
    // producing nothing.
    expect(PlanRequestPolicy.offersPlanSwitch(draft: "i want a plan to remove the dead code", currentMode: "ask"),
           "a plan request typed in Ask is offered the switch, like one typed in Execute")
    expect(!PlanRequestPolicy.offersPlanSwitch(draft: "what does this function do?", currentMode: "ask"),
           "but an ordinary question in Ask is exactly right — say nothing")
}

// AgentV2Transport's fresh-turn history. The retry after SESSION_UNRESUMABLE
// opens a context-blind SDK session; it now carries the chat the app already
// packed (`historyForRequest`), so "continue" does not start from nothing.
// The server reads it ONLY on a fresh turn (routes/agent-v2.mjs).
do {
    let field = AgentV2Conformance.freshHistoryField([("user", "Refactor the parser"), ("assistant", "Done")])
    expect(field == [["role": "user", "content": "Refactor the parser"], ["role": "assistant", "content": "Done"]],
           "fresh-turn history is sent as role/content pairs, in order")
    expect(AgentV2Conformance.freshHistoryField([]).isEmpty, "an empty chat sends no history")
}

// PurposeModelPolicy: which Settings model a chat mode uses. The Mac sends one
// `model` per turn, so the choice is made here, Mac-side, with no wire change.
do {
    expect(ModelPurpose(mode: "plan") == .planning && ModelPurpose(mode: "assist_plan") == .planning,
           "plan and assist_plan are the Planning purpose")
    expect(ModelPurpose(mode: "execute") == .coding && ModelPurpose(mode: "auto") == .coding,
           "execute and auto are the Coding purpose (auto is classified server-side, so Coding is the safe default)")
    expect(ModelPurpose(mode: "review") == .reviewing, "review is the Reviewing purpose")
    expect(ModelPurpose(mode: "document") == .documents && ModelPurpose(mode: "ask") == .documents,
           "document and ask are the Documents purpose")
    expect(ModelPurpose(mode: "auto_read_only") == .documents,
           "the phone's read-only auto mode answers questions, like Ask, so it is Documents")
    expect(ModelPurpose(mode: "bogus") == nil && ModelPurpose(mode: "") == nil,
           "an unknown mode has no purpose, so it falls back to the default model")

    let policy = PurposeModelPolicy(
        perPurpose: [.planning: "opus-x", .reviewing: "haiku-x", .coding: ""],
        defaultModelId: "sonnet-x")
    expect(policy.modelId(forMode: "plan") == "opus-x", "a set purpose model wins for its modes")
    expect(policy.modelId(forMode: "assist_plan") == "opus-x", "every mode of a purpose shares its model")
    expect(policy.modelId(forMode: "review") == "haiku-x", "Reviewing uses its own model")
    expect(policy.modelId(forMode: "execute") == "sonnet-x", "an EMPTY purpose model means the default model")
    expect(policy.modelId(forMode: "document") == "sonnet-x", "an unset purpose means the default model")
    expect(policy.modelId(forMode: "bogus") == "sonnet-x", "an unknown mode means the default model")
    expect(PurposeModelPolicy(perPurpose: [:], defaultModelId: "").modelId(forMode: "plan") == nil,
           "nothing configured sends no model, so the engine uses the account default")
    expect(PurposeModelPolicy(perPurpose: [.planning: "  "], defaultModelId: "d").modelId(forMode: "plan") == "d",
           "a whitespace-only purpose model counts as empty")

    expect(policy.modelId(forMode: "plan", explicit: "picked") == "picked",
           "a model the user picked in the composer beats the purpose setting")
    expect(policy.modelId(forMode: "plan", explicit: "") == "opus-x",
           "an empty explicit pick follows Settings")
    expect(policy.modelId(forMode: "plan", explicit: nil) == "opus-x", "no explicit pick follows Settings")
    // Auto Tasks only pin a model that was set FOR the purpose; the default
    // stays a hint to the usage chain, so an untouched install is unchanged.
    expect(policy.purposeModelId(forMode: "plan") == "opus-x", "a purpose model is reported for its mode")
    expect(policy.purposeModelId(forMode: "execute") == nil,
           "an empty purpose model is NOT reported (the default is not a purpose choice)")
    expect(policy.purposeModelId(forMode: "bogus") == nil, "an unknown mode has no purpose model")
    // A purpose id the provider no longer offers (retired, or picked for
    // another provider) must not be sent — the engine would reject it.
    let offered: Set<String> = ["opus-x", "sonnet-x"]
    expect(policy.modelId(forMode: "plan", explicit: nil, isOffered: { offered.contains($0) }) == "opus-x",
           "an offered purpose model is used")
    expect(policy.modelId(forMode: "review", explicit: nil, isOffered: { offered.contains($0) }) == "sonnet-x",
           "a purpose model the provider does not offer falls back to the default model")
    expect(policy.modelId(forMode: "plan", explicit: "picked", isOffered: { _ in false }) == "picked",
           "an explicit composer pick is never second-guessed here")
    expect(PurposeModelPolicy(perPurpose: [.planning: "gone"], defaultModelId: "")
               .modelId(forMode: "plan", explicit: nil, isOffered: { _ in false }) == nil,
           "an unoffered purpose model with no default sends no model")
    expect(Set(ModelPurpose.allCases.map(\.settingsKey)).count == ModelPurpose.allCases.count
           && ModelPurpose.allCases.allSatisfy { $0.settingsKey.hasPrefix("purposeModel.") },
           "each purpose persists under its own UserDefaults key")
}

print("EffortChoice + ProviderModelEntry")
do {
    expect(EffortChoice.effective(stored: "high", levels: ["low", "high"]) == "high",
           "a stored level the model lists is sent")
    expect(EffortChoice.effective(stored: "xhigh", levels: ["low", "high"]) == EffortChoice.auto,
           "a level this model lacks sends auto")
    expect(EffortChoice.effective(stored: "auto", levels: ["low"]) == EffortChoice.auto, "auto stays auto")
    expect(EffortChoice.effective(stored: "low", levels: []) == EffortChoice.auto,
           "a model without levels always sends auto")
    expect(EffortChoice.label("high") == "High" && EffortChoice.label("xhigh") == "Xhigh"
           && EffortChoice.label(EffortChoice.auto) == "Auto",
           "labels are the raw level, first letter capitalised — no table")
    expect(EffortChoice.defaultsKey == "chat.effort", "one app-wide UserDefaults key")

    let json = #"[{"id":"claude-sonnet-5","displayName":"Sonnet 5","effortLevels":["low","ultra"]},{"id":"claude-x"}]"#
    let entries = try? JSONDecoder().decode([ProviderModelEntry].self, from: Data(json.utf8))
    expect(entries?.first?.effortLevels == ["low", "ultra"], "effortLevels decode verbatim, unknown level included")
    expect(entries?.last?.effortLevels == [] && entries?.last?.displayName == nil,
           "an older server's entry (no effortLevels) decodes as []")
}

print("EffortChoice.levels")
do {
    let rows: [(id: String, levels: [String])] = [
        (id: "claude-opus-5[1m]", levels: ["high", "max"]),
        (id: "claude-sonnet-5", levels: ["low", "high"]),
    ]
    let base = { (id: String) in id.replacingOccurrences(of: "[1m]", with: "") }
    expect(EffortChoice.levels(forModelId: "claude-sonnet-5", in: rows, baseId: base) == ["low", "high"],
           "exact id match")
    expect(EffortChoice.levels(forModelId: "claude-opus-5", in: rows, baseId: base) == ["high", "max"],
           "a saved pick without the [1m] suffix still finds its model")
    expect(EffortChoice.levels(forModelId: "", in: rows, baseId: base) == ["high", "max"],
           "no model chosen = the SDK default, listed first")
    expect(EffortChoice.levels(forModelId: "claude-gone", in: rows, baseId: base) == [],
           "an unlisted model has no picker")
}

print("AgentV2ContextUsage")
do {
    let json = #"{"type":"context_usage","totalTokens":10460,"maxTokens":1000000,"percentage":1,"categories":[{"name":"System tools","kind":"used","tokens":1809},{"name":"Brand new","kind":"mystery","tokens":5}]}"#
    let usage = try? JSONDecoder().decode(AgentV2ContextUsage.self, from: Data(json.utf8))
    expect(usage?.totalTokens == 10460 && usage?.maxTokens == 1000000 && usage?.percentage == 1,
           "totals decode verbatim")
    expect(usage?.categories.map(\.name) == ["System tools", "Brand new"]
           && usage?.categories.last?.kind == "mystery",
           "an unknown kind still decodes — kinds are strings, never an enum")
    let empty = try? JSONDecoder().decode(AgentV2ContextUsage.self,
        from: Data(#"{"totalTokens":1,"maxTokens":2,"percentage":50,"categories":[]}"#.utf8))
    expect(empty?.categories.isEmpty == true, "no categories is valid")
}

print("ContextUsagePresentation")
do {
    func usage(_ pct: Int) -> AgentV2ContextUsage? {
        let json = #"{"totalTokens":10460,"maxTokens":1000000,"percentage":\#(pct),"categories":[{"name":"Free space","kind":"free","tokens":956540},{"name":"System tools","kind":"used","tokens":1809},{"name":"Autocompact buffer","kind":"buffer","tokens":33000},{"name":"Messages","kind":"used","tokens":2078}]}"#
        return try? JSONDecoder().decode(AgentV2ContextUsage.self, from: Data(json.utf8))
    }
    if let u = usage(1), let hot = usage(80), let cool = usage(79) {
        let rows = ContextUsagePresentation.rows(u)
        expect(rows.used.map(\.name) == ["System tools", "Messages"], "used rows first, in the SDK's order")
        expect(rows.other.map(\.name) == ["Free space", "Autocompact buffer"], "everything else after, in the SDK's order")
        expect(ContextUsagePresentation.percentLabel(u) == "1%", "percent label")
        expect(ContextUsagePresentation.tokensLabel(u) == "10,460 / 1,000,000 tokens", "tokens label, grouped")
        expect(ContextUsagePresentation.share(rows.used[1], of: u) == "0.2%", "share of the window, one decimal")
        expect(ContextUsagePresentation.isWarning(hot) && !ContextUsagePresentation.isWarning(cool),
               "warning from 80% inclusive")
        expect(ContextUsagePresentation.warningPercentage == 80, "threshold is 80")
    } else {
        expect(false, "fixture decodes")
    }
}

// Post-terminal event contract: the server sends `usage`, `result`,
// `context_usage`, then `tasks`. The transport drops everything after `result`
// except what this predicate accepts — `context_usage` must survive.
do {
    let contextUsageJSON = Data(#"{"type":"context_usage","totalTokens":10,"maxTokens":100,"percentage":10,"categories":[]}"#.utf8)
    let deltaJSON = Data(#"{"type":"delta","text":"late"}"#.utf8)
    expect(AgentV2Conformance.isAcceptedAfterTerminal(forJSON: contextUsageJSON) == true,
           "context_usage is accepted after the terminal result")
    expect(AgentV2Conformance.isAcceptedAfterTerminal(forJSON: deltaJSON) == false,
           "a delta after the terminal result is dropped")
}

// Tier roles: the four chat modes are Mac-only roles; what an unset role runs
// depends on where it runs (Standard on the Mac, the server's own default there).
print("Tier roles")
do {
    expect(RoutedFeature.allCases.filter { $0.group == .chat }.map(\.rawValue)
               == ["chatPlanning", "chatCoding", "chatReviewing", "chatDocuments"],
           "the four chat-mode roles exist with stable raw values")
    expect([RoutedFeature.loop, .autoTasks, .quickChat].allSatisfy { $0.group == .background && $0.unsetLabel == "Standard" },
           "Loop, Auto Tasks and Quick chat are Mac roles whose unset value is Standard")
    expect([RoutedFeature.subagents, .pipeline, .internal].allSatisfy { $0.group == .server && $0.unsetLabel == "Built-in default" },
           "server roles left unset keep the server's built-in default")
    expect(RoutedFeature.chatCoding.unsetLabel == "Standard", "an unset chat role means Standard")
    expect(RoutedFeatureGroup.allCases.map(\.title) == ["Chat (by mode)", "Background (this Mac)", "Server"],
           "Settings groups the roles in this order")
    expect(TierRoutingConfig(tiers: ["standard": TierRoute(provider: "anthropic", model: "m")])
               .tier(.standard)?.model == "m",
           "the routing table is readable from outside the app target")
}

// Standard is the default: saving it writes the legacy default fields the ~20
// readers still use. Built-ins map to their AICliTool raw value; a custom
// provider cannot live in activeCLI, so it only sets the composer override.
print("TierDefaults write-through")
do {
    expect(TierDefaults.writeThrough(for: TierRoute(provider: "anthropic", model: "claude-opus-5"))
               == StandardWriteThrough(activeCLI: "claude_code", defaultModelId: "claude-opus-5", composerProviderId: ""),
           "anthropic Standard writes activeCLI claude_code + its model and clears the composer override")
    expect(TierDefaults.writeThrough(for: TierRoute(provider: "openai", model: "gpt-5.5"))?.activeCLI == "openai",
           "openai maps to openai")
    expect(TierDefaults.writeThrough(for: TierRoute(provider: "google", model: "gemini-3.6-flash"))?.activeCLI == "gemini",
           "google maps to gemini")
    expect(TierDefaults.writeThrough(for: TierRoute(provider: "deepseek", model: "deepseek-chat"))?.activeCLI == "deepseek",
           "deepseek maps to deepseek")
    expect(TierDefaults.writeThrough(for: TierRoute(provider: "custom:p1", model: "glm-5"))
               == StandardWriteThrough(activeCLI: nil, defaultModelId: nil, composerProviderId: "p1"),
           "a custom Standard leaves activeCLI/defaultModelId and points the composer at it")
    expect(TierDefaults.writeThrough(for: TierRoute(provider: "custom", model: "llama-3"))
               == StandardWriteThrough(activeCLI: "custom", defaultModelId: "llama-3", composerProviderId: ""),
           "the shared Custom endpoint is a Standard: activeCLI custom + its model, composer override cleared")
    expect(TierDefaults.isApplied(TierRoute(provider: "custom", model: "llama-3"), activeCLI: "custom",
                                  defaultModelId: "llama-3", composerProviderId: "", customProviders: []),
           "a shared-Custom Standard written through is applied")
    expect(TierDefaults.writeThrough(for: TierRoute(provider: "anthropic", model: "  ")) == nil,
           "no model: nothing is written")
    expect(TierDefaults.writeThrough(for: TierRoute(provider: "glm", model: "glm-5")) == nil,
           "an unknown provider is never written into activeCLI")
    expect(TierDefaults.providerWireId(forActiveCLI: "claude_code") == "anthropic"
               && TierDefaults.providerWireId(forActiveCLI: "gemini") == "google"
               && TierDefaults.providerWireId(forActiveCLI: "") == "anthropic",
           "activeCLI reads as its wire provider; empty reads as Claude like AppConfig's readers")
    expect(ModelPurpose.allCases.allSatisfy { TierDefaults.purpose(for: TierDefaults.chatFeature(for: $0)) == $0 },
           "every purpose has exactly one chat role and back")
    expect(TierDefaults.purpose(for: .loop) == nil, "a non-chat role has no purpose")
    expect(TierDefaults.migratedFlagKey == "tierDefaultMigrated" && TierDefaults.composerProviderKey == "codeAssistProvider",
           "persisted keys are stable")
}

// Chat roles are Mac-only: the server would drop them as unknown_feature and
// Settings would list them as "ignored".
print("TierDefaults wire body")
do {
    let table = TierRoutingConfig(tiers: ["standard": TierRoute(provider: "anthropic", model: "m")],
                                  features: ["chatPlanning": "strong", "chatDocuments": "cheap",
                                             "loop": "cheap", "futureRole": "cheap"])
    let wire = TierDefaults.wireBody(table)
    expect(wire.features == ["loop": "cheap", "futureRole": "cheap"],
           "chat roles are stripped; server, background and unknown (newer build) roles are sent")
    expect(wire.tiers == table.tiers, "tiers are sent unchanged")
    let shared = TierRoutingConfig(tiers: ["standard": TierRoute(provider: "custom", model: "llama-3"),
                                           "cheap": TierRoute(provider: "custom:p1", model: "glm-5")],
                                   features: ["pipeline": "standard"])
    let sharedWire = TierDefaults.wireBody(shared)
    expect(sharedWire.tiers == ["cheap": TierRoute(provider: "custom:p1", model: "glm-5")],
           "a tier on the shared Custom endpoint (bare `custom`) is never sent; a named custom provider is")
    expect(sharedWire.features == ["pipeline": "standard"],
           "a server role on that tier is still sent: the server finds the tier unset and keeps its built-in default")
    expect(TierDefaults.isMacOnlyProvider("custom") && !TierDefaults.isMacOnlyProvider("custom:p1")
               && !TierDefaults.isMacOnlyProvider("anthropic"),
           "only the bare shared endpoint is Mac-only")
}

// Which tier a role resolves through (the resolver then applies every
// usability check — agent engine, local CLI, server status — and falls back to
// activeCLI when the route can't be used). An unset Background role runs a
// custom Standard; a built-in Standard already IS activeCLI.
print("TierDefaults effective tier")
do {
    let customStd = TierRoutingConfig(tiers: ["standard": TierRoute(provider: "custom:p1", model: "glm-5"),
                                              "cheap": TierRoute(provider: "openai", model: "gpt-5.4-mini")],
                                      features: ["autoTasks": "cheap"])
    expect([RoutedFeature.loop, .quickChat]
               .allSatisfy { TierDefaults.effectiveTier(for: $0, routing: customStd, composerProviderId: "p1") == .standard },
           "unset Loop / Quick chat resolve through an applied custom Standard (the override names it)")
    expect([RoutedFeature.loop, .quickChat].allSatisfy {
               TierDefaults.effectiveTier(for: $0, routing: customStd, composerProviderId: "") == nil
                   && TierDefaults.effectiveTier(for: $0, routing: customStd, composerProviderId: "p2") == nil
           },
           "a custom Standard never applied (no or another override): Background roles keep activeCLI")
    expect(TierDefaults.effectiveTier(for: .autoTasks, routing: customStd, composerProviderId: "p1") == .cheap,
           "a set role keeps its own tier")
    expect([RoutedFeature.pipeline, .subagents, .internal, .chatCoding]
               .allSatisfy { TierDefaults.effectiveTier(for: $0, routing: customStd, composerProviderId: "p1") == nil },
           "unset server roles keep the built-in default; unset chat modes keep the chat's default")
    let builtInStd = TierRoutingConfig(tiers: ["standard": TierRoute(provider: "anthropic", model: "claude-opus-5")])
    expect(TierDefaults.effectiveTier(for: .loop, routing: builtInStd, composerProviderId: "") == nil,
           "a built-in Standard: unset Background roles read activeCLI, which IS Standard (mode models kept)")
    let sharedStd = TierRoutingConfig(tiers: ["standard": TierRoute(provider: "custom", model: "llama-3")])
    expect(TierDefaults.effectiveTier(for: .quickChat, routing: sharedStd, composerProviderId: "") == nil,
           "a shared-Custom Standard is activeCLI too")
    expect(TierDefaults.effectiveTier(for: .loop, routing: TierRoutingConfig(), composerProviderId: "p1") == nil, "no Standard: nothing routes")
}

// Chat modes from tiers: a mode's tier swaps only the MODEL, so it applies
// only to chats already on that tier's provider. Precedence is unchanged:
// explicit composer pick → mode tier model → default (Standard).
print("TierDefaults purpose policy")
do {
    let routing = TierRoutingConfig(
        tiers: ["strong": TierRoute(provider: "anthropic", model: "claude-opus-5"),
                "cheap": TierRoute(provider: "openai", model: "gpt-5.4-mini"),
                "standard": TierRoute(provider: "anthropic", model: "claude-sonnet-5")],
        features: ["chatPlanning": "strong", "chatReviewing": "cheap"])
    let onClaude = TierDefaults.purposePolicy(chatProvider: "anthropic", routing: routing, legacy: [:],
                                              legacyProvider: "anthropic", defaultModelId: "claude-sonnet-5")
    expect(onClaude.modelId(forMode: "plan") == "claude-opus-5", "a mode's tier model is used on its provider")
    expect(onClaude.modelId(forMode: "execute") == "claude-sonnet-5", "an unset chat role means Standard")
    expect(onClaude.modelId(forMode: "review") == "claude-sonnet-5",
           "a tier on another provider is skipped (a v2 Claude chat never takes an OpenAI mode tier)")
    expect(onClaude.modelId(forMode: "plan", explicit: "picked") == "picked", "an explicit composer pick still wins")
    expect(onClaude.modelId(forMode: "plan", explicit: nil, isOffered: { $0 != "claude-opus-5" }) == "claude-sonnet-5",
           "a tier model the provider does not offer falls back to the default")
    let onOpenAI = TierDefaults.purposePolicy(chatProvider: "openai", routing: routing, legacy: [:],
                                              legacyProvider: "anthropic", defaultModelId: "gpt-5.5")
    expect(onOpenAI.modelId(forMode: "review") == "gpt-5.4-mini" && onOpenAI.modelId(forMode: "plan") == "gpt-5.5",
           "an OpenAI chat takes only the OpenAI tier")

    let legacy: [ModelPurpose: String] = [.coding: "claude-haiku-5", .reviewing: "claude-old"]
    let withLegacy = TierDefaults.purposePolicy(chatProvider: "anthropic", routing: routing, legacy: legacy,
                                                legacyProvider: "anthropic", defaultModelId: "claude-sonnet-5")
    expect(withLegacy.modelId(forMode: "execute") == "claude-haiku-5",
           "a legacy purpose model is honoured while its role is unset")
    expect(withLegacy.modelId(forMode: "review") == "claude-sonnet-5",
           "a set role replaces the legacy value, even when its tier does not apply here")
    expect(TierDefaults.purposePolicy(chatProvider: "openai", routing: TierRoutingConfig(), legacy: legacy,
                                      legacyProvider: "anthropic", defaultModelId: "gpt-5.5")
               .modelId(forMode: "execute") == "gpt-5.5",
           "a legacy value only applies on the provider it was picked for")

    let custom = TierRoutingConfig(tiers: ["cheap": TierRoute(provider: "custom:p1", model: "glm-5-turbo")],
                                   features: ["chatCoding": "cheap"])
    let onCustom = TierDefaults.purposePolicy(chatProvider: "custom:p1", routing: custom, legacy: [:],
                                              legacyProvider: "anthropic", defaultModelId: "glm-5")
    expect(onCustom.modelId(forMode: "execute") == "glm-5-turbo" && onCustom.modelId(forMode: "plan") == "glm-5",
           "a custom provider's chats take a tier on that same custom provider")
    let roleWithoutTier = TierRoutingConfig(features: ["chatPlanning": "strong"])
    expect(TierDefaults.purposePolicy(chatProvider: "anthropic", routing: roleWithoutTier, legacy: [.planning: "x"],
                                      legacyProvider: "anthropic", defaultModelId: "d").modelId(forMode: "plan") == "d",
           "a role on an unset tier means the default")
}

// Migration: Standard from the old default; purpose models onto tiers.
// INVARIANT: for every chat mode and every Mac role, the provider + model is
// identical before and after.
print("TierDefaults migration")
do {
    let modes = ["plan", "assist_plan", "execute", "auto", "review", "document", "ask", "auto_read_only", "bogus"]
    func input(activeCLI: String = "claude_code", defaultModelId: String = "claude-sonnet-5",
               purposes: [ModelPurpose: String] = [:], composer: String = "",
               customs: [TierCustomProviderSummary] = [],
               routing: TierRoutingConfig = TierRoutingConfig()) -> TierMigrationInput {
        TierMigrationInput(routing: routing, activeCLI: activeCLI, defaultModelId: defaultModelId,
                           purposeModelIds: purposes, composerProviderId: composer, customProviders: customs)
    }
    /// Built-in chats send the same model for every mode, and Standard's
    /// write-through leaves the Mac roles' activeCLI / defaultModelId as they were.
    func invariantHolds(_ given: TierMigrationInput, isOffered: (String) -> Bool = { _ in true }) -> Bool {
        let result = TierDefaults.migrate(given, includePurposes: true)
        let provider = TierDefaults.providerWireId(forActiveCLI: given.activeCLI)
        let before = PurposeModelPolicy(perPurpose: given.purposeModelIds, defaultModelId: given.defaultModelId)
        let after = TierDefaults.purposePolicy(chatProvider: provider, routing: result.routing,
                                               legacy: result.purposeModelIds, legacyProvider: provider,
                                               defaultModelId: given.defaultModelId)
        let chatsSame = modes.allSatisfy {
            before.modelId(forMode: $0, explicit: nil, isOffered: isOffered)
                == after.modelId(forMode: $0, explicit: nil, isOffered: isOffered)
        }
        // Background roles: the tier route each resolves through must not move
        // (an unset role runs a custom Standard — TierDefaults.effectiveTier).
        let background = RoutedFeature.allCases.filter { $0.group == .background }
        // BEFORE uses the pre-branch rule (an unset role read activeCLI = no
        // route), so a change caused by new resolver code is caught too.
        let routesSame = background.allSatisfy { feature in
            given.routing.tier(for: feature).flatMap(given.routing.tier)
                == TierDefaults.effectiveTier(for: feature, routing: result.routing,
                                              composerProviderId: given.composerProviderId).flatMap(result.routing.tier)
        }
        guard given.routing.tier(.standard) == nil, let standard = result.routing.tier(.standard) else {
            return chatsSame && routesSame
        }
        let write = TierDefaults.writeThrough(for: standard)
        let rolesSame = (write?.activeCLI ?? given.activeCLI) == given.activeCLI
            && (write?.defaultModelId ?? given.defaultModelId) == given.defaultModelId
        return chatsSame && routesSame && rolesSame
    }

    // 1. All default.
    let plain = input()
    let plainResult = TierDefaults.migrate(plain, includePurposes: true)
    expect(plainResult.routing.tier(.standard) == TierRoute(provider: "anthropic", model: "claude-sonnet-5"),
           "an untouched install gets Standard = its current default provider + model")
    expect(plainResult.routing.features.isEmpty && plainResult.purposeModelIds.isEmpty, "no purposes, no roles")
    expect(invariantHolds(plain), "all-default: nothing changes")

    // 2. Purposes set.
    let some = input(purposes: [.planning: "claude-opus-5", .coding: "", .reviewing: "claude-haiku-5",
                                .documents: "claude-sonnet-5"])
    let someResult = TierDefaults.migrate(some, includePurposes: true)
    expect(someResult.routing.tier(.strong) == TierRoute(provider: "anthropic", model: "claude-opus-5")
               && someResult.routing.tier(.cheap) == TierRoute(provider: "anthropic", model: "claude-haiku-5"),
           "distinct purpose models take Strong, then Cheap")
    expect(someResult.routing.features == ["chatPlanning": "strong", "chatReviewing": "cheap", "chatDocuments": "standard"],
           "a purpose equal to Standard reuses Standard; an empty purpose gets no role")
    expect(someResult.purposeModelIds.isEmpty, "migrated (and empty) purposes are cleared")
    expect(invariantHolds(some), "purposes set: nothing changes")

    // 3. More distinct purposes than free tiers.
    let many = input(purposes: [.planning: "m-a", .coding: "m-b", .reviewing: "m-c", .documents: "m-d"])
    let manyResult = TierDefaults.migrate(many, includePurposes: true)
    expect(manyResult.routing.features == ["chatPlanning": "strong", "chatCoding": "cheap"],
           "only Strong and Cheap are free, so two purposes get roles")
    expect(manyResult.purposeModelIds == [.reviewing: "m-c", .documents: "m-d"],
           "the rest stay as legacy values Settings names")
    expect(invariantHolds(many), "a legacy value keeps being honoured")

    // 4. Composer on an enabled custom provider: NOT promoted to Standard.
    // Promoting it would move unset Loop / Quick chat onto it (they run a
    // custom Standard), so Standard comes from activeCLI + defaultModelId.
    let glm = TierCustomProviderSummary(id: "p1", isEnabled: true, firstModelId: "glm-5", name: "Zhipu")
    let customCase = input(purposes: [.planning: "claude-opus-5"], composer: "p1", customs: [glm])
    let customResult = TierDefaults.migrate(customCase, includePurposes: true)
    expect(customResult.routing.tier(.standard) == TierRoute(provider: "anthropic", model: "claude-sonnet-5"),
           "an enabled custom composer override is left alone; Standard = activeCLI + defaultModelId")
    expect(customResult.routing.tier(.strong) == TierRoute(provider: "anthropic", model: "claude-opus-5"),
           "purpose ids keep the provider they were picked for (activeCLI's)")
    expect(invariantHolds(customCase), "chats and every Background role's route are unchanged")
    expect([RoutedFeature.loop, .autoTasks, .quickChat]
               .allSatisfy { TierDefaults.effectiveTier(for: $0, routing: customResult.routing, composerProviderId: "p1") == nil },
           "Loop / Auto Tasks / Quick chat keep reading activeCLI")
    let customPolicy = TierDefaults.purposePolicy(chatProvider: "custom:p1", routing: customResult.routing,
                                                  legacy: customResult.purposeModelIds, legacyProvider: "anthropic",
                                                  defaultModelId: "glm-5")
    expect(modes.allSatisfy { customPolicy.modelId(forMode: $0) == "glm-5" },
           "chats on the custom provider still send its model in every mode, as before")
    let migratedStd = customResult.routing.tier(.standard) ?? TierRoute(provider: "", model: "")
    expect(!TierDefaults.isApplied(migratedStd, activeCLI: "claude_code", defaultModelId: "claude-sonnet-5",
                                   composerProviderId: "p1", customProviders: [glm])
               && TierDefaults.describeCurrentDefault(activeCLI: "claude_code", defaultModelId: "claude-sonnet-5",
                                                      composerProviderId: "p1", customProviders: [glm],
                                                      standard: migratedStd) == "Zhipu · glm-5",
           "Settings then shows 'New chats still use Zhipu · glm-5' with Make Standard the default")
    let disabled = TierCustomProviderSummary(id: "p1", isEnabled: false, firstModelId: "glm-5")
    expect(TierDefaults.migrate(input(composer: "p1", customs: [disabled]), includePurposes: true).routing.tier(.standard)
               == TierRoute(provider: "anthropic", model: "claude-sonnet-5"),
           "a disabled override: Standard from activeCLI")
    let noModels = TierCustomProviderSummary(id: "p2", isEnabled: true, firstModelId: nil)
    expect(TierDefaults.migrate(input(composer: "p2", customs: [noModels]), includePurposes: true).routing.tier(.standard)
               == TierRoute(provider: "anthropic", model: "claude-sonnet-5"),
           "an override with no model: Standard from activeCLI too")

    // 5. Already migrated: purposes untouched; Standard still filled while unset, never overwritten.
    let again = TierDefaults.migrate(many, includePurposes: false)
    expect(again.routing.features.isEmpty && again.purposeModelIds == many.purposeModelIds,
           "a second run never re-migrates purposes")
    expect(again.routing.tier(.standard) != nil, "Standard is still filled while unset")
    let kept = TierRoutingConfig(tiers: ["standard": TierRoute(provider: "openai", model: "gpt-5.5")])
    expect(TierDefaults.migrate(input(routing: kept), includePurposes: false).routing == kept,
           "an existing Standard is never overwritten")

    // 6. Claude's live list not loaded yet: no default model to name.
    let noModel = input(defaultModelId: "", purposes: [.planning: "claude-opus-5"])
    let noModelResult = TierDefaults.migrate(noModel, includePurposes: true)
    expect(noModelResult.routing.tier(.standard) == nil,
           "Standard stays unset (Settings warns) instead of storing model \"\"")
    expect(noModelResult.routing.features["chatPlanning"] == "strong", "purposes still migrate")
    expect(invariantHolds(noModel), "no model: still nothing changes")

    // 7. A retired purpose id: filtered at send both before and after.
    expect(invariantHolds(input(purposes: [.planning: "claude-opus-4-7"]), isOffered: { $0 != "claude-opus-4-7" }),
           "a retired purpose id is skipped at send before AND after, so the default is sent both times")

    // 8. The shared Custom endpoint is a tier provider; GLM / Copilot are not.
    let shared = input(activeCLI: "custom", defaultModelId: "llama-3", purposes: [.coding: "qwen-3"])
    let sharedResult = TierDefaults.migrate(shared, includePurposes: true)
    expect(sharedResult.routing.tier(.standard) == TierRoute(provider: "custom", model: "llama-3"),
           "a shared-Custom default becomes Standard (no permanent 'not set' warning)")
    expect(sharedResult.routing.tier(.strong) == TierRoute(provider: "custom", model: "qwen-3")
               && sharedResult.routing.features["chatCoding"] == "strong" && sharedResult.purposeModelIds.isEmpty,
           "its purpose models move onto tiers like any built-in's")
    expect(invariantHolds(shared), "shared Custom: nothing changes")
    let sharedNoModel = input(activeCLI: "custom", defaultModelId: "", purposes: [.coding: "qwen-3"])
    expect(TierDefaults.migrate(sharedNoModel, includePurposes: true).routing.tier(.standard) == nil
               && invariantHolds(sharedNoModel),
           "a shared-Custom default with no model leaves Standard unset, never model \"\"")
    let glmDefault = input(activeCLI: "glm", defaultModelId: "glm-5", purposes: [.coding: "glm-5-air"])
    let glmResult = TierDefaults.migrate(glmDefault, includePurposes: true)
    expect(glmResult.routing.tier(.standard) == nil && glmResult.purposeModelIds == [.coding: "glm-5-air"],
           "an unrepresentable default (GLM) leaves Standard unset and purposes as legacy")
    expect(TierDefaults.standardFromLegacy(activeCLI: "copilot", defaultModelId: "gpt-4o") == nil,
           "Copilot would read back as openai, so it is not a Standard")
    expect(invariantHolds(glmDefault), "unrepresentable: nothing changes")

    // 9. No free tier: Strong and Cheap already used by other roles.
    let busy = TierRoutingConfig(tiers: ["strong": TierRoute(provider: "anthropic", model: "claude-opus-5"),
                                         "cheap": TierRoute(provider: "openai", model: "gpt-5.4-mini")],
                                 features: ["loop": "cheap"])
    let busyCase = input(purposes: [.planning: "claude-opus-5", .reviewing: "claude-haiku-5"], routing: busy)
    let busyResult = TierDefaults.migrate(busyCase, includePurposes: true)
    expect(busyResult.routing.features["chatPlanning"] == "strong", "an equal tier is reused")
    expect(busyResult.purposeModelIds == [.reviewing: "claude-haiku-5"] && busyResult.routing.tier(.cheap) == busy.tier(.cheap)
               && busyResult.routing.features["loop"] == "cheap",
           "no free tier: kept as legacy, other roles' tiers untouched")
    expect(invariantHolds(busyCase), "busy tiers: nothing changes")

    // 10. An EMPTY tier a role already points at is not free: filling it would
    // move that role off its built-in default.
    let referenced = TierRoutingConfig(features: ["pipeline": "strong"])
    let referencedCase = input(purposes: [.planning: "claude-opus-5"], routing: referenced)
    let referencedResult = TierDefaults.migrate(referencedCase, includePurposes: true)
    expect(referencedResult.routing.tier(.strong) == nil,
           "Pipeline → Strong (empty) keeps Strong empty")
    expect(referencedResult.routing.tier(.cheap) == TierRoute(provider: "anthropic", model: "claude-opus-5")
               && referencedResult.routing.features["chatPlanning"] == "cheap"
               && referencedResult.routing.features["pipeline"] == "strong",
           "the purpose takes the next free tier; the role's choice is untouched")
    let bothReferenced = TierRoutingConfig(features: ["pipeline": "strong", "internal": "cheap"])
    let bothResult = TierDefaults.migrate(input(purposes: [.planning: "claude-opus-5"], routing: bothReferenced),
                                          includePurposes: true)
    expect(bothResult.routing.tier(.strong) == nil && bothResult.routing.tier(.cheap) == nil
               && bothResult.purposeModelIds == [.planning: "claude-opus-5"],
           "no unreferenced tier: the purpose stays a legacy value")
    expect(invariantHolds(referencedCase), "referenced tiers: nothing changes")

    // 11. Standard = custom:p1 saved BEFORE this update (◉ was Claude, never
    // written through): Loop / Quick chat ran Claude and must keep doing so.
    let preCustomStd = TierRoutingConfig(tiers: ["standard": TierRoute(provider: "custom:p1", model: "glm-5")])
    let p1 = TierCustomProviderSummary(id: "p1", isEnabled: true, firstModelId: "glm-5")
    expect(invariantHolds(input(customs: [p1], routing: preCustomStd)),
           "a pre-existing, unapplied custom Standard (no override) does not move Background roles")
    expect(invariantHolds(input(composer: "p2", customs: [p1], routing: preCustomStd)),
           "…nor with an override on another provider")
}

print("TierDefaults Settings wording")
do {
    expect(TierDefaults.describeCurrentDefault(activeCLI: "claude_code", defaultModelId: "claude-opus-5",
                                               composerProviderId: "", customProviders: []) == "Claude · claude-opus-5",
           "the current default names provider and model")
    expect(TierDefaults.describeCurrentDefault(activeCLI: "claude_code", defaultModelId: "",
                                               composerProviderId: "", customProviders: []) == "Claude · account default",
           "no model (Claude's list not loaded) reads as the account default")
    let p1 = TierCustomProviderSummary(id: "p1", isEnabled: true, firstModelId: "glm-5", name: "Zhipu")
    let p2 = TierCustomProviderSummary(id: "p2", isEnabled: true, firstModelId: "kimi-k3", name: "Moonshot")
    // Leftover override on a built-in Standard: new chats run on p1, not Standard.
    expect(!TierDefaults.isApplied(TierRoute(provider: "anthropic", model: "claude-opus-5"), activeCLI: "claude_code",
                                   defaultModelId: "claude-opus-5", composerProviderId: "p1", customProviders: [p1, p2])
               && TierDefaults.describeCurrentDefault(activeCLI: "claude_code", defaultModelId: "claude-opus-5",
                                                      composerProviderId: "p1", customProviders: [p1, p2]) == "Zhipu · glm-5",
           "a leftover custom override is what the row names, not Standard")
    // Custom Standard p1 vs a different override p2.
    expect(!TierDefaults.isApplied(TierRoute(provider: "custom:p1", model: "glm-5"), activeCLI: "claude_code",
                                   defaultModelId: "claude-opus-5", composerProviderId: "p2", customProviders: [p1, p2])
               && TierDefaults.describeCurrentDefault(activeCLI: "claude_code", defaultModelId: "claude-opus-5",
                                                      composerProviderId: "p2", customProviders: [p1, p2]) == "Moonshot · kimi-k3",
           "a custom Standard vs another override names the override")
    expect(TierDefaults.describeCurrentDefault(activeCLI: "openai", defaultModelId: "gpt-5.5", composerProviderId: "p1",
                                               customProviders: [TierCustomProviderSummary(id: "p1", isEnabled: false,
                                                                                           firstModelId: "glm-5", name: "Zhipu")])
               == "OpenAI · gpt-5.5"
               && TierDefaults.describeCurrentDefault(activeCLI: "openai", defaultModelId: "gpt-5.5", composerProviderId: "gone",
                                                      customProviders: [p1]) == "OpenAI · gpt-5.5",
           "a disabled or deleted override is ignored, as the composer ignores it")
    expect(TierDefaults.describeCurrentDefault(activeCLI: "claude_code", defaultModelId: "", composerProviderId: "p3",
                                               customProviders: [TierCustomProviderSummary(id: "p3", isEnabled: true,
                                                                                           firstModelId: nil)])
               == "p3 · no model",
           "an unnamed override with no models falls back to its id")
    expect(TierDefaults.standardWarning(isSet: false, unusableReason: nil,
                                        currentDefault: TierDefaults.describeCurrentDefault(
                                            activeCLI: "claude_code", defaultModelId: "", composerProviderId: "p1",
                                            customProviders: [p1]))
               == "Standard isn't set — new chats and roles on Standard keep using Zhipu · glm-5 until you choose one.",
           "the unset warning names the override new chats really use")
    let std = TierRoute(provider: "anthropic", model: "claude-opus-5")
    expect(TierDefaults.isApplied(std, activeCLI: "claude_code", defaultModelId: "claude-opus-5", composerProviderId: "",
                                  customProviders: []),
           "a written-through Standard is applied")
    expect(!TierDefaults.isApplied(std, activeCLI: "openai", defaultModelId: "gpt-5.5", composerProviderId: "",
                                   customProviders: []),
           "a Standard saved before this update and never written through is reported")
    expect(!TierDefaults.isApplied(std, activeCLI: "claude_code", defaultModelId: "claude-opus-5", composerProviderId: "p1",
                                   customProviders: [p1]),
           "a leftover custom override means new chats are not on Standard")
    expect(TierDefaults.isApplied(TierRoute(provider: "custom:p1", model: "glm-5"), activeCLI: "openai",
                                  defaultModelId: "gpt-5.5", composerProviderId: "p1", customProviders: [p1]),
           "a custom Standard is applied through the override alone")
    // I1: a custom Standard is provider + model — the composer starts on Standard's model.
    let zhipu = TierCustomProviderSummary(id: "p1", isEnabled: true, firstModelId: "glm-5", name: "Zhipu",
                                          modelIds: ["glm-5", "glm-5-turbo"])
    let turbo = TierRoute(provider: "custom:p1", model: "glm-5-turbo")
    expect(TierDefaults.composerStartModel(customProviderId: "p1", modelIds: zhipu.modelIds, standard: turbo) == "glm-5-turbo",
           "the composer starts on Standard's model when the override is Standard's custom provider")
    expect(TierDefaults.composerStartModel(customProviderId: "p1", modelIds: ["glm-5"], standard: turbo) == "glm-5"
               && TierDefaults.composerStartModel(customProviderId: "p2", modelIds: ["kimi-k3"], standard: turbo) == "kimi-k3"
               && TierDefaults.composerStartModel(customProviderId: "p1", modelIds: [], standard: turbo) == "",
           "else the provider's first model (Standard's model unlisted, or another provider)")
    expect(TierDefaults.isApplied(turbo, activeCLI: "claude_code", defaultModelId: "claude-opus-5",
                                  composerProviderId: "p1", customProviders: [zhipu])
               && TierDefaults.describeCurrentDefault(activeCLI: "claude_code", defaultModelId: "claude-opus-5",
                                                      composerProviderId: "p1", customProviders: [zhipu], standard: turbo)
               == "Zhipu · glm-5-turbo",
           "a custom Standard on a non-first model is applied and named by its own model")
    let zhipuNoTurbo = TierCustomProviderSummary(id: "p1", isEnabled: true, firstModelId: "glm-5", name: "Zhipu",
                                                 modelIds: ["glm-5"])
    expect(!TierDefaults.isApplied(turbo, activeCLI: "claude_code", defaultModelId: "claude-opus-5",
                                   composerProviderId: "p1", customProviders: [zhipuNoTurbo])
               && TierDefaults.describeCurrentDefault(activeCLI: "claude_code", defaultModelId: "claude-opus-5",
                                                      composerProviderId: "p1", customProviders: [zhipuNoTurbo],
                                                      standard: turbo) == "Zhipu · glm-5",
           "a custom Standard whose model the provider no longer lists is reported, naming what runs")
    expect(!TierDefaults.isApplied(turbo, activeCLI: "claude_code", defaultModelId: "claude-opus-5",
                                   composerProviderId: "p1", customProviders: []),
           "a custom Standard on a deleted provider is not applied")
    expect(TierDefaults.standardWarning(isSet: false, unusableReason: nil, currentDefault: "Claude · account default")
               == "Standard isn't set — new chats and roles on Standard keep using Claude · account default until you choose one.",
           "an unset Standard (e.g. Claude's list was empty at migration) is warned about")
    expect(TierDefaults.standardWarning(isSet: true, unusableReason: "its provider was deleted", currentDefault: "Claude · claude-opus-5")
               == "Standard can't be used — its provider was deleted. New chats keep using Claude · claude-opus-5, the last default.",
           "an unusable Standard (deleted/disabled custom) keeps the last written default")
    expect(TierDefaults.standardWarning(isSet: true, unusableReason: nil, currentDefault: "x") == nil, "a usable Standard has no warning")
    expect(TierDefaults.legacyNote(purpose: .planning, model: "claude-opus-4-7")
               == "Planning: kept old model claude-opus-4-7 — choose a tier to replace it",
           "a legacy purpose value is named on its row")
    expect(TierDefaults.chatRoleProviderNote(providerName: "OpenAI") == "used only in chats on OpenAI",
           "a chat role says which chats it applies to")
    expect(TierDefaults.modesHelp(.coding) == "Used by Execute and Auto", "row help names the modes")
}

if failures.isEmpty {
    print("chat-contract-lab: all assertions passed")
} else {
    print("chat-contract-lab: \(failures.count) FAILED")
    exit(1)
}
