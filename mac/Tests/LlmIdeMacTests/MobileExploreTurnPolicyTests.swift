import Testing
import Foundation
@testable import LlmIdeMacLib

/// A phone Explorer turn may only edit or run commands when the user turned
/// the `exploreEdit` switch on; otherwise the Mac's chip must not matter.
@MainActor
@Suite("Mobile explore turn policy", .serialized)
struct MobileExploreTurnPolicyTests {
    private func withChip(_ mode: EditAcceptanceMode, _ body: () -> Void) {
        UserDefaults.standard.set(mode.rawValue, forKey: EditAcceptanceMode.defaultsKey)
        defer { UserDefaults.standard.removeObject(forKey: EditAcceptanceMode.defaultsKey) }
        body()
    }

    @Test func editOffIsReadOnlyRegardlessOfMacChip() {
        withChip(.auto) {
            let policy = MobileExploreBridge.turnPolicy(editAllowed: false)
            #expect(policy.mode == "auto_read_only")
            #expect(policy.permissionMode == nil)
        }
    }

    @Test func editOnInheritsMacChip() {
        withChip(.acceptEdits) {
            let policy = MobileExploreBridge.turnPolicy(editAllowed: true)
            #expect(policy.mode == "auto")
            #expect(policy.permissionMode == "accept-edits")
        }
    }

    @Test func exploreEditDefaultsOff() {
        #expect(PhoneAccess.exploreEdit.defaultsOn == false)
    }
}
