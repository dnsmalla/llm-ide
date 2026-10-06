import Foundation

/// Where a plugin was installed from — sent to the server at install time
/// (`X-Llmide-Plugin-Source`) and read back on `GET /auth/me/plugins` rows, so
/// the app can later check the origin for a newer version.
///
/// Lives in Core, not Features/Library, because the install DTOs in
/// `LlmIdeAPIClient+Auth.swift` carry it and Core may not name a feature type.
///
/// The server validates every field hard and answers 400 for anything off, which
/// would fail the whole install. `isServerAcceptable` mirrors those rules
/// (`extension/plugins/source-store.mjs`) so a value the server would refuse is
/// simply not sent: the install then succeeds, just without a record.
struct PluginInstallSource: Codable, Equatable, Sendable {
    var kind: String
    var url: String?
    var ref: String?
    var commit: String?
    var entry: String?
    var path: String?
    var tree: String?
    var version: String?
    var fileName: String?
    /// Stamped by the server; decoded from list rows, never sent.
    var installedAt: String?

    static func git(url: String, ref: String?, commit: String) -> PluginInstallSource {
        PluginInstallSource(kind: "git", url: url, ref: ref, commit: commit)
    }

    static func marketplace(url: String, ref: String?, commit: String, entry: String,
                            path: String, tree: String, version: String?) -> PluginInstallSource {
        PluginInstallSource(kind: "marketplace", url: url, ref: ref, commit: commit,
                            entry: entry, path: path, tree: tree, version: version)
    }

    static func zip(fileName: String) -> PluginInstallSource {
        PluginInstallSource(kind: "zip", fileName: fileName)
    }

    /// The header value: JSON of the set fields (no nil keys, never
    /// `installedAt`), base64url without padding.
    func headerValue() throws -> String {
        var outgoing = self
        outgoing.installedAt = nil
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        // Synthesized Encodable uses encodeIfPresent for optionals, so nils
        // are omitted rather than written as null.
        let json = try encoder.encode(outgoing)
        return json.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    // MARK: - Mirror of the server's validation

    /// True when the server's `validateSource` would accept this record.
    var isServerAcceptable: Bool {
        switch kind {
        case "zip":
            return fileName.map(Self.validFileName) ?? false
        case "git", "marketplace":
            guard let url, Self.validURL(url), let commit, Self.isSHA(commit) else { return false }
            if let ref, !Self.validRef(ref) { return false }
            guard kind == "marketplace" else { return true }
            guard let entry, Self.validEntry(entry), let path, Self.validPath(path),
                  let tree, Self.isSHA(tree) else { return false }
            if let version, !Self.validVersion(version) { return false }
            return true
        default:
            return false
        }
    }

    static func isSHA(_ value: String) -> Bool {
        value.count == 40 && value.allSatisfy { ("0"..."9").contains($0) || ("a"..."f").contains($0) }
    }

    static func validRef(_ ref: String) -> Bool {
        (1...128).contains(ref.count) && !ref.hasPrefix("-")
            && ref.unicodeScalars.allSatisfy { isASCIIAlnum($0) || "._/-".unicodeScalars.contains($0) }
    }

    static func validEntry(_ entry: String) -> Bool {
        let scalars = Array(entry.unicodeScalars)
        guard (2...41).contains(scalars.count), let first = scalars.first,
              ("a"..."z").contains(first) else { return false }
        return scalars.allSatisfy { ("a"..."z").contains($0) || ("0"..."9").contains($0) || $0 == "-" }
    }

    /// Relative, no empty / `.` / `..` segment (which also rules out a trailing
    /// `/`), no backslash, no whitespace or control characters.
    static func validPath(_ path: String) -> Bool {
        guard !path.isEmpty, path.count <= 256, !path.hasPrefix("/"), !path.contains("\\"),
              !hasUnsafeChars(path) else { return false }
        return !path.split(separator: "/", omittingEmptySubsequences: false)
            .contains { $0.isEmpty || $0 == "." || $0 == ".." }
    }

    static func validVersion(_ version: String) -> Bool {
        !version.isEmpty && version.count <= 64 && isPrintableASCII(version)
    }

    static func validFileName(_ name: String) -> Bool {
        !name.isEmpty && name.count <= 255 && isPrintableASCII(name) && !name.contains("/")
    }

    static func validURL(_ url: String) -> Bool {
        guard !url.isEmpty, url.count <= 512, !hasUnsafeChars(url) else { return false }
        if url.hasPrefix("git@") { return validScpURL(url) }
        if url.contains("?") || url.contains("#") { return false }
        guard let parts = URLComponents(string: url), parts.scheme?.lowercased() == "https",
              let host = parts.host, !host.isEmpty,
              parts.user == nil, parts.password == nil else { return false }
        return isPublicHost(host)
    }

    private static func validScpURL(_ url: String) -> Bool {
        let body = url.dropFirst("git@".count)
        guard let colon = body.firstIndex(of: ":") else { return false }
        let host = String(body[..<colon])
        let repoPath = String(body[body.index(after: colon)...])
        guard let first = host.unicodeScalars.first, isASCIIAlnum(first),
              host.unicodeScalars.allSatisfy({ isASCIIAlnum($0) || $0 == "." || $0 == "-" }),
              !repoPath.isEmpty,
              repoPath.unicodeScalars.allSatisfy({ isASCIIAlnum($0) || "._~/-".unicodeScalars.contains($0) })
        else { return false }
        return isPublicHost(host) && !repoPath.hasPrefix("-")
            && !repoPath.split(separator: "/").contains("..")
    }

    /// No IP literal (v4, v6, or a numeric/hex last label that a URL parser
    /// turns into one), no localhost, no `.local`.
    private static func isPublicHost(_ raw: String) -> Bool {
        var host = raw.lowercased()
        if host.hasSuffix(".") { host.removeLast() }
        guard !host.isEmpty, !host.hasPrefix("["), !host.contains(":") else { return false }
        if host == "localhost" || host.hasSuffix(".localhost") || host.hasSuffix(".local") { return false }
        let last = host.split(separator: ".").last.map(String.init) ?? host
        if last.allSatisfy(\.isNumber) { return false }
        if last.hasPrefix("0x") && last.dropFirst(2).allSatisfy(\.isHexDigit) { return false }
        return true
    }

    private static func isASCIIAlnum(_ scalar: Unicode.Scalar) -> Bool {
        ("a"..."z").contains(scalar) || ("A"..."Z").contains(scalar) || ("0"..."9").contains(scalar)
    }

    private static func isPrintableASCII(_ text: String) -> Bool {
        text.unicodeScalars.allSatisfy { (0x20...0x7e).contains($0.value) }
    }

    private static func hasUnsafeChars(_ text: String) -> Bool {
        text.unicodeScalars.contains { $0.value < 0x20 || $0.value == 0x7f || $0.properties.isWhitespace }
    }
}
