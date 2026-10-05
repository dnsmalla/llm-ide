import Foundation

/// What the plugin detail view tells the user about trust and about the
/// components a package brought along — one place, so the wording follows the
/// server's real delivery rules instead of a single assumed mechanism.
///
/// The rules it mirrors (extension/llm_agent/skills/registry.mjs
/// `buildUserPluginDelivery`): monitors, language servers, `bin/` and JS hook
/// modules run only when the Agent engine loads a `.claude-plugin` package
/// natively; with native loading off, or for a Codex layout, only `command`
/// hooks run (translated). `PluginInfo.agentEngineCanLoad` carries those two
/// facts, because `nativeDelivery` alone is false in every one of those cases.
enum PluginTrustPresentation {
    enum ComponentStatus: Equatable {
        /// The Agent engine will run it once the plugin is trusted.
        case agentEngine
        /// It would run, but native plugin loading is switched off.
        case nativeOff
        /// Nothing here runs it.
        case ignored
    }

    /// `executableKinds` name for a component listed in `unsupportedComponents`.
    private static func kind(of component: String) -> String? {
        switch component {
        case "monitors": return "monitors"
        case ".lsp.json": return "lsp"
        case "bin": return "bin"
        default: return nil
        }
    }

    static func componentStatus(_ component: String, _ plugin: PluginInfo) -> ComponentStatus {
        guard let kind = kind(of: component), plugin.executableKinds.contains(kind) else { return .ignored }
        if plugin.agentEngineCanLoad { return .agentEngine }
        // A Codex layout never reaches the SDK; with the pref off it would.
        return (plugin.sdkReadable ?? true) ? .nativeOff : .ignored
    }

    /// "Hooks" unless the package also brings scripts the engine runs.
    static func hooksHeading(_ plugin: PluginInfo) -> String {
        plugin.executableKinds.contains { $0 != "hooks" } ? "Hooks & scripts" : "Hooks"
    }

    /// The toggle's label names what is being trusted.
    static func trustLabel(_ plugin: PluginInfo) -> String {
        if plugin.executableKinds.contains(where: { $0 != "hooks" }) { return "Trust \(plugin.executableSummary)" }
        return plugin.hookCount > 0
            ? "Trust hooks (\(plugin.hookCount) handler\(plugin.hookCount == 1 ? "" : "s"))"
            : "Trust hooks"
    }

    static func trustExplanation(_ plugin: PluginInfo) -> String {
        let beyondHooks = plugin.executableKinds.contains { $0 != "hooks" }
        // Nothing would run at all: say why instead of promising something.
        if !plugin.agentEngineCanLoad && plugin.hookCount == 0 {
            let reason = (plugin.sdkReadable ?? true)
                ? "native plugin loading is off (Settings → Preferences)"
                : "LLM-IDE can only run command hooks from a package in this format"
            return "Nothing from this plugin runs right now: \(reason). Trusting it changes nothing until that changes."
        }
        guard plugin.hooksTrusted else {
            if beyondHooks && plugin.agentEngineCanLoad {
                let sandbox = plugin.executableKinds.contains("monitors")
                    ? " Background monitors run outside the sandbox." : ""
                return "Turning this on lets the agent engine run this plugin's \(plugin.executableSummary) with the same access as the app.\(sandbox) Leave it off unless you trust the author."
            }
            return "Turning this on lets this plugin run commands from its hooks file during a turn. Leave it off unless you trust the author."
        }
        if plugin.nativeDelivery {
            return "The agent engine loads this plugin and runs its \(beyondHooks ? plugin.executableSummary : "hooks") as its author wrote them, with the same access as the app."
        }
        if plugin.hookCount > 0 {
            return "LLM-IDE runs this plugin's command hooks during a turn, with the same access as the app."
        }
        return "Trusted. It runs once the plugin is enabled."
    }
}
