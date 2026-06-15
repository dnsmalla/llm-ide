import Foundation
/// Canonical set of directory names to skip when walking/indexing a repo
/// (VCS, build, cache, generated artifacts). Single source of truth — was
/// previously duplicated/drifted across FileSystemTree, LibraryItemStore,
/// SearchService, and CodeAssistantPanel.
enum IgnoreList {
    static let directories: Set<String> = [
        ".git", "node_modules", ".understand-anything", ".code-notes", ".build",
        "DerivedData", ".swiftpm", "Pods", "build", "dist", ".next", ".venv", "venv",
        ".cache", "__pycache__", ".pytest_cache", "target", "vendor", ".gradle",
        ".idea", ".vscode", ".llmide-auto"
    ]
}
