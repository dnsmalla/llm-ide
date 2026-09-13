import Foundation

/// Which turns in a plan transcript are DOCUMENTS rather than conversation,
/// and which saved-plan card holds a written plan rather than a design.
///
/// Both answers are derived from turn ORDER, not from message content: the
/// "Write full plan" button stamps `planWriteDisplay` on the user turn it
/// sends, so the assistant reply that follows it is — by construction — the
/// plan document, and the `save-plan` result appended after that reply is the
/// card holding it. Content sniffing (`looksLikePlan`) can't tell a written
/// plan from the design it was written from; the order can.
///
/// Why it matters: rendering a whole plan document as an assistant bubble
/// stands up a WKWebView and re-lays it out on every streamed chunk, which is
/// what made a plan-write turn scroll-janky and left the same text on screen
/// twice (bubble + card). The document belongs in the card; the bubble
/// collapses to a one-line row.
///
/// Public because `chat-contract-lab` asserts it — this toolchain has no
/// XCTest, so the lab is a separate target that sees only public symbols.
public enum PlanTranscriptPolicy {

    /// The shape of a transcript turn this policy needs. Deliberately not
    /// `ChatMessage`: the rule is about role + order + one flag, and keeping
    /// the input minimal is what lets the lab construct cases by hand.
    public struct Turn: Equatable, Sendable {
        public enum Kind: String, Equatable, Sendable {
            case user
            case assistant
            /// A successful `save-plan` tool result (the PlanSavedCard).
            case planResult
            /// Anything else (other tool results, failures).
            case other
        }

        public let id: UUID
        public let kind: Kind
        /// `user` turns only: this message was sent by "Write full plan".
        /// Nothing stamps this any more — the plan is written in the same
        /// turn as the design — but sessions saved under the two-stage flow
        /// still carry it, and they must keep rendering the way they did.
        public let isPlanWriteRequest: Bool
        /// `assistant` turns only: this reply's text has been saved as the
        /// chat's plan, so the card below it now holds the same document.
        public let isSavedPlanSource: Bool

        public init(id: UUID, kind: Kind, isPlanWriteRequest: Bool = false,
                    isSavedPlanSource: Bool = false) {
            self.id = id
            self.kind = kind
            self.isPlanWriteRequest = isPlanWriteRequest
            self.isSavedPlanSource = isSavedPlanSource
        }
    }

    public struct Marks: Equatable, Sendable {
        /// Assistant replies that ARE the plan document — render collapsed.
        public let documentReplies: Set<UUID>
        /// Saved-plan cards holding a WRITTEN plan (not a design) — their
        /// next step is Execute, so they drop the "Write full plan" button.
        public let writtenPlanCards: Set<UUID>

        public init(documentReplies: Set<UUID>, writtenPlanCards: Set<UUID>) {
            self.documentReplies = documentReplies
            self.writtenPlanCards = writtenPlanCards
        }
    }

    /// One forward pass. A plan-write user turn arms the marker; the next
    /// assistant turn is the document and the `save-plan` result after it is
    /// the written-plan card. Anything the user types in between disarms —
    /// a reply to a question the agent asked mid-write is conversation, and
    /// hiding it would hide the question.
    public static func mark(_ turns: [Turn]) -> Marks {
        var documents: Set<UUID> = []
        var writtenCards: Set<UUID> = []
        // nil = not in a write; .awaitingReply = the document hasn't landed
        // yet; .awaitingSave = it has, and the next plan result carries it.
        enum State { case awaitingReply, awaitingSave }
        var state: State?

        for turn in turns {
            switch turn.kind {
            case .user:
                state = turn.isPlanWriteRequest ? .awaitingReply : nil
            case .assistant:
                // A reply whose text has been SAVED is a document, whatever
                // order it arrived in: the PlanSavedCard below it renders the
                // same markdown with the buttons that act on it, so leaving
                // the bubble expanded puts the whole plan on screen twice.
                // This is the rule that carries the one-turn flow, where no
                // write request precedes the document.
                if turn.isSavedPlanSource { documents.insert(turn.id) }
                if state == .awaitingReply {
                    documents.insert(turn.id)
                    state = .awaitingSave
                }
                // An assistant turn arriving while `.awaitingSave` is the
                // agent talking after the document (an auto-chain follow-up
                // ack). It is not a second document, and it must not clear
                // the state — the save result still follows it.
            case .planResult:
                if state == .awaitingSave {
                    writtenCards.insert(turn.id)
                    state = nil
                }
            case .other:
                break
            }
        }
        return Marks(documentReplies: documents, writtenPlanCards: writtenCards)
    }
}

/// What a post-execution code review concluded. Parsed from the review
/// reply's own verdict line rather than guessed from its prose, because the
/// Push button's availability hangs off it and "looks positive" is not a
/// merge criterion.
public enum PlanReviewVerdict: String, Equatable, Sendable {
    /// Reviewed, nothing blocking — safe to merge.
    case pass
    /// Reviewed, the reviewer wants changes before this merges.
    case changesRequested
    /// The review came back without a verdict line we can read. NOT treated
    /// as a pass: the card says so and lets the reader decide.
    case unclear
}

/// Reading a review reply's verdict, and the wording the card shows for it.
///
/// Public for `chat-contract-lab` (see `PlanTranscriptPolicy`).
public enum PlanReviewPolicy {

    /// The line the review prompt asks for. A machine-readable marker on its
    /// own line, so the verdict doesn't have to be inferred from a summary
    /// that may itself be discussing someone else's findings.
    public static let verdictMarker = "REVIEW-VERDICT:"

    /// The canned instruction the "Review" button sends. A constant so the
    /// prompt and the parser below can't drift apart — the parser looks for
    /// exactly the marker this asks for.
    public static func reviewMessage(planTitle: String, baseBranch: String?) -> String {
        let against = baseBranch.map { " against `\($0)`" } ?? ""
        return """
        The plan "\(planTitle)" has been executed. Review the attached diff\(against) \
        the way the code-review skill describes: look for correctness bugs, security \
        problems, and violations of this project's conventions and invariants — not \
        style nits. Judge whether the change actually does what the plan said.

        Do not modify any files; this is a review, not a fix.

        Report findings most serious first, each with the file and line and what \
        would actually go wrong. Then end your reply with exactly one final line:

        \(verdictMarker) PASS        — if nothing found would block merging to main
        \(verdictMarker) CHANGES     — if anything found should be fixed first
        """
    }

    /// Read the verdict off a review reply.
    ///
    /// Scans from the END: the marker is asked for as the last line, and a
    /// reply that quotes the instruction back (agents do) would otherwise be
    /// read off its own echo of the prompt rather than off its conclusion.
    /// Only the FIRST WORD after the marker is read, so a verdict that
    /// explains itself ("PASS — no changes required") isn't downgraded by a
    /// word in its own justification.
    ///
    /// The prompt offers the two verdicts as a MENU of adjacent lines, and a
    /// reply that quotes that menu back carries both — with CHANGES last,
    /// which read as a requested change over a review that passed. So
    /// adjacent marker lines that disagree are treated as the menu and
    /// skipped, and the scan continues past them to the reply's own verdict.
    public static func verdict(from reply: String) -> PlanReviewVerdict {
        let marked = reply
            .split(separator: "\n", omittingEmptySubsequences: false)
            .enumerated()
            .compactMap { index, raw -> (line: Int, verdict: PlanReviewVerdict)? in
                guard let v = markerVerdict(on: String(raw)) else { return nil }
                return (index, v)
            }
        // Drop menu pairs: neighbouring marker lines (allowing one blank
        // between) that name different verdicts state options, not findings.
        //
        // Consumed strictly two at a time. Testing every adjacent pair
        // independently would chain — in "PASS / CHANGES / <the real> PASS"
        // the menu's second line also pairs with the verdict below it, and
        // the reply's own conclusion got swallowed as part of the menu.
        var isMenu = Array(repeating: false, count: marked.count)
        var i = 0
        while i + 1 < marked.count {
            let a = marked[i], b = marked[i + 1]
            if b.line - a.line <= 2, a.verdict != b.verdict {
                isMenu[i] = true
                isMenu[i + 1] = true
                i += 2
            } else {
                i += 1
            }
        }
        for i in marked.indices.reversed() where !isMenu[i] {
            return marked[i].verdict
        }
        return .unclear
    }

    /// The verdict a single line states, or nil if it carries no marker.
    /// A line naming the marker twice is a one-line menu and states nothing.
    private static func markerVerdict(on line: String) -> PlanReviewVerdict? {
        // Strip markdown emphasis/bullets the model may wrap it in
        // (`**REVIEW-VERDICT: PASS**`, `- REVIEW-VERDICT: PASS`).
        let bare = line
            .trimmingCharacters(in: .whitespaces)
            .replacingOccurrences(of: "*", with: "")
            .replacingOccurrences(of: "`", with: "")
            .trimmingCharacters(in: CharacterSet(charactersIn: "-• \t"))
        guard let range = bare.range(of: verdictMarker) else { return nil }
        if bare[range.upperBound...].contains(verdictMarker) { return .unclear }
        let word = bare[range.upperBound...]
            .split(whereSeparator: { $0 == " " || $0 == "\t" })
            .first
            .map { String($0).uppercased() } ?? ""
        if word.hasPrefix("PASS") { return .pass }
        if word.hasPrefix("CHANGE") || word.hasPrefix("FAIL") { return .changesRequested }
        // A marker with an unreadable verdict after it claims nothing — but
        // it IS a conclusion line, so it still ends the scan.
        return .unclear
    }

    /// The canned instruction the automatic plan update sends.
    ///
    /// A rewrite, not an append: the plan's job is to describe the work, and
    /// once review has changed the work the document describes something that
    /// is no longer true. The turn must not touch code — the fixing already
    /// happened; this one only brings the document level with it.
    public static func planUpdateMessage(planTitle: String) -> String {
        """
        The review of "\(planTitle)" found problems and the code has since been changed to \
        answer them, so the attached plan no longer describes the work that exists.

        Rewrite it to match the FINAL state: keep the title, fold the fixes into the tasks \
        they belong to, and drop or correct anything the fixes made untrue. Someone reading \
        it should see what was built, not what was first intended.

        Deliver the complete document as your reply — it is saved back into the same file. \
        Do not modify any files in this turn, and do not start new work.
        """
    }

    /// File-writing tools, across both engines and both naming schemes: the
    /// SDK's native `Edit`/`Write`/`MultiEdit`/`NotebookEdit` and llm-ide's
    /// own `update-file`. Compared lowercased and with the `mcp__llmide__`
    /// prefix stripped, which is how a step's tool name arrives on the wire.
    public static let codeChangingTools: Set<String> = [
        "edit", "write", "multiedit", "notebookedit", "update-file",
    ]

    /// Whether `toolName` (as recorded on a `ToolStep`) wrote to a file.
    public static func isCodeChangingTool(_ toolName: String) -> Bool {
        var name = toolName.lowercased()
        if let range = name.range(of: "mcp__", options: .backwards) {
            // `mcp__llmide__update-file` → `update-file`; the server namespaces
            // every llmide tool this way and the step records the wire name.
            name = String(name[range.upperBound...])
            if let sep = name.range(of: "__") { name = String(name[sep.upperBound...]) }
        }
        return codeChangingTools.contains(name)
    }

    /// Whether a finished turn should trigger an automatic rewrite of the
    /// chat's plan file.
    ///
    /// The trigger is the WORK changing under a plan that has already been
    /// executed and reviewed: once review asks for changes, every turn that
    /// edits a file leaves the saved plan describing something that is no
    /// longer what the code does. There is no Fix button to key on — a fix is
    /// whatever the user typed — so the signal is the edit itself.
    ///
    /// Deliberately narrow, because this is the ONE path that writes a plan to
    /// disk without the user asking:
    /// - only after a review that asked for changes (`.pass` and `.unclear`
    ///   are not open findings, and a plan nobody reviewed is not this flow),
    /// - only when the turn actually wrote a file,
    /// - never for the update turn itself, or the rewrite would edit nothing,
    ///   be saved, and qualify again,
    /// - and only when the chat already HAS a plan file: this updates a
    ///   document the user saved, it never creates one.
    public static func updatesPlanAfterFix(verdict: PlanReviewVerdict?,
                                           turnChangedCode: Bool,
                                           isPlanUpdateTurn: Bool,
                                           hasPlanFile: Bool) -> Bool {
        guard verdict == .changesRequested else { return false }
        return turnChangedCode && !isPlanUpdateTurn && hasPlanFile
    }

    /// Headline + explanation for the verdict strip on the finish card.
    public struct Display: Equatable, Sendable {
        public let title: String
        public let detail: String
        public init(title: String, detail: String) {
            self.title = title
            self.detail = detail
        }
    }

    public static func display(for verdict: PlanReviewVerdict) -> Display {
        switch verdict {
        case .pass:
            return Display(
                title: "Review passed",
                detail: "The review found nothing that should block merging to main.")
        case .changesRequested:
            return Display(
                title: "Changes requested",
                detail: "The review found something to fix first — read it above before pushing.")
        case .unclear:
            return Display(
                title: "Review finished without a verdict",
                detail: "The reply didn't end with a verdict line, so nothing is claimed about it. "
                    + "Read the review above and decide.")
        }
    }

    /// Whether Push may be offered at all. Gated on a review having RUN —
    /// the user's rule for this card — not on it having passed: a review
    /// that asks for changes is information, and overriding it is the
    /// user's call, made at the confirm dialog.
    public static func allowsPush(reviewed: Bool) -> Bool { reviewed }

    /// Whether the confirm dialog should warn rather than just confirm.
    public static func warnsBeforePush(_ verdict: PlanReviewVerdict?) -> Bool {
        switch verdict {
        case .pass: return false
        case .changesRequested, .unclear, nil: return true
        }
    }
}
