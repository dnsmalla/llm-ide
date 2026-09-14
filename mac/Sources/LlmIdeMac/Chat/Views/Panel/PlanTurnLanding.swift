import Foundation

/// What a finished turn does to the chat's saved plan, decided from the last
/// two messages in ONE place. `CodeAssistantPanel+Session` used to hold this
/// as three same-shaped `if` blocks; every new plan-side landing meant a fourth
/// block in a file about sessions. Now a landing is a case here and one
/// `switch` arm there.
///
/// Public because `chat-contract-lab` asserts it.
public enum PlanTurnLanding {

    public enum Action: Equatable, Sendable {
        /// The reply to an update turn IS the rewritten document: save it.
        case savePlanReply
        /// Review asked for changes and this turn edited code: rewrite the plan.
        case updatePlanAfterFix
        /// The Review button's turn finished: its reply is the verdict.
        case landReview
    }

    /// The facts a landing is decided from — all read off the transcript's
    /// last user and assistant messages and the tracker.
    public struct Turn: Equatable, Sendable {
        public let pendingToolParked: Bool
        public let lastUserIsPlanUpdate: Bool
        public let lastUserIsPlanReview: Bool
        public let replyDone: Bool
        public let replyAlreadySaved: Bool
        public let replyLooksLikePlan: Bool
        public let turnChangedCode: Bool
        public let reviewVerdict: PlanReviewVerdict?
        public let hasPlanFile: Bool

        public init(pendingToolParked: Bool, lastUserIsPlanUpdate: Bool, lastUserIsPlanReview: Bool,
                    replyDone: Bool, replyAlreadySaved: Bool, replyLooksLikePlan: Bool,
                    turnChangedCode: Bool, reviewVerdict: PlanReviewVerdict?, hasPlanFile: Bool) {
            self.pendingToolParked = pendingToolParked
            self.lastUserIsPlanUpdate = lastUserIsPlanUpdate
            self.lastUserIsPlanReview = lastUserIsPlanReview
            self.replyDone = replyDone
            self.replyAlreadySaved = replyAlreadySaved
            self.replyLooksLikePlan = replyLooksLikePlan
            self.turnChangedCode = turnChangedCode
            self.reviewVerdict = reviewVerdict
            self.hasPlanFile = hasPlanFile
        }
    }

    /// Actions in the order the panel must perform them. A parked proposal
    /// defers everything: the answer's own turn will land.
    public static func actions(for turn: Turn) -> [Action] {
        guard !turn.pendingToolParked else { return [] }
        var out: [Action] = []
        if turn.lastUserIsPlanUpdate, turn.replyDone, !turn.replyAlreadySaved, turn.replyLooksLikePlan {
            out.append(.savePlanReply)
        }
        if turn.replyDone,
           PlanReviewPolicy.updatesPlanAfterFix(
               verdict: turn.reviewVerdict,
               turnChangedCode: turn.turnChangedCode,
               isPlanUpdateTurn: turn.lastUserIsPlanUpdate,
               hasPlanFile: turn.hasPlanFile) {
            out.append(.updatePlanAfterFix)
        }
        if turn.lastUserIsPlanReview {
            out.append(.landReview)
        }
        return out
    }
}
