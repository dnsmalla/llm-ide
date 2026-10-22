import Foundation

// Bridges Library's connector manifests into the Core `SourceFolderMigration`,
// which only knows the two folder-name fields it needs. The manifest type is
// Library-owned connector metadata, so Core cannot name it; Shell calls
// `ConnectorFolder.bundled()` when it builds `AppEnvironment`.

extension SourceFolderMigration.ConnectorFolder {
    init(_ manifest: SourceConnectorManifest) {
        self.init(inboxFolder: manifest.inboxFolder, noteType: manifest.noteType)
    }

    /// The bundled connectors' legacy-folder mapping, as `AppEnvironment` needs it.
    static func bundled() -> [Self] {
        SourceConnectorManifest.loadBundled().map(Self.init)
    }
}

extension SourceFolderMigration {
    /// Manifest-shaped convenience over `run(in:connectorFolders:)`, kept so
    /// callers holding manifests (tests, connector code) need not map them.
    @MainActor
    static func run(in sourceRoot: URL, connectors: [SourceConnectorManifest]) {
        run(in: sourceRoot, connectorFolders: connectors.map(ConnectorFolder.init))
    }
}
