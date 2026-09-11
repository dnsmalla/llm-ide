import Foundation

/// The narrow public surface `chat-contract-lab` needs to pin
/// `GenerationRegistry`'s one guarantee: a generation outlives the view that
/// started it.
///
/// Same reasoning as `ChatMessageConformance` — the registry and its view model
/// stay internal, and this toolchain has no XCTest, so a separate executable
/// target is the only place these can actually be asserted.
public enum GenerationConformance {
    private static func scope(_ raw: String) -> GenerationRegistry.Scope? {
        GenerationRegistry.Scope(rawValue: raw)
    }

    /// Resolving the same scope twice returns the identical object.
    ///
    /// **This is the registry's precondition, NOT the bug.** The bug was that
    /// `DocGenView`/`VisualView` CONSTRUCTED a model instead of resolving one;
    /// reverting them to `@StateObject private var vm = GenerationViewModel()`
    /// leaves every assertion in this file green, which was demonstrated in
    /// review. What guards the view side is the source check in
    /// `scripts/conformance-agent-v2.mjs` (`generationViewOwnership`) — there is
    /// no UI test harness here to do better, and `swift test` does not run on
    /// this toolchain at all.
    @MainActor
    public static func sameModelAcrossVisits(scope raw: String) -> Bool {
        guard let scope = scope(raw) else { return false }
        GenerationRegistry.shared.reset()
        let firstVisit = GenerationRegistry.shared.model(for: scope)
        // A second resolve stands in for the view being destroyed and rebuilt:
        // the registry, not the view, decides what comes back.
        let secondVisit = GenerationRegistry.shared.model(for: scope)
        return firstVisit === secondVisit
    }

    /// Two surfaces never share a model — otherwise starting a Visual
    /// generation would stomp a Doc Gen one, which is the opposite of the
    /// "more than one task at a time" this fix exists to allow.
    @MainActor
    public static func distinctModelsPerScope() -> Bool {
        GenerationRegistry.shared.reset()
        let doc = GenerationRegistry.shared.model(for: .docGen)
        let visual = GenerationRegistry.shared.model(for: .visual)
        return doc !== visual
    }

    @MainActor
    public static func resetDropsModels() -> Bool {
        GenerationRegistry.shared.reset()
        let before = GenerationRegistry.shared.model(for: .docGen)
        GenerationRegistry.shared.reset()
        if GenerationRegistry.shared.hasModel(for: .docGen) { return false }
        return GenerationRegistry.shared.model(for: .docGen) !== before
    }
}
