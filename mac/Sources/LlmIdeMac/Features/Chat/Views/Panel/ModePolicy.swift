import Foundation

/// Mode-picker rules the chat lifecycle applies, kept out of the views and
/// the engine so both can change without touching the other.
///
/// Keyed on the mode's raw string (the wire value, and what message metadata
/// stores) so the rules stay assertable from `chat-contract-lab` without
/// making the SwiftUI-facing `CodeAssistMode` public.
public enum ModePolicy {

    /// The one mode that re-decides per turn; the target of every release.
    public static let autoMode = "auto"

    /// Wire values `CodeAssistMode` knows. Mirrors its `rawValue`s; an
    /// unknown server value must never move the picker.
    /// DERIVED from `CodeAssistMode`, not hand-listed, so the two cannot
    /// drift — and drift here is silent: a mode the picker can hold but this
    /// set omits simply never follows the server, with no error anywhere.
    /// (Adding `ask` to the enum hit exactly that, which is why it is
    /// computed now.) Public for `chat-contract-lab`; `CodeAssistMode` stays
    /// internal, which is the whole reason this type keys on raw strings.
    public static let knownModes: Set<String> = Set(CodeAssistMode.allCases.map(\.rawValue))

    /// Where the picker should move when the server resolves `resolved`
    /// for a turn, or nil to leave it. Only Auto ever follows: moving OFF
    /// Auto is the point (the user asked the picker to show what the agent
    /// is doing), and a mode picked by hand is not the server's to change.
    public static func pickerMode(current: String, resolved: String) -> String? {
        guard current == autoMode, resolved != autoMode, knownModes.contains(resolved) else { return nil }
        return resolved
    }

    /// Where the picker goes when the CONVERSATION changes underneath it —
    /// cleared, replaced by a new chat, or switched to another session:
    /// always Auto, whatever it held.
    ///
    /// This is the one rule here that overrules a hand-picked mode, and
    /// deliberately so. `releasesStickyMode` refuses to, because within a
    /// conversation a choice the user made is theirs. But a mode is chosen
    /// FOR a conversation: Execute picked for chat A says nothing about what
    /// chat B needs, and carrying it across was the same "set once and
    /// forgotten" failure stickiness had — a freshly cleared chat that asked
    /// for a plan got an Execute turn because the picker still remembered
    /// the previous one. A new or cleared conversation has no choice yet, so
    /// Auto — the only setting that re-decides — is the only honest start.
    ///
    /// `current` is accepted and ignored on purpose: the answer does not
    /// depend on where the picker was, and taking it lets `chat-contract-lab`
    /// assert exactly that from every origin (flow-set, hand-picked, Auto).
    public static func pickerModeAfterSessionChange(from current: String) -> String {
        autoMode
    }

    /// What the picker holds, and who put it there. The provenance is what
    /// every release rule below keys on: a hand-picked mode and a mode the
    /// flow set (following the server off Auto, or a card action such as
    /// Execute / Review / Edit in chat) look identical as a bare string, and
    /// deciding releases by the string alone released hand-picks too — a
    /// user who chose Execute had it taken away when a run finished.
    public struct Selection: Equatable, Sendable {
        public var mode: String
        public var setByFlow: Bool
        public init(mode: String, setByFlow: Bool) {
            self.mode = mode
            // Auto has no provenance: it is the absence of a choice.
            self.setByFlow = mode == ModePolicy.autoMode ? false : setByFlow
        }
        public static let auto = Selection(mode: ModePolicy.autoMode, setByFlow: false)
    }

    /// Where the picker goes when the displayed conversation changes to
    /// `remembered`'s chat: back to what THAT chat held when it was last on
    /// screen, else Auto. A mode is chosen for a conversation, so it travels
    /// with the conversation — switching A → B → A in the middle of a plan
    /// pipeline used to drop A back to Auto, and A's next answer ("option 2")
    /// was then classified from scratch, possibly as an Execute.
    public static func pickerSelectionAfterSessionChange(remembered: Selection?) -> Selection {
        remembered ?? .auto
    }

    /// The selection as it will be once a resolution the picker has not
    /// followed YET lands. The legacy engine reports its mode on the
    /// terminal event, and the panel follows it on the next view update —
    /// after the engine has already gone idle. A release decided from the
    /// picker alone would see Auto, do nothing, and let the follow then park
    /// the picker on a mode nothing will release.
    public static func selection(_ picker: Selection, afterPendingResolution resolved: String?) -> Selection {
        guard let resolved, let next = pickerMode(current: picker.mode, resolved: resolved) else { return picker }
        return Selection(mode: next, setByFlow: true)
    }

    /// Whether the mode the FLOW set should be handed back to Auto now that
    /// the work that needed it has settled (the engine went idle with no
    /// auto-continue round, card or approval pending).
    ///
    /// Plan / Assist Plan are multi-turn conversations — questions, answers,
    /// a plan — so they stay until the plan is saved (`planStages`). Every
    /// other flow-set mode (Execute, Review, Document) is one piece of work:
    /// before this rule nothing ever released a classified Execute or
    /// Document outside a plan run, so after one edit every later message in
    /// the chat ran in Execute and was never classified again. A live plan
    /// run keeps its Execute until the run settles.
    public static func releasesAtWorkEnd(_ selection: Selection, planRunActive: Bool) -> Bool {
        selection.setByFlow
            && selection.mode != autoMode
            && !planStages.contains(selection.mode)
            && !planRunActive
    }

    // Release sets, named once. Each caller says WHICH lifecycle moment it
    // is instead of spelling the modes — adding a stage is one edit here.

    /// Saving a plan ends the planning stages.
    public static let planStages: Set<String> = ["plan", "assist_plan"]
    /// A finished run set one of these.
    public static let runStages: Set<String> = ["execute", "plan", "assist_plan"]
    /// Dismissing a finished plan card: the run's modes plus the Code Review
    /// its finish card's Review button puts the picker into.
    public static let runAndReviewStages: Set<String> = runStages.union(reviewStage)
    /// A review turn (normal end, stop, cancel or failure) set only this.
    public static let reviewStage: Set<String> = ["review"]

    /// Whether a sticky mode should be handed back to Auto now that the work
    /// that set it is finished.
    ///
    /// The picker follows the mode the server resolved and then STAYS there,
    /// which is what keeps a mode specific to the work being done. The cost
    /// is that it never leaves on its own: a chat that planned something
    /// answered every later message as a planner — "thanks", "what does this
    /// do?" — until the user reached up and changed it, which in practice
    /// nobody does. The mode is set once at the start and forgotten.
    ///
    /// Auto rather than a fixed mode, because Auto is the only setting that
    /// RE-DECIDES: the next message is classified on its own merits, so a
    /// follow-up that is itself a planning request lands back in Plan by the
    /// same route it did the first time.
    ///
    /// Keyed on the mode's raw string, like `planLikeModes` — that is the
    /// mode's identity on the wire and in message metadata, and it keeps this
    /// rule assertable without making the SwiftUI-facing `CodeAssistMode`
    /// (and the chip protocol it conforms to) public.
    ///
    /// Releases only a mode the FLOW set. A user who deliberately picked
    /// something outside `releasing` keeps it: this undoes stickiness, it
    /// never overrules a choice.
    public static func releasesStickyMode(current: String, releasing: Set<String>) -> Bool {
        current != autoMode && releasing.contains(current)
    }

    /// `releasesStickyMode`, restricted to a mode the flow set — the rule
    /// the doc above always promised ("never overrules a choice") but could
    /// not enforce without provenance.
    public static func releasesStickyMode(_ selection: Selection, releasing: Set<String>) -> Bool {
        selection.setByFlow && releasesStickyMode(current: selection.mode, releasing: releasing)
    }
}
