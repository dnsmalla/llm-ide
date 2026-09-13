import SwiftUI

/// The plan the "Edit" action opened for hand-editing, identified by the
/// assistant message it came from. Carried on `CodeAssistantSheetState` so the
/// sheet is driven by `.sheet(item:)` — a nil target IS the dismissed state,
/// so a stale draft can never be re-presented against a different message.
struct PlanEditTarget: Identifiable, Equatable {
    /// The v2 assistant RESULT message the plan text came from. The
    /// `planSaved` flag is written back on THIS id, so the Save/Edit/Refine
    /// row retires for the same message the user acted on.
    let messageId: UUID
    /// Title derived from the reply (`CodeAssistantPanel.planTitle(from:)`),
    /// pre-filled and editable.
    let title: String
    /// The reply body, verbatim — the plan as the agent wrote it.
    let content: String

    var id: UUID { messageId }
}

/// Pure rules behind the plan-edit affordances, kept out of the View so
/// `chat-contract-lab` can assert them (this toolchain has no XCTest; see
/// `Sources/ChatContractLab/main.swift`). Public for the same reason: the lab
/// is a separate target and sees only public symbols.
public enum PlanEditPolicy {

    /// Composer seed for "Refine in chat" — the plan is named, because a
    /// transcript can hold several and a bare "Revise the plan:" would read
    /// as the latest one.
    public static func refineSeed(title: String) -> String {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? "Revise the plan: " : "Revise the plan \"\(trimmed)\": "
    }

    /// Whether the edit sheet's Save may fire. Only the body matters: a blank
    /// title falls back to the derived one (and the resolver slugifies an
    /// empty title to "untitled-plan"), but an empty body would write an
    /// empty plan file.
    public static func canSave(content: String) -> Bool {
        !content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// Title actually written: the user's edit when they left something, else
    /// the title derived from the reply.
    public static func resolvedTitle(edited: String, derived: String) -> String {
        let trimmed = edited.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? derived : trimmed
    }

    /// Why a plan write was refused, or `nil` when it may proceed. The two
    /// guards every plan save shares, as a value: a pending legacy proposal
    /// owns the turn, this plan is already on disk, or the message it belongs
    /// to is no longer in the live transcript (the edit sheet outlived its
    /// session) — in which case the `planSaved` flag has nowhere to land and
    /// a write would be unrecorded, so a second one could follow.
    public enum WriteRefusal: Equatable {
        case pendingTool
        case alreadySaved
        case messageGone
    }

    /// Whether an assistant reply READS as a plan — the content half of
    /// `AgentV2Selection.showsSavePlanAction`'s visibility rule (see the
    /// comment there for why the server-resolved mode alone was not enough).
    ///
    /// Deliberately conservative: a plan is long, sectioned, and enumerates
    /// work. All three must hold, so a short answer that happens to contain
    /// "1." and a heading is not mistaken for one. The caller pairs this with
    /// `sessionIsPlanning`, so a false positive can only ever appear in a
    /// chat that already ran a plan turn.
    public static func looksLikePlan(content: String) -> Bool {
        let trimmed = content.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.utf8.count >= minimumPlanBytes else { return false }
        var hasHeading = false
        var stepCount = 0
        // Fenced blocks are QUOTED text, not document structure: a shell
        // script's `# comment` lines and a diff's `1)` lines would otherwise
        // supply both signals, and an ordinary explanation containing one
        // would sprout a Save Plan button.
        var inFence = false
        for rawLine in trimmed.components(separatedBy: .newlines) {
            let line = rawLine.trimmingCharacters(in: .whitespaces)
            if line.hasPrefix("```") || line.hasPrefix("~~~") {
                inFence.toggle()
                continue
            }
            guard !inFence, !line.isEmpty else { continue }
            if headingBody(of: line) != nil { hasHeading = true }
            // Indented lines are sub-details of the step above, not steps —
            // the same rule `CodeAssistantPanel.stepLines(in:patterns:)`
            // applies, so the two parsers agree about the same document.
            let indent = rawLine.prefix { $0 == " " || $0 == "\t" }.count
            if indent < 2, isStepLine(line) { stepCount += 1 }
            if isPlanShaped(hasHeading: hasHeading, stepCount: stepCount) { return true }
        }
        return isPlanShaped(hasHeading: hasHeading, stepCount: stepCount)
    }

    /// Enumerated work is the signal that matters; sections are the usual
    /// company it keeps, not a requirement. A plan that numbers three or more
    /// steps is a plan whether or not it bothered with a `##` heading.
    /// What the rule has to exclude is a clarifying question: its bullets are
    /// options to choose between, not steps to carry out, and plain `-`
    /// bullets are not counted.
    private static func isPlanShaped(hasHeading: Bool, stepCount: Int) -> Bool {
        guard stepCount >= minimumPlanSteps else { return false }
        return hasHeading || stepCount >= unsectionedPlanSteps
    }

    /// Steps an UNSECTIONED reply needs before it reads as a plan rather than
    /// a two-item list inside an ordinary answer.
    public static let unsectionedPlanSteps = 3

    /// Shortest reply that can be a plan. A plan that fits in a tweet is a
    /// suggestion, not something worth writing to `llm-doc/plans/`.
    ///
    /// Measured in UTF-8 BYTES, not characters. A character count is 2-3x
    /// stricter for Japanese — this app's primary UI language — because the
    /// same plan simply takes fewer characters to write, and a real JA plan
    /// was being rejected on length while its English twin passed. Bytes are
    /// a crude proxy for how much a reply actually says, and they happen to
    /// be the fair one here: a CJK character costs three.
    public static let minimumPlanBytes = 400

    /// How many enumerated work items a plan must list.
    public static let minimumPlanSteps = 2

    /// The text after an ATX heading's marks (`## Phase 1` → `Phase 1`), or
    /// nil when the line is not a heading. The same CommonMark shape check
    /// `CodeAssistantPanel.planTitle(from:)` uses, so "###" and shebangs
    /// don't count as sections.
    private static func headingBody(of line: String) -> String? {
        let hashes = line.prefix(while: { $0 == "#" })
        guard (1...6).contains(hashes.count) else { return nil }
        let rest = line.dropFirst(hashes.count)
        guard rest.first == " " else { return nil }
        let body = rest.trimmingCharacters(in: .whitespaces)
        return body.isEmpty ? nil : body
    }

    /// A line that enumerates a unit of work: `1. …` / `1) …`, a `- [ ] …`
    /// checklist item, or a `## Phase 2 …` / `### Step 3:` section heading.
    /// Full-width markers (`１．` / `１）`) count too — a Japanese reply
    /// numbers its steps with them.
    private static func isStepLine(_ line: String) -> Bool {
        if let body = headingBody(of: line) { return startsWithStepWord(body) }
        if startsWithCheckbox(line) { return true }
        let digits = line.prefix(while: { $0.isNumber })
        guard !digits.isEmpty, digits.count <= 2 else { return false }
        let rest = line.dropFirst(digits.count)
        guard let marker = rest.first, listMarkers.contains(marker) else { return false }
        // A full-width marker is followed by the next word directly; an ASCII
        // one needs its space, or "1.5x faster" would read as a step.
        let after = rest.dropFirst().first
        return marker == "." || marker == ")" ? after == " " : true
    }

    /// Markers that can follow a step's number.
    private static let listMarkers: Set<Character> = [".", ")", "．", "）", "、"]

    /// `- [ ] Add tests` / `* [x] Done` — a checklist item at the top level.
    private static func startsWithCheckbox(_ line: String) -> Bool {
        guard let bullet = line.first, bullet == "-" || bullet == "*" else { return false }
        let rest = line.dropFirst().drop(while: { $0 == " " })
        guard rest.hasPrefix("[") , rest.count > 3 else { return false }
        let marker = rest.prefix(3).lowercased()
        return marker == "[ ]" || marker == "[x]" || marker == "[-]"
    }

    /// "Phase 2 — …" / "Step 3: …" / "フェーズ1 — …", the way a plan names its
    /// sections. The digit matters: a lone "## Steps" heading introduces the
    /// list, it is not itself a step.
    ///
    /// Japanese is not an afterthought here — it is this app's primary UI
    /// language, so a JA plan headed `## フェーズ1` has to score exactly like
    /// its English twin, or the row this whole change restores goes missing
    /// again for the users most likely to see it.
    private static func startsWithStepWord(_ body: String) -> Bool {
        let lowered = body.lowercased()
        for word in stepWords where lowered.hasPrefix(word) {
            let rest = lowered.dropFirst(word.count).drop(while: { $0 == " " || $0 == "　" })
            if rest.first?.isNumber == true { return true }
        }
        // 第1段階 / 第2フェーズ — in Japanese the number can sit inside the word.
        if lowered.hasPrefix("第") {
            return lowered.dropFirst().first?.isNumber == true
        }
        return false
    }

    /// Words a section heading uses to name one unit of work.
    private static let stepWords = [
        "phase", "step", "stage",
        "フェーズ", "ステップ", "ステージ", "段階", "手順",
    ]

    /// The file a plan save should write INTO, or nil to mint a fresh dated
    /// file. `existing` is the path the chat's newest saved-plan card points
    /// at — the chat's plan.
    ///
    /// One chat, one plan file: the design is saved first, the written-out
    /// plan and every later revision go back into that same file. Before this
    /// rule each save minted `<today>-<slug-of-first-heading>.md`, so the
    /// design and its plan — same work, different headings — landed in two
    /// unrelated files, and the Execute action only ever attached one.
    ///
    /// Reused only while the path still lies directly inside THIS project's
    /// plans folder. A card from a chat that was since re-pointed at another
    /// project must not write into the old project, and a path with a
    /// subfolder or a non-markdown suffix is not one this app wrote.
    public static func reusablePlanPath(existing: String?, plansDir: String) -> String? {
        guard let existing, !existing.isEmpty else { return nil }
        let dir = plansDir.hasSuffix("/") ? plansDir : plansDir + "/"
        guard existing.hasPrefix(dir) else { return nil }
        let name = existing.dropFirst(dir.count)
        guard !name.isEmpty, !name.contains("/"), name.hasSuffix(".md") else { return nil }
        return existing
    }

    public static func refusal(hasPendingTool: Bool,
                               alreadySaved: Bool,
                               messageInTranscript: Bool) -> WriteRefusal? {
        if hasPendingTool { return .pendingTool }
        if alreadySaved { return .alreadySaved }
        if !messageInTranscript { return .messageGone }
        return nil
    }
}

/// Read a generated plan — and, if it needs fixing, hand-edit it — before it
/// is written to `llm-doc/plans/`.
///
/// Opens on the RENDERED plan (`MarkdownWebView`, the same renderer the
/// Library and the doc-generation panel use), with a Preview/Markdown toggle
/// for the source. The chat bubble it came from is a transcript entry; this
/// is the document view of the same text, which is what the reader actually
/// wants before committing it to disk.
///
/// The counterpart to "Refine in chat": that one asks the agent for another
/// revision, this one lets the user fix the text themselves. Only the SAVED
/// FILE carries the edits — the assistant message stays exactly as the agent
/// wrote it, so the transcript keeps agreeing with the v2 engine's
/// server-side history.
///
/// The sheet never writes to disk; the panel does that in `onSave`, which
/// keeps the write next to the `planSaved` bookkeeping it must stay atomic
/// with.
struct PlanEditSheet: View {
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var theme: ThemeStore

    let target: PlanEditTarget
    /// Wraps `CodeAssistantPanel.savePlanEdits(_:title:content:)`.
    let onSave: (String, String) async -> SavePlanResult

    @State private var title: String
    @State private var content: String
    @State private var submitting = false
    @State private var errorMessage: String?
    /// Rendered preview vs markdown source. Always opens on the preview: the
    /// plan is something to READ before deciding, and the raw markdown — the
    /// tables, the fenced blocks, the `**bold**` marks — is what made this
    /// sheet unreadable enough to be reported as "it shows code as it is".
    @State private var isPreview = true

    init(target: PlanEditTarget, onSave: @escaping (String, String) async -> SavePlanResult) {
        self.target = target
        self.onSave = onSave
        _title = State(initialValue: target.title)
        _content = State(initialValue: target.content)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            header
            Divider()

            VStack(alignment: .leading, spacing: 6) {
                Text("Title")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(.secondary)
                TextField("Plan title", text: $title)
                    .textFieldStyle(.roundedBorder)
                    .font(.system(size: 12))
            }

            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Text(isPreview ? "Plan" : "Plan (Markdown, editable)")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(.secondary)
                    Spacer()
                    Picker("", selection: $isPreview) {
                        Text("Preview").tag(true)
                        Text("Markdown").tag(false)
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                    .frame(width: 170)
                    .help("Preview renders the plan; Markdown shows the exact text that gets saved.")
                }
                Group {
                    if isPreview {
                        // Mermaid ON: a plan is exactly where a sequence or
                        // dependency diagram shows up, and the fence-gating in
                        // MarkdownRenderer keeps the bundle out of plans that
                        // have none. `id(content.count)` is not needed — the
                        // view reloads on an input change (see MarkdownWebView).
                        MarkdownWebView(markdown: content,
                                        isDark: theme.current.isDark,
                                        enableMermaid: true)
                            .frame(minHeight: 320)
                            .overlay(RoundedRectangle(cornerRadius: 4)
                                        .stroke(Color.secondary.opacity(0.3)))
                    } else {
                        TextEditor(text: $content)
                            .font(.system(size: 12, design: .monospaced))
                            .frame(minHeight: 320)
                            .overlay(RoundedRectangle(cornerRadius: 4)
                                        .stroke(Color.secondary.opacity(0.3)))
                    }
                }
            }

            if let errorMessage {
                Text(errorMessage)
                    .font(.system(size: 12))
                    .foregroundStyle(theme.current.danger)
                    .fixedSize(horizontal: false, vertical: true)
            }

            HStack {
                Text("Saves to llm-doc/plans/ in the open project")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                Spacer()
                Button("Cancel") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                    .disabled(submitting)
                // The Task is formed HERE, inside the @MainActor body, so the
                // @State writes in submit() stay on the main actor (the
                // pattern UpdateIssueSheet uses).
                Button("Save Plan") { Task { await submit() } }
                    .keyboardShortcut(.defaultAction)
                    .buttonStyle(.borderedProminent)
                    .disabled(submitting || !PlanEditPolicy.canSave(content: content))
            }
        }
        .padding(20)
        .frame(minWidth: 680, minHeight: 560)
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(isPreview ? "Plan preview" : "Edit plan").font(.title3.bold())
            Text("Your edits are written to the plan file; the chat reply is left as the agent wrote it.")
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    @MainActor
    private func submit() async {
        // Two fast Returns can both reach here before `submitting` re-renders
        // the disabled state, so the flag is also read as a guard.
        guard !submitting, PlanEditPolicy.canSave(content: content) else { return }
        submitting = true
        defer { submitting = false }
        errorMessage = nil
        let finalTitle = PlanEditPolicy.resolvedTitle(edited: title, derived: target.title)
        switch await onSave(finalTitle, content) {
        case .success:
            dismiss()
        case .failure(let message):
            errorMessage = message
        }
    }
}
