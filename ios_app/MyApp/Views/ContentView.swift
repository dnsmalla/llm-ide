import SwiftUI

struct ContentView: View {
    @EnvironmentObject var connection: ConnectionService
    @EnvironmentObject var connectionStore: ConnectionStore

    var body: some View {
        if connectionStore.hasDevice {
            // Already have saved connection — go straight to the mobile home
            // (toolbar + Chat/Explore/Auto sheets). Shows a spinner while
            // (re)connecting.
            NavigationStack {
                MobileHomeView(deviceName: connectionStore.displayName)
                    .onAppear {
                        // Re-establish connection if not already connected —
                        // but not if the user explicitly closed it via
                        // closeConnection() (e.g. popping back from Settings
                        // must not silently undo an intentional close).
                        if connection.connectionStatus == .disconnected, !connection.userClosed {
                            connection.connectDirect(
                                ip: connectionStore.deviceIP,
                                port: connectionStore.devicePort,
                                pin: connectionStore.devicePIN
                            )
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
