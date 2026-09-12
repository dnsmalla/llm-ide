import SwiftUI

struct ContentView: View {
    @EnvironmentObject var connection: ConnectionService
    @EnvironmentObject var connectionStore: ConnectionStore
    @EnvironmentObject var macStatusStore: MacStatusStore
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        // `isDemo` joins `hasDevice` here because demo mode deliberately saves
        // no device — without it the demo would be bounced straight back to the
        // pairing screen on the next render.
        if connectionStore.hasDevice || connection.isDemo {
            // Already have saved connection — go straight to the mobile home
            // (toolbar + Chat/Explore/Auto sheets). Shows a spinner while
            // (re)connecting.
            NavigationStack {
                MobileHomeView(deviceName: connection.isDemo ? DemoResponder.macName
                                                               : connectionStore.displayName)
                    .onAppear {
                        // Re-establish connection if not already connected —
                        // but not if the user explicitly closed it via
                        // closeConnection() (e.g. popping back from Settings
                        // must not silently undo an intentional close).
                        if connection.connectionStatus == .disconnected, !connection.userClosed,
                           !connection.isDemo {
                            connection.connectDirect(
                                ip: connectionStore.deviceIP,
                                port: connectionStore.devicePort,
                                pin: connectionStore.devicePIN
                            )
                        }
                    }
                    // iOS suspends the WebSocket in the background, and
                    // `onAppear` does NOT re-fire on foregrounding — so
                    // recovery used to depend on whichever came first, a stale
                    // receive callback or the next heartbeat tick, with no
                    // resync of the mirrored Mac state.
                    .onChange(of: scenePhase) { phase in
                        guard phase == .active, !connection.isDemo,
                              connectionStore.hasDevice else { return }
                        if connection.connectionStatus == .disconnected, !connection.userClosed {
                            connection.connectDirect(
                                ip: connectionStore.deviceIP,
                                port: connectionStore.devicePort,
                                pin: connectionStore.devicePIN
                            )
                        } else if connection.connectionStatus == .connected {
                            // Live socket, but the snapshot may be minutes old.
                            macStatusStore.requestMacStatus()
                        }
                    }
            }
        } else {
            NavigationStack {
                ConnectView()
            }
        }
    }
}
