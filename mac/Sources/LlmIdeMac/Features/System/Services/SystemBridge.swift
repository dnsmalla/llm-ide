import Foundation

/// Messages the OS page posts to Swift through
/// `window.webkit.messageHandlers.llmide.postMessage({...})`.
///
/// Fixed contract shared with the React page (`mac/Sources/LlmIdeMac/Resources/os-view`):
/// - `{type:'ready'}` — the page has loaded; Swift answers with `llmideConfigure`.
/// - `{type:'needToken'}` — the page has no usable token; Swift refreshes the
///   session if it can and answers with `llmideConfigure` again.
/// - `{type:'open', target}` — the page asks the shell to show a section.
enum SystemBridgeInbound: Equatable {
    case ready
    case needToken
    case open(target: String)

    /// Decodes a script-message body. Unknown types and malformed bodies are
    /// `nil`, which the caller ignores: a page must not be able to drive the
    /// shell by sending something unexpected.
    static func decode(_ body: Any) -> SystemBridgeInbound? {
        guard let dict = body as? [String: Any], let type = dict["type"] as? String else { return nil }
        switch type {
        case "ready":
            return .ready
        case "needToken":
            return .needToken
        case "open":
            guard let target = dict["target"] as? String, !target.isEmpty else { return nil }
            return .open(target: target)
        default:
            return nil
        }
    }
}

/// The argument of `window.llmideConfigure(...)`.
///
/// `token` is encoded as an explicit `null` when there is no session (not
/// omitted) so the page can tell "signed out" from "not configured yet".
struct SystemBridgeConfig: Encodable, Equatable {
    let baseURL: String
    let token: String?
    let theme: String
    let projectName: String?

    private enum Keys: String, CodingKey {
        case baseURL, token, theme, projectName
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Keys.self)
        try c.encode(baseURL, forKey: .baseURL)
        try c.encode(token, forKey: .token)
        try c.encode(theme, forKey: .theme)
        try c.encode(projectName, forKey: .projectName)
    }
}

/// Pure helpers for the OS view bridge. Everything that turns app values
/// into JavaScript or decides what a page may do lives here, so it is
/// testable without a WKWebView.
enum SystemBridge {
    /// The JavaScript that hands the page its configuration.
    ///
    /// The config is JSON-encoded (`JSONEncoder`), so a token containing
    /// quotes, backslashes or control characters arrives as a correctly
    /// escaped JavaScript string literal. The token is never placed in a URL,
    /// a file, or a log line.
    static func configureScript(_ config: SystemBridgeConfig) -> String? {
        guard let data = try? JSONEncoder().encode(config),
              let json = String(data: data, encoding: .utf8) else { return nil }
        return "window.llmideConfigure(\(json));"
    }

    /// Maps a page's `open` target to a shell section. Returns `nil` for an
    /// unknown target, and for a section whose feature is not compiled in or
    /// not enabled, so the page cannot route into a disabled feature.
    @MainActor
    static func section(forOpenTarget target: String,
                        isEnabled: (AppFeature) -> Bool = { FeatureRegistry.shared.isEnabled($0) }) -> ShellSection? {
        let section: ShellSection
        switch target {
        case "loop":      section = .loopEngine
        case "autoTasks": section = .autoCode
        case "settings":  section = .settings
        case "library":   section = .library
        default:          return nil
        }
        if let feature = section.backingFeature, !isEnabled(feature) { return nil }
        return section
    }

    /// Whether a navigation may proceed in the OS view: only file URLs inside
    /// the bundled page's own directory. Every remote URL, every other
    /// local file, and any `..` escape is refused.
    static func isLocalNavigation(_ url: URL?, bundleDirectory: URL?) -> Bool {
        guard let url, url.isFileURL, let bundleDirectory else { return false }
        let root = bundleDirectory.standardizedFileURL.path
        let path = url.standardizedFileURL.path
        return path.hasPrefix(root + "/")
    }
}
