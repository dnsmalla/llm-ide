import Foundation
import SwiftUI

/// The words the live-then-archive mode control shows, one place so tests can pin them.
enum LiveThenArchiveWording {
    static func title(_ mode: LiveThenArchiveMode) -> String {
        switch mode {
        case .off: return "Off"
        case .shadow: return "Shadow"
        case .on: return "On"
        }
    }

    static func explanation(_ mode: LiveThenArchiveMode) -> String {
        switch mode {
        case .off:
            return "Chats work as they always did. Nothing is archived, and signing out clears ordinary chats."
        case .shadow:
            return "A trial run. Chats are copied into files on this Mac and checked, but nothing is deleted from the server, and signing out keeps your chats."
        case .on:
            return "Chats live on this Mac. At quit they are saved and checked, then the server's working copy is removed. Deleting a chat removes it everywhere."
        }
    }

    static let restartNote = "A change applies the next time you open the app."
    static let offConfirmTitle = "Turn archiving off?"
    static let offConfirmMessage = "Chats already archived on this Mac, including those from the browser extension, are kept. New chats stop being archived, and signing out clears ordinary chats again."
}

/// State behind the Settings control for `lta.mode`. It reads and writes the same UserDefaults key the app reads
/// at boot (`LiveThenArchiveMode.launchValue`), so a change never switches a running service: it shows
/// "applies at next launch" until the app restarts.
@MainActor
final class LiveThenArchiveSettingModel: ObservableObject {
    /// What the user chose (what is stored).
    @Published private(set) var selected: LiveThenArchiveMode
    /// Set when switching to Off needs the user's confirmation first.
    @Published private(set) var pendingOff = false

    /// The mode the running app started with.
    let launchMode: LiveThenArchiveMode
    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard, launchMode: LiveThenArchiveMode = LiveThenArchiveMode.launchValue) {
        self.defaults = defaults
        self.launchMode = launchMode
        self.selected = LiveThenArchiveMode.current(defaults)
    }

    /// True when the stored mode differs from the one this launch runs with.
    var needsRestart: Bool { selected != launchMode }

    /// The user picked `mode`. Switching to Off from On (stored or running) waits for `confirmOff`; everything else
    /// is stored at once. Returns whether it was stored.
    @discardableResult
    func choose(_ mode: LiveThenArchiveMode) -> Bool {
        pendingOff = false
        guard mode != selected else { return true }
        if mode == .off, selected == .on || launchMode == .on {
            pendingOff = true
            return false
        }
        store(mode)
        return true
    }

    func confirmOff() {
        guard pendingOff else { return }
        pendingOff = false
        store(.off)
    }

    func cancelOff() { pendingOff = false }

    private func store(_ mode: LiveThenArchiveMode) {
        defaults.set(mode.rawValue, forKey: LiveThenArchiveMode.defaultsKey)
        selected = mode
    }
}
