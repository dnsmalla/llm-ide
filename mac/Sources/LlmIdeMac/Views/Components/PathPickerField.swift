import SwiftUI
import AppKit

/// A path field scoped to a project root: a text field holding a path
/// relative to `root` when possible, plus a Browse button that opens an
/// `NSOpenPanel` rooted at `root` so a user can pick ANY file or folder in
/// the project — not just items already curated into the Library, which is
/// what Loop's stage Input/Output fields used before this existed.
///
/// The path is a text hint folded into the agent's prompt (see
/// `LoopEngineRunner.composeSkillMessage`) — this view does not read the
/// file itself, so typing a path by hand works exactly like picking one.
struct PathPickerField: View {
    let root: URL?
    @Binding var path: String?
    var placeholder: String = "None"

    var body: some View {
        HStack(spacing: 6) {
            TextField(placeholder, text: Binding(
                get: { path ?? "" },
                set: { path = $0.isEmpty ? nil : $0 }
            ))
            .textFieldStyle(.roundedBorder)
            .font(.system(size: 11, design: .monospaced))
            Button("Browse…") { browse() }
                .controlSize(.small)
        }
    }

    private func browse() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.directoryURL = root
        guard panel.runModal() == .OK, let url = panel.url else { return }
        path = root.map { PathUtils.relative(url.path, to: $0) } ?? url.path
    }
}
