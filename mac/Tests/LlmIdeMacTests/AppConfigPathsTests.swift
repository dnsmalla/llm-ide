import Testing
import Foundation
@testable import LlmIdeMac

/// Pin AppConfig's clone-location behaviour. Clones always land in
/// the default fallback folder now that the Paths root was removed.
@MainActor
struct AppConfigPathsTests {

    /// Build an AppConfig backed by an isolated UserDefaults suite so
    /// tests can't pollute / read real production defaults.
    private func makeConfig() -> AppConfig {
        let suite = UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        return AppConfig(userDefaults: defaults)
    }

    @Test func effectiveClonesURLIsDefaultFallback() {
        let c = makeConfig()
        #expect(c.effectiveClonesURL == AppConfig.defaultClonesFallback)
    }
}

/// Pins AppConfig.defaultProjectSettings — the snapshot ProjectStore
/// uses to materialise `<folder>/system/project.json` on first
/// open. Each AppConfig field that flows into the bundle gets one
/// assertion so future renames break the test instead of silently
/// dropping a default.
@MainActor
struct AppConfigDefaultProjectSettingsTests {

    private func makeConfig() -> AppConfig {
        let suite = UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        return AppConfig(userDefaults: defaults)
    }

    @Test func defaultProjectSettingsMirrorsAppConfig() {
        let cfg = makeConfig()
        let snap = cfg.defaultProjectSettings
        // AppConfig has no global language field — snapshot uses "".
        #expect(snap.language == "")
        #expect(snap.activeCLI == cfg.activeCLI)
        #expect(snap.regressionLookbackCount == cfg.autoCodeUpdateLookbackCount)
        #expect(snap.linkedRepo == nil)
        #expect(snap.notesFolderRelative == nil)
        #expect(snap.enabledPlugins.isEmpty)
        #expect(snap.agentPersona == nil)
        #expect(snap.docTemplatesActive.isEmpty)
    }
}
