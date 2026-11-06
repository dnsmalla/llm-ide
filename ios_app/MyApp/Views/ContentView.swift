import SwiftUI

struct ContentView: View {
    @EnvironmentObject var connection: ConnectionService
    @EnvironmentObject var connectionStore: ConnectionStore
    @EnvironmentObject var syncStore: SyncStore
    @Environment(\.scenePhase) private var scenePhase
    @AppStorage("llmide.demo") private var demo = false

    var body: some View {
        if demo {
            DemoRootView()
        } else {
            connectedShell
        }
    }

    private var connectedShell: some View {
        // The enrollment sheet sits above both branches: a sync QR can be scanned from the pairing screen too.
        shell.sheet(isPresented: Binding(get: { syncStore.enrollStep != nil }, set: { if !$0 { syncStore.cancelEnrollment() } })) {
            SyncEnrollSheet().environmentObject(syncStore)
        }
    }

    @ViewBuilder private var shell: some View {
        if connectionStore.hasDevice || syncStore.phase != .off {
            // A paired desktop or offline sync: go straight to the tab shell. Each screen shows its own
            // connecting/offline banner while (re)connecting.
            RootTabView(deviceName: connectionStore.displayName)
                .onAppear {
                    // Re-establish the connection if not already connected — but not if the user explicitly
                    // closed it via closeConnection() (popping back from Settings must not undo that).
                    if connection.connectionStatus == .disconnected, !connection.userClosed, connectionStore.hasDevice {
                        connection.connect(ip: connectionStore.deviceIP, pin: connectionStore.devicePIN)
                    }
                }
                // `onAppear` does NOT re-fire on foregrounding, and iOS suspends the socket in the background.
                .onChange(of: scenePhase) { phase in
                    syncStore.setForeground(phase == .active)
                    guard phase == .active, connectionStore.hasDevice,
                          connection.connectionStatus == .disconnected, !connection.userClosed else { return }
                    connection.connect(ip: connectionStore.deviceIP, pin: connectionStore.devicePIN)
                }
        } else {
            NavigationStack {
                ConnectView()
            }
        }
    }
}
