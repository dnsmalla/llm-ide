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

if failures.isEmpty {
    print("chat-contract-lab: all assertions passed")
} else {
    print("chat-contract-lab: \(failures.count) FAILED")
    exit(1)
}
