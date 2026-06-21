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

    @Test @MainActor func connectRemoteOpensRemoteTabAndPanel() {
        let state = TerminalPanelState()
        state.connectRemote(host: RemoteHost(alias: "prod", hostName: nil, user: nil, port: nil))
        #expect(state.sessions.count == 1)
        #expect(state.sessions.first?.remoteAlias == "prod")
        #expect(state.isOpen == true)
        #expect(state.activeDockTab == .terminal)
        #expect(state.activeIndex == 0)
    }
}
