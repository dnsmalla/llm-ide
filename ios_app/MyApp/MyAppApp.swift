import SwiftUI

@main
struct MyAppApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    /// Built once for the life of the app; `@State` keeps it across scene updates.
    @StateObject private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            ContentView().injecting(model)
        }
    }
}
