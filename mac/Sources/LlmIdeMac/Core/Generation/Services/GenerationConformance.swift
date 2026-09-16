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

    // MARK: - Markdown preview gating

    /// Whether the renderer would ship the mermaid bundle for this input.
    ///
    /// The invariant worth pinning is the NEGATIVE one: mermaid must stay out of
    /// the chat renderer. It draws asynchronously while `renderMarkdown` returns
    /// a synchronous height, so a chat bubble measured by
    /// `SelfSizingMarkdownView` would be sized before the diagram existed — and
    /// it is 3.4 MB for the web view to parse on every reply.
    public static func previewShipsMermaid(markdown: String, enabled: Bool) -> Bool {
        // Look for the BUNDLE, not for `mermaid.initialize` — that call lives in
        // the template unconditionally, guarded by `if (!window.mermaid)`, so
        // searching for it reports true for every document. (It did, and the
        // assertions caught it.)
        guard !Mermaid.js.isEmpty else { return false }
        let fingerprint = String(Mermaid.js.prefix(400))
        return MarkdownRenderer.html(for: markdown, isDark: false, enableMermaid: enabled)
            .contains(fingerprint)
    }

    /// The rendered document's `const raw = \`…\`` line — the JS template
    /// literal the markdown body is embedded in.
    ///
    /// Ported from `MarkdownRendererEscapingTests.swift`, which asserts the same
    /// thing and has never once run: it is an XCTest/swift-testing file, and
    /// this toolchain has no XCTest. That escaping is the control standing
    /// between LLM-authored document text and script execution inside the
    /// preview's WKWebView, so it needs a gate that actually executes.
    public static func renderedTemplateLiteralLine(for markdown: String) -> String? {
        MarkdownRenderer.html(for: markdown, isDark: false)
            .components(separatedBy: "\n")
            .first { $0.hasPrefix("const raw = ") }
    }

    /// The whole rendered document. For assertions about MULTI-LINE content:
    /// `renderedTemplateLiteralLine` returns only the first line of the
    /// template literal, so anything on a later line is invisible to it.
    public static func renderedHTML(for markdown: String) -> String {
        MarkdownRenderer.html(for: markdown, isDark: false)
    }

    /// Whether the renderer detects a mermaid fence at all — independent of
    /// whether the caller asked for it.
    public static func detectsMermaidFence(_ markdown: String) -> Bool {
        MarkdownRenderer.needsMermaid(markdown)
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
