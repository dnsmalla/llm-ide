import SwiftUI

/// Hands features the Terminal dock without them naming Terminal. Explorer
/// embeds it under its editor column; Shell's own bottom dock calls
/// `FeatureCatalog.terminalPanel` directly. Both reach the SAME catalog-owned
/// session list, because the maker Shell installs here
/// (`FeatureCatalog.installFeatureSeams`) is that same function — installed
/// only when Terminal is compiled in.
///
/// Contract:
/// - `install(_:)`
///   - Pre: main actor.
///   - Post: replaces any previous maker (last install wins); publishes a
///     change so an already-mounted `TerminalPanelSlot` re-renders.
/// - `make(projectDirectory:)`
///   - Post: the installed maker's dock for that directory, or an `EmptyView`
///     when nothing is installed — exactly what the catalog returns when
///     Terminal is compiled out, so the embedding stack lays out the same.
@MainActor
final class TerminalPanelRegistry: ObservableObject {
    static let shared = TerminalPanelRegistry()

    @Published private var maker: (@MainActor (URL) -> AnyView)?

    /// Internal (not private) so tests can use an isolated instance instead
    /// of mutating `shared`, which the running app also reads.
    init() {}

    var isInstalled: Bool { maker != nil }

    func install(_ make: @escaping @MainActor (URL) -> AnyView) {
        maker = make
    }

    func make(projectDirectory: URL) -> AnyView {
        guard let maker else { return AnyView(EmptyView()) }
        return maker(projectDirectory)
    }
}

/// The Terminal dock for one project directory. Always the same concrete
/// view type (its body is always `AnyView`), so SwiftUI identity — and the
/// embedding view's `@State` — is unaffected by whether Terminal is present.
struct TerminalPanelSlot: View {
    let projectDirectory: URL
    @ObservedObject var registry: TerminalPanelRegistry = .shared

    var body: some View {
        registry.make(projectDirectory: projectDirectory)
    }
}
