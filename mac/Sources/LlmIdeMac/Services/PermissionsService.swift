import Foundation
import AppKit
import ApplicationServices
import AVFoundation
import Combine

/// Live state of every macOS permission the app cares about.  Onboarding
/// reads it; running scrapers read it.  We poll once per second while
/// the Permissions view is on screen because there's no system-wide
/// "permission changed" notification — the user grants in System
/// Settings and we have to notice.
@MainActor
final class PermissionsService: ObservableObject {
    enum State { case granted, denied, unknown }

    @Published var accessibility: State = .unknown
    @Published var screenRecording: State = .unknown
    @Published var microphone: State = .unknown

    private var pollTimer: Timer?

    /// Accessibility — we use the silent probe (`AXIsProcessTrusted`)
    /// rather than the prompting `AXIsProcessTrustedWithOptions` so
    /// we can show our own copy + button for what's about to happen
    /// instead of being interrupted by the OS prompt.
    func refreshAccessibility() {
        accessibility = AXIsProcessTrusted() ? .granted : .denied
    }

    /// Screen Recording probe via `CGPreflightScreenCaptureAccess`.
    /// Documented to return false when the app hasn't been granted,
    /// without prompting.
    func refreshScreenRecording() {
        screenRecording = CGPreflightScreenCaptureAccess() ? .granted : .denied
    }

    func refreshMicrophone() {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized:    microphone = .granted
        case .denied, .restricted: microphone = .denied
        case .notDetermined: microphone = .unknown
        @unknown default:    microphone = .unknown
        }
    }

    func refreshAll() {
        refreshAccessibility()
        refreshScreenRecording()
        refreshMicrophone()
    }

    /// Poll while the user is on the permissions screen.  We tear it
    /// down when the view disappears so we don't keep waking the CPU
    /// after onboarding finishes.
    func startPolling() {
        stopPolling()
        refreshAll()
        let timer = Timer(timeInterval: 1.0, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.refreshAll() }
        }
        RunLoop.main.add(timer, forMode: .common)
        pollTimer = timer
    }

    func stopPolling() {
        pollTimer?.invalidate()
        pollTimer = nil
    }

    // --- Trigger / open System Settings panes -------------------------

    /// Prompt the user explicitly.  Kept separate from the silent
    /// probe so the onboarding screen controls when the OS prompt
    /// fires.
    func promptAccessibility() {
        let prompt = "AXTrustedCheckOptionPrompt" as CFString
        _ = AXIsProcessTrustedWithOptions([prompt: kCFBooleanTrue] as CFDictionary)
    }

    func promptMicrophone() {
        AVCaptureDevice.requestAccess(for: .audio) { _ in
            DispatchQueue.main.async { self.refreshMicrophone() }
        }
    }

    /// Open the per-permission System Settings pane.  Pre-Ventura URLs
    /// silently fail open the System Settings root — that's still useful
    /// because the user can navigate from there.
    func openSystemSettings(pane: SettingsPane) {
        let url: URL? = {
            switch pane {
            case .accessibility:
                return URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
            case .screenRecording:
                return URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
            case .microphone:
                return URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone")
            }
        }()
        if let url { NSWorkspace.shared.open(url) }
    }

    enum SettingsPane { case accessibility, screenRecording, microphone }
}
