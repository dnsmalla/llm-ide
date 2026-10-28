import SwiftUI

/// A named insertion point in the Settings page where features contribute
/// cards. Settings renders each slot at a fixed position; WHICH cards land in
/// a slot is decided by Shell at boot (`FeatureCatalog.registerSettingsSections`).
///
/// Lives in Core because Settings (the renderer) and every contributing
/// feature are peers that may not name each other — the slot enum and the
/// registry are the only vocabulary they share. Add a case when a new card
/// position is needed; never encode a feature's identity in a case's
/// behaviour.
enum SettingsSectionSlot: String, CaseIterable, Sendable {
    /// App group, after Backend: the Library's inputs hub (Connections).
    case connections
    /// Inside the Connections → Meetings card: the capture-platform matrix
    /// (contributed by Live; rendered by Library's Connections card).
    case meetingCapture
    /// App group, after Updates: Mobile Control pairing / server card.
    case mobileControl
    /// App group (nested block), after Tier routing: Loop new-project defaults.
    case loopDefaults
    /// Project group, after Paths: Source Control's repo connection cards.
    case sourceControl
    /// Project group, after Memory: the Code Graph auto-update card.
    case graph
    /// App group, after Loop defaults: Doc Gen's server-files switch (beta).
    case docGen
    /// App group, after Doc Gen: agent history storage, retention, clear and compact.
    case agentHistory
}

/// Scroll anchors a deep link can post with `.scrollSettingsToCard`.
///
/// Each is the `id` a card is registered under (the anchor IS the card's id,
/// see `RegisteredSettingsSection.id`), so the registering side (Shell), the
/// posting side and the card that reacts to it must all spell it the same.
/// One constant here instead of a string literal in each of those places,
/// so a rename cannot silently break the deep link.
enum SettingsAnchor {
    /// Library's Connections card (inputs hub) — the target of Library's
    /// "Connect a source…" / "Open in Settings" deep links.
    static let connections = "connections"
}

/// One registered Settings card. `make` is evaluated on every render of the
/// hosting view, so it must be cheap and side-effect free (construct a view,
/// nothing more).
struct RegisteredSettingsSection: Identifiable {
    /// Stable identity. Used as the SwiftUI identity AND as the
    /// `ScrollViewReader` anchor — `.scrollSettingsToCard` posts this string
    /// (e.g. `SettingsAnchor.connections`), so ids must be unique across ALL
    /// slots.
    let id: String
    let slot: SettingsSectionSlot
    /// Primary sort key within a slot (ascending).
    let order: Int
    /// Tie-breaker: when this (slot, id) was FIRST registered. Preserved
    /// across re-registration so replacing a card never moves it.
    let sequence: Int
    let make: @MainActor () -> AnyView
}

/// Registry through which features contribute cards to the Settings page
/// without Settings naming them (and without them naming Settings).
///
/// Contract:
/// - `register(slot:id:order:make:)`
///   - Pre: called on the main actor; `id` is non-empty and unique across
///     slots (it doubles as the scroll anchor).
///   - Post: exactly one entry exists for `(slot, id)`. Re-registering an
///     existing `(slot, id)` REPLACES its `order` and `make` but keeps its
///     original registration sequence — so a boot path that runs twice (or a
///     refresh after login) can never duplicate a card or reshuffle it.
///   - Publishes a change so an on-screen Settings page picks it up.
/// - `unregister(slot:id:)`
///   - Post: no entry exists for `(slot, id)`; a no-op when none did.
/// - `sections(for:)`
///   - Post: the slot's entries sorted by `order`, then by first-registration
///     sequence (stable). An empty slot — e.g. its feature is compiled out
///     and Shell never registered it — returns `[]`, and Settings renders
///     nothing there.
@MainActor
final class SettingsSectionRegistry: ObservableObject {
    static let shared = SettingsSectionRegistry()

    @Published private(set) var entries: [SettingsSectionSlot: [RegisteredSettingsSection]] = [:]
    private var nextSequence = 0

    /// Internal (not private) so tests can use an isolated instance instead
    /// of mutating `shared`, which the running app also reads.
    init() {}

    func register(slot: SettingsSectionSlot,
                  id: String,
                  order: Int = 0,
                  make: @escaping @MainActor () -> AnyView) {
        var list = entries[slot] ?? []
        if let index = list.firstIndex(where: { $0.id == id }) {
            list[index] = RegisteredSettingsSection(
                id: id, slot: slot, order: order,
                sequence: list[index].sequence, make: make)
        } else {
            list.append(RegisteredSettingsSection(
                id: id, slot: slot, order: order,
                sequence: nextSequence, make: make))
            nextSequence += 1
        }
        entries[slot] = list
    }

    func unregister(slot: SettingsSectionSlot, id: String) {
        guard var list = entries[slot] else { return }
        list.removeAll { $0.id == id }
        entries[slot] = list
    }

    func sections(for slot: SettingsSectionSlot) -> [RegisteredSettingsSection] {
        (entries[slot] ?? []).sorted {
            ($0.order, $0.sequence) < ($1.order, $1.sequence)
        }
    }
}

/// Renders every card registered in one slot, in registry order, each tagged
/// with `.id(section.id)` so `ScrollViewReader.scrollTo` can target it.
/// A `ForEach` counts as ONE `ViewBuilder` child, which matters in Settings'
/// 10-children-per-block groups.
struct SettingsSlotView: View {
    let slot: SettingsSectionSlot
    @ObservedObject var registry: SettingsSectionRegistry = .shared

    var body: some View {
        ForEach(registry.sections(for: slot)) { section in
            section.make().id(section.id)
        }
    }
}
