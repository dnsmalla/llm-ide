import Foundation
import Combine

@MainActor
public final class AppEnvironment: ObservableObject {
    public static let shared = AppEnvironment()
    
    // Foundational core services
    @Published public var backendManager: BackendManager?
    @Published public var projectStore: ProjectStore?
    
    // Feature-gated background services
    @Published public var mobileWebSocketServer: MobileWebSocketServer?
    @Published public var mobileBonjourAdvertiser: MobileBonjourAdvertiser?
    @Published public var repoFileWatcher: RepoFileWatcher?
    @Published public var autoCaptureService: AutoCaptureService?
    
    private init() {
        setupCoreServices()
    }
    
    private func setupCoreServices() {
        self.projectStore = ProjectStore()
        self.backendManager = BackendManager()
    }
    
    /// Called during boot or feature toggling to sync service lifecycles
    public func syncServiceLifecycles() {
        let registry = FeatureRegistry.shared
        
        // 1. Mobile Companion Sync (.mobileSync)
        if registry.isEnabled(.mobileSync) {
            if mobileWebSocketServer == nil {
                let wsServer = MobileWebSocketServer()
                let advertiser = MobileBonjourAdvertiser()
                wsServer.start()
                advertiser.start()
                self.mobileWebSocketServer = wsServer
                self.mobileBonjourAdvertiser = advertiser
            }
        } else {
            mobileWebSocketServer?.stop()
            mobileBonjourAdvertiser?.stop()
            self.mobileWebSocketServer = nil
            self.mobileBonjourAdvertiser = nil
        }
        
        // 2. 3D Code Graph File Watcher (.codeGraph3D)
        if registry.isEnabled(.codeGraph3D) {
            if repoFileWatcher == nil {
                let watcher = RepoFileWatcher()
                watcher.start()
                self.repoFileWatcher = watcher
            }
        } else {
            repoFileWatcher?.stop()
            self.repoFileWatcher = nil
        }
        
        // 3. Auto Tasks & Activity Capture (.autoTasks)
        if registry.isEnabled(.autoTasks) {
            if autoCaptureService == nil {
                let autoCapture = AutoCaptureService()
                autoCapture.start()
                self.autoCaptureService = autoCapture
            }
        } else {
            autoCaptureService?.stop()
            self.autoCaptureService = autoCapture
        }
    }
}