import Foundation

/// Canonical product naming — see `docs/decisions/0016-naming-convention.md`.
enum AppIdentity {
    /// User-visible brand (menus, titles, docs prose).
    static let displayName = "LLM-IDE"
    /// Repo / package / URL slug.
    static let slug = "llm-ide"

    /// Application Support folder (`~/Library/Application Support/llm-ide`).
    static let supportDirName = "llm-ide"
    /// Pre-standardization folder (spaces, no hyphen).
    static let legacySupportDirName = "LLM IDE"

    /// Logs folder (`~/Library/Logs/llm-ide`).
    static let logsDirName = "llm-ide"
    static let legacyLogsDirName = "LLM IDE"

    /// Default notes/documents folder segment (`~/Documents/llm-ide`).
    static let documentsDirName = "llm-ide"
    static let legacyDocumentsDirName = "LLM IDE"

    // MARK: - Resolved paths (migrate legacy dirs on first access)

    static func applicationSupportRoot(
        fileManager: FileManager = .default
    ) -> URL {
        guard let base = fileManager.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        ).first else {
            return URL(fileURLWithPath: NSHomeDirectory())
                .appendingPathComponent("Library/Application Support/\(supportDirName)", isDirectory: true)
        }
        return resolveDirectory(
            named: supportDirName,
            legacyName: legacySupportDirName,
            under: base,
            fileManager: fileManager
        )
    }

    static func logsRoot(fileManager: FileManager = .default) -> URL {
        let base = fileManager.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Logs", isDirectory: true)
        return resolveDirectory(
            named: logsDirName,
            legacyName: legacyLogsDirName,
            under: base,
            fileManager: fileManager
        )
    }

    static func documentsRoot(fileManager: FileManager = .default) -> URL {
        guard let base = fileManager.urls(
            for: .documentDirectory,
            in: .userDomainMask
        ).first else {
            return URL(fileURLWithPath: NSHomeDirectory())
                .appendingPathComponent("Documents/\(documentsDirName)", isDirectory: true)
        }
        return resolveDirectory(
            named: documentsDirName,
            legacyName: legacyDocumentsDirName,
            under: base,
            fileManager: fileManager
        )
    }

    /// Gitignore / README managed-block markers (new projects).
    static let managedBlockOpen = "# >>> LLM-IDE managed"
    static let managedBlockClose = "# <<< LLM-IDE managed"
    /// Older projects may still carry this marker — keep recognizing it.
    static let legacyManagedBlockOpen = "# >>> LLM IDE managed"
    static let legacyManagedBlockClose = "# <<< LLM IDE managed"

    static func isManagedGitignoreBlockPresent(_ content: String) -> Bool {
        content.contains(managedBlockOpen) || content.contains(legacyManagedBlockOpen)
    }

    // MARK: - Private

    private static func resolveDirectory(
        named newName: String,
        legacyName: String,
        under parent: URL,
        fileManager: FileManager
    ) -> URL {
        let newURL = parent.appendingPathComponent(newName, isDirectory: true)
        let legacyURL = parent.appendingPathComponent(legacyName, isDirectory: true)
        if !fileManager.fileExists(atPath: newURL.path),
           fileManager.fileExists(atPath: legacyURL.path) {
            try? fileManager.moveItem(at: legacyURL, to: newURL)
        }
        try? fileManager.createDirectory(at: newURL, withIntermediateDirectories: true)
        return newURL
    }
}
