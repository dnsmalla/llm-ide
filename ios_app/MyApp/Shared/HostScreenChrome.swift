import SwiftUI
import SharedProtocol

/// The strip every host-backed tab shows above its content: the connection state, the shared error banner, and the
/// project the screen works in. One modifier, so a new tab gets all three by adding `.hostScreenChrome(...)`.
private struct HostScreenChrome: ViewModifier {
    @EnvironmentObject var connection: ConnectionService
    @EnvironmentObject var projects: ProjectsStore
    let isBusy: Bool

    func body(content: Content) -> some View {
        content.safeAreaInset(edge: .top, spacing: 0) {
            VStack(spacing: 0) {
                if connection.connectionStatus != .connected {
                    StatusBanner(.connection(isConnecting: connection.connectionStatus == .connecting))
                }
                if let err = connection.errorMessage {
                    StatusBanner(.error(message: err) { connection.errorMessage = nil })
                }
                ProjectPickerBar(isBusy: isBusy) { id in _ = projects.select(id) }
            }
            .background(DesignSystem.Colors.background)
        }
    }
}

extension View {
    /// `isBusy`: a turn is running here, so switching project would send its answer to another project.
    func hostScreenChrome(isBusy: Bool = false) -> some View { modifier(HostScreenChrome(isBusy: isBusy)) }
}
