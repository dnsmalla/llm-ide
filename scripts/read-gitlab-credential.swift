#!/usr/bin/env swift
// Reads the GitLab PAT stored by LLM-IDE (Settings → GitLab / Keychain).
// Used by scripts/gitlab.sh — not for interactive use (prints token to stdout).

import Foundation
import Security

private let service = "com.llmide.macapp"
private let blobAccount = "llmide::secrets::v1"
private let defaultsDomain = "com.llmide.macapp"

private func loadBlob() -> [String: String]? {
    let query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service,
        kSecAttrAccount as String: blobAccount,
        kSecReturnData as String: true,
        kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    guard status == errSecSuccess,
          let data = item as? Data,
          let map = try? JSONDecoder().decode([String: String].self, from: data) else {
        return nil
    }
    return map
}

private func gitLabHost() -> String {
    let proc = Process()
    proc.executableURL = URL(fileURLWithPath: "/usr/bin/defaults")
    proc.arguments = ["read", defaultsDomain, "gitLabBaseURL"]
    let pipe = Pipe()
    proc.standardOutput = pipe
    proc.standardError = FileHandle.nullDevice
    do {
        try proc.run()
        proc.waitUntilExit()
    } catch {
        return "https://gitlab.com"
    }
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    let raw = String(data: data, encoding: .utf8)?
        .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return raw.isEmpty ? "https://gitlab.com" : raw
}

guard let blob = loadBlob() else {
    fputs("GitLab not configured — add a token in LLM-IDE Settings → GitLab.\n", stderr)
    exit(1)
}

let host = gitLabHost()
let key = "gitlab::\(host)::token"
guard let token = blob[key], !token.isEmpty else {
    fputs("GitLab token missing — verify Settings → GitLab → Save & verify.\n", stderr)
    exit(1)
}

// Line 1: host URL, line 2: token (gitlab.sh reads both).
print(host)
print(token)
