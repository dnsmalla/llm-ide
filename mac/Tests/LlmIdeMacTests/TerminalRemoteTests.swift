import Testing
import Foundation
@testable import LlmIdeMac

struct TerminalRemoteTests {
    @Test @MainActor func remoteSessionTitleAndAlias() {
        let s = TerminalSession(number: 3, workingDirectory: URL(fileURLWithPath: "/"),
                                remoteAlias: "prod")
        #expect(s.title == "ssh: prod")
        #expect(s.remoteAlias == "prod")
    }

    @Test @MainActor func localSessionTitleAndNilAlias() {
        let s = TerminalSession(number: 3, workingDirectory: URL(fileURLWithPath: "/"))
        #expect(s.title == "zsh 3")
        #expect(s.remoteAlias == nil)
    }
}
