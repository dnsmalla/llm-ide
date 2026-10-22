import SwiftUI

/// What a feature passes when it lets an in-progress live capture take over
/// part of its UI (Library's meeting detail pane).
///
/// Lives in Core because Library and Live are peers that may not name each
/// other. The take-over decision ("is a capture running, or is its post-stop
/// banner still showing?") reads Live's observable `CaptionOrchestrator`; that
/// observation only works where the orchestrator is an `@EnvironmentObject`,
/// i.e. inside a Live view. So instead of exporting the capture state through
/// a protocol (which SwiftUI could not observe through an existential), the
/// seam hands Live the caller's normal content and lets Live choose.
struct LiveCaptureGateRequest {
    let api: LlmIdeAPIClient
    /// The caller's own content, shown whenever no live session owns the pane.
    let idle: @MainActor () -> AnyView
}

/// Hands features the live-capture take-over view without them naming Live.
/// Shell installs the maker once at boot (`FeatureCatalog.installLiveSeams`);
/// features render through `LiveCaptureGate`.
///
/// Contract:
/// - `install(_:)`
///   - Pre: main actor.
///   - Post: the maker replaces any previous one (last install wins, so a boot
///     path that runs twice cannot stack makers); publishes a change so an
///     already-mounted `LiveCaptureGate` re-renders through the real maker.
/// - `make(_:)`
///   - Post: the installed maker's view for exactly this request. When nothing
///     is installed (a test, or a boot-order bug) it returns the request's
///     `idle` content unchanged. Unlike `ChatPanelRegistry` there is no
///     "unavailable" placeholder: this seam WRAPS the caller's content, and a
///     placeholder would hide every meeting instead of just the live view —
///     with no Live maker there is, correctly, never a live session to show.
@MainActor
final class LiveCaptureRegistry: ObservableObject {
    static let shared = LiveCaptureRegistry()

    @Published private var maker: (@MainActor (LiveCaptureGateRequest) -> AnyView)?

    /// Internal (not private) so tests can use an isolated instance instead
    /// of mutating `shared`, which the running app also reads.
    init() {}

    var isInstalled: Bool { maker != nil }

    func install(_ make: @escaping @MainActor (LiveCaptureGateRequest) -> AnyView) {
        maker = make
    }

    func make(_ request: LiveCaptureGateRequest) -> AnyView {
        guard let maker else { return request.idle() }
        return maker(request)
    }
}

/// Shows the live capture (recording banner + transcript) while one is active,
/// otherwise `content`. A single view expression so the caller keeps its
/// modifiers (`.onChange`, `.toolbar`) exactly where they were. The installed
/// maker always returns the same concrete view type, so SwiftUI identity — and
/// the caller's `@State` beneath it — survives capture start/stop.
struct LiveCaptureGate<Content: View>: View {
    let api: LlmIdeAPIClient
    @ViewBuilder let content: () -> Content
    @ObservedObject var registry: LiveCaptureRegistry = .shared

    var body: some View {
        registry.make(LiveCaptureGateRequest(api: api, idle: { AnyView(content()) }))
    }
}
