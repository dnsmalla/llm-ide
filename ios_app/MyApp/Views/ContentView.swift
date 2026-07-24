import SwiftUI

struct ContentView: View {
    @EnvironmentObject var controlService: ControlService
    @EnvironmentObject var connectionStore: ConnectionStore

    var body: some View {
        if connectionStore.hasDevice {
            // Already have saved connection — go straight to the mobile home
            // (toolbar + Chat/Explore/Auto sheets). Shows a spinner while
            // (re)connecting.
            NavigationStack {
                MobileHomeView(deviceName: connectionStore.deviceIP)
                    .onAppear {
                        // Re-establish connection if not already connected.
                        if controlService.connectionStatus == .disconnected {
                            controlService.connectDirect(
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
