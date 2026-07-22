import SwiftUI

struct ContentView: View {
    @EnvironmentObject var controlService: ControlService
    @EnvironmentObject var connectionStore: ConnectionStore

    var body: some View {
        if connectionStore.hasDevice {
            // Already have saved connection — go straight to remote desktop.
            // RemoteDesktopView shows a spinner while (re)connecting.
            NavigationStack {
                RemoteDesktopView(deviceName: connectionStore.deviceIP)
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
