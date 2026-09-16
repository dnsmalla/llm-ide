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
}
