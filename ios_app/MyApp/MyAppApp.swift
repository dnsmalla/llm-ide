import SwiftUI

@main
struct MyAppApp: App {
    @StateObject private var connectionStore = ConnectionStore()
    @StateObject private var controlService  = ControlService()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(connectionStore)
                .environmentObject(controlService)
        }
    }
}
