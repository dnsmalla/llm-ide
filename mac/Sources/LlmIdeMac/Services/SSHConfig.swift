import Foundation

/// A connectable host discovered from `~/.ssh/config`.
struct RemoteHost: Identifiable, Hashable {
    var id: String { alias }
    let alias: String       // the `Host` token used as `ssh <alias>`
    let hostName: String?   // HostName
    let user: String?       // User
    let port: Int?          // Port

    /// Display subtitle, e.g. "deploy@10.0.0.5:2222"; falls back to the alias.
    var subtitle: String {
        var s = ""
        if let user { s += "\(user)@" }
        s += hostName ?? alias
        if let port { s += ":\(port)" }
        return s
    }
}

/// Reads + parses `~/.ssh/config` into connectable hosts. Pure where it can be
/// (parse from a String) so it's unit-testable without disk.
enum SSHConfig {
    static var defaultConfigURL: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".ssh/config")
    }

    /// Read the config file (or return [] if absent/unreadable) and parse it.
    static func discover(configURL: URL? = nil) -> [RemoteHost] {
        let url = configURL ?? defaultConfigURL
        guard let text = try? String(contentsOf: url, encoding: .utf8) else { return [] }
        return parse(text)
    }

    /// Parse ssh-config text into hosts. One host per `Host` block, keyed by the
    /// first concrete (non-wildcard) pattern on the `Host` line; wildcard-only
    /// blocks are skipped. `Include` directives are not expanded (Phase 1).
    static func parse(_ text: String) -> [RemoteHost] {
        var hosts: [RemoteHost] = []
        var alias: String? = nil
        var hostName: String? = nil
        var user: String? = nil
        var port: Int? = nil

        func flush() {
            if let alias { hosts.append(RemoteHost(alias: alias, hostName: hostName, user: user, port: port)) }
            alias = nil; hostName = nil; user = nil; port = nil
        }

        for rawLine in text.split(separator: "\n", omittingEmptySubsequences: false) {
            let line = rawLine.trimmingCharacters(in: .whitespaces)
            if line.isEmpty || line.hasPrefix("#") { continue }

            // "Key rest of line" — key is the first token, value is the remainder.
            let parts = line.split(separator: " ", maxSplits: 1, omittingEmptySubsequences: true)
            guard let keyToken = parts.first else { continue }
            let key = keyToken.lowercased()
            let value = parts.count > 1 ? parts[1].trimmingCharacters(in: .whitespaces) : ""

            if key == "host" {
                flush()
                // First concrete pattern (no '*' or '?') becomes the alias.
                let patterns = value.split(separator: " ").map(String.init)
                alias = patterns.first { !$0.contains("*") && !$0.contains("?") }
                // wildcard-only block → alias stays nil → flush() skips it
            } else if alias != nil {
                switch key {
                case "hostname": hostName = value.isEmpty ? nil : value
                case "user":     user = value.isEmpty ? nil : value
                case "port":     port = Int(value)
                default:         break
                }
            }
        }
        flush()
        return hosts
    }
}

/// The system-`ssh` command used to open a remote shell.
enum RemoteSSHCommand {
    static let sshPath = "/usr/bin/ssh"
    /// `-t` forces a PTY so remote full-screen programs (vim/htop) and prompts
    /// (passphrase, host-key) work in the terminal.
    static func args(forAlias alias: String) -> [String] { ["-t", alias] }
}
