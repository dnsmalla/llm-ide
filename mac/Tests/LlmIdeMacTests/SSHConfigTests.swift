import Testing
import Foundation
@testable import LlmIdeMac

struct SSHConfigTests {
    @Test func parsesMultipleHostsWithFields() {
        let cfg = """
        Host web
            HostName 10.0.0.5
            User deploy
            Port 2222

        Host db
            HostName db.internal
        """
        let hosts = SSHConfig.parse(cfg)
        #expect(hosts.map(\.alias) == ["web", "db"])
        let web = hosts.first { $0.alias == "web" }
        #expect(web?.hostName == "10.0.0.5")
        #expect(web?.user == "deploy")
        #expect(web?.port == 2222)
    }

    @Test func skipsWildcardOnlyBlocks() {
        let cfg = """
        Host *
            User root
        Host *.internal
            User admin
        Host prod
            HostName prod.example.com
        """
        #expect(SSHConfig.parse(cfg).map(\.alias) == ["prod"])
    }

    @Test func mixedConcreteAndWildcardKeepsFirstConcrete() {
        let cfg = """
        Host prod *.internal
            HostName prod.example.com
        """
        let hosts = SSHConfig.parse(cfg)
        #expect(hosts.map(\.alias) == ["prod"])
        #expect(hosts.first?.hostName == "prod.example.com")
    }

    @Test func ignoresCommentsBlankLinesAndIsCaseInsensitive() {
        let cfg = """
        # a comment
        Host srv

          hostname  example.com
          USER  me
        """
        let hosts = SSHConfig.parse(cfg)
        #expect(hosts.count == 1)
        #expect(hosts.first?.hostName == "example.com")
        #expect(hosts.first?.user == "me")
    }

    @Test func emptyInputYieldsNoHosts() {
        #expect(SSHConfig.parse("").isEmpty)
    }

    @Test func discoverMissingFileReturnsEmpty() {
        let url = URL(fileURLWithPath: "/nonexistent/\(UUID().uuidString)/config")
        #expect(SSHConfig.discover(configURL: url).isEmpty)
    }

    @Test func remoteCommandArgsForceTTY() {
        #expect(RemoteSSHCommand.args(forAlias: "prod") == ["-t", "prod"])
    }

    @Test func subtitleComposesUserHostPort() {
        let h = RemoteHost(alias: "web", hostName: "10.0.0.5", user: "deploy", port: 2222)
        #expect(h.subtitle == "deploy@10.0.0.5:2222")
    }

    @Test func subtitleFallsBackToAliasWhenNoHostName() {
        let h = RemoteHost(alias: "box", hostName: nil, user: nil, port: nil)
        #expect(h.subtitle == "box")
    }
}
