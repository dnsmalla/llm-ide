import Foundation

/// Does this draft ASK FOR A PLAN, while the picker is pinned to a mode that
/// will not produce one?
///
/// The picker follows the resolved mode and stays there, and
/// `releaseStickyMode` deliberately never takes back a mode the user chose by
/// hand — "this exists to undo stickiness, never to overrule a choice". That
/// rule is right, and it has a cost: sitting in Execute, "i want a plan to
/// remove the dead code" runs as an Execute turn, and the chat answers a
/// request to PLAN by starting to DO. Nothing tells the user why.
///
/// So the rule stands and the condition is made visible instead: when a draft
/// reads as a planning request in a non-planning mode, the composer offers a
/// one-tap switch. The user still decides; they just no longer have to
/// diagnose it.
///
/// Deliberately conservative — the chip costs attention every time it is
/// wrong, so it fires only on an explicit ask for a plan ("write me a plan
/// for X"), never on the mere presence of the word ("execute the plan",
/// "I plan to refactor this").
///
/// Public because `chat-contract-lab` asserts it — this toolchain has no
/// XCTest, so the lab is a separate target that sees only public symbols.
public enum PlanRequestPolicy {

    /// Phrases that ask for a plan to be produced. Matched on a lowercased,
    /// whitespace-collapsed draft.
    private static let asks: [String] = [
        "want a plan", "need a plan", "give me a plan",
        "make a plan", "make me a plan", "create a plan", "write a plan",
        "write me a plan", "draft a plan", "prepare a plan", "build a plan",
        "come up with a plan", "put together a plan", "propose a plan",
        "plan this out", "let's plan", "lets plan",
        // Japanese: the object marker is optional in casual typing, so both
        // "プランを作って" and "プラン作って" are covered by the stem pairs.
        "プランを作", "プラン作", "計画を作", "計画作",
        "計画を立て", "計画立て", "プランを立て", "プラン立て",
        "プランが欲し", "プランがほし", "計画が欲し", "計画がほし",
        "プランを書", "計画を書", "プランをお願い", "計画をお願い",
    ]

    /// Whether `draft` asks for a plan to be written.
    public static func looksLikePlanRequest(_ draft: String) -> Bool {
        let text = draft
            .lowercased()
            .components(separatedBy: .whitespacesAndNewlines)
            .filter { !$0.isEmpty }
            .joined(separator: " ")
        guard !text.isEmpty else { return false }
        // An explicit ask is required, which is also what keeps "execute the
        // plan" / "I plan to refactor this" out: neither contains one, so no
        // separate suppression list is needed.
        return asks.contains(where: { text.contains($0) })
    }

    /// Whether the composer should offer the switch.
    ///
    /// Not in Auto: Auto re-classifies every turn on its own merits, so it
    /// would reach Plan by itself and the chip would be noise. Not in a
    /// plan-like mode: already there. That leaves exactly the modes that will
    /// answer a planning request as something else.
    public static func offersPlanSwitch(draft: String, currentMode: String) -> Bool {
        guard currentMode != AgentV2Selection.autoMode else { return false }
        guard !AgentV2Selection.planLikeModes.contains(currentMode) else { return false }
        return looksLikePlanRequest(draft)
    }
}
