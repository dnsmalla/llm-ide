import SwiftUI

/// What a feature asks for when it embeds the chat panel beside its own
/// content (Explorer, Review Conflicts, Doc Gen, Visual).
///
/// Lives in Core because the embedding features and Chat are peers that may
/// not name each other: the request is the only vocabulary they share. The
/// fields mirror the chat panel's own initializer one-for-one, with the same
/// defaults, so a caller that omits an argument behaves exactly as if it had
/// constructed the panel directly.
struct ChatPanelRequest {
    let api: LlmIdeAPIClient
    /// Which chat this panel shows. Each embedding site passes its own; the
    /// same scope always resolves to the same shared conversation.
    let scope: ChatScope
    /// Attached automatically the first time the panel appears.
    var initialURL: URL? = nil
    /// Show "Add from Library" in the input bar.
    var showFileAttachButtons: Bool = true
    /// Show the agent + model picker row in the input bar.
    var showModelPicker: Bool = false
}

/// The two code-change sheets a feature may open against a repo target.
enum CodeWorkflowSheetKind: Equatable {
    /// The one-screen Quick Fix flow.
    case quickFix
    /// The multi-step guided workflow.
    case guided
}

/// A request to present one of the code-change sheets. `target` is the
/// backend-neutral repo descriptor (Core), so a feature can resolve it on its
/// own and only the sheet itself stays in Chat.
struct CodeWorkflowSheetRequest {
    let api: LlmIdeAPIClient
    let target: CodeWorkflowTarget
    let kind: CodeWorkflowSheetKind
}

/// Hands features the chat panel (and the code-change sheets) without them
/// naming Chat. Shell installs the makers once at boot
/// (`FeatureCatalog.installChatSeams`); features render through
/// `ChatPanelView` / `CodeWorkflowSheetView`.
///
/// Contract:
/// - `installPanel(_:)` / `installCodeWorkflowSheet(_:)`
///   - Pre: main actor.
///   - Post: the maker replaces any previous one (last install wins, so a
///     boot path that runs twice cannot stack makers); publishes a change so
///     an already-mounted `ChatPanelView` re-renders with the real panel.
/// - `makePanel(_:)` / `makeCodeWorkflowSheet(_:)`
///   - Post: the installed maker's view for exactly this request. When
///     nothing is installed (a test, or a boot-order bug) it returns a
///     visible "unavailable" placeholder — never crashes and never an
///     invisible `EmptyView`, because an empty split-view column or blank
///     sheet would hide the bug instead of showing it.
@MainActor
final class ChatPanelRegistry: ObservableObject {
    static let shared = ChatPanelRegistry()

    @Published private var panelMaker: (@MainActor (ChatPanelRequest) -> AnyView)?
    @Published private var sheetMaker: (@MainActor (CodeWorkflowSheetRequest) -> AnyView)?

    /// Internal (not private) so tests can use an isolated instance instead
    /// of mutating `shared`, which the running app also reads.
    init() {}

    var isPanelInstalled: Bool { panelMaker != nil }
    var isCodeWorkflowSheetInstalled: Bool { sheetMaker != nil }

    func installPanel(_ make: @escaping @MainActor (ChatPanelRequest) -> AnyView) {
        panelMaker = make
    }

    func installCodeWorkflowSheet(_ make: @escaping @MainActor (CodeWorkflowSheetRequest) -> AnyView) {
        sheetMaker = make
    }

    func makePanel(_ request: ChatPanelRequest) -> AnyView {
        guard let panelMaker else {
            return AnyView(ChatSeamUnavailableView(what: "Chat"))
        }
        return panelMaker(request)
    }

    func makeCodeWorkflowSheet(_ request: CodeWorkflowSheetRequest) -> AnyView {
        guard let sheetMaker else {
            return AnyView(ChatSeamUnavailableView(what: "Code change"))
        }
        return sheetMaker(request)
    }
}

/// The chat panel for one request, as a single view expression so call sites
/// keep their modifiers (`.persistedPanelWidth`, `.transition`) exactly where
/// they were. Observes the registry so a panel mounted before Shell's install
/// (never expected, but harmless) picks the real panel up.
struct ChatPanelView: View {
    let request: ChatPanelRequest
    @ObservedObject var registry: ChatPanelRegistry = .shared

    var body: some View {
        registry.makePanel(request)
    }
}

/// One of the code-change sheets, for use inside `.sheet { … }`.
struct CodeWorkflowSheetView: View {
    let request: CodeWorkflowSheetRequest
    @ObservedObject var registry: ChatPanelRegistry = .shared

    var body: some View {
        registry.makeCodeWorkflowSheet(request)
    }
}

/// Fallback shown when no maker is installed. Deliberately visible: see the
/// registry's contract.
private struct ChatSeamUnavailableView: View {
    let what: String

    var body: some View {
        VStack(spacing: 6) {
            Image(systemName: "bubble.left.and.exclamationmark.bubble.right")
                .font(.system(size: 20))
            Text("\(what) is unavailable")
                .font(.callout)
        }
        .foregroundStyle(.secondary)
        .frame(minWidth: 180, maxWidth: .infinity, minHeight: 120, maxHeight: .infinity)
    }
}
