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
        public let isPlanWriteRequest: Bool

        public init(id: UUID, kind: Kind, isPlanWriteRequest: Bool = false) {
            self.id = id
            self.kind = kind
            self.isPlanWriteRequest = isPlanWriteRequest
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
