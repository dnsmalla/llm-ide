import Testing
@testable import MeetNotesMac
import Foundation

struct NotesFolderConfigTests {

    @Test func defaultPath() {
        let cfg = NotesFolderConfig(userDefaults: makeUserDefaults())
        let expected = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("MeetNotes", isDirectory: true)
        #expect(cfg.currentFolder.path == expected.path)
    }

    @Test func syncProviderDetection() {
        #expect(NotesFolderConfig.detectSyncProvider(
            at: URL(fileURLWithPath: "/Users/x/Library/Mobile Documents/com~apple~CloudDocs/Notes"))
            == .icloudDrive)
        #expect(NotesFolderConfig.detectSyncProvider(
            at: URL(fileURLWithPath: "/Users/x/Dropbox/Notes"))
            == .dropbox)
        #expect(NotesFolderConfig.detectSyncProvider(
            at: URL(fileURLWithPath: "/Users/x/Library/CloudStorage/GoogleDrive-foo@bar.com/Notes"))
            == .googleDrive)
        #expect(NotesFolderConfig.detectSyncProvider(
            at: URL(fileURLWithPath: "/Users/x/Library/CloudStorage/OneDrive-Personal/Notes"))
            == .oneDrive)
        #expect(NotesFolderConfig.detectSyncProvider(
            at: URL(fileURLWithPath: "/Users/x/Documents/MeetNotes"))
            == nil)
    }

    private func makeUserDefaults() -> UserDefaults {
        let suite = "test-\(UUID().uuidString)"
        let ud = UserDefaults(suiteName: suite)!
        ud.removePersistentDomain(forName: suite)
        return ud
    }
}
