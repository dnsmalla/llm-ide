import SwiftUI

/// Modal sheet for installing a plugin from a Git URL. Two fields —
/// URL and optional branch/tag. Submission is gated on a basic
/// shape check; the heavier validation happens in
/// `PluginGitInstaller.normalize(_:)` once submit fires.
struct PluginGitInstallSheet: View {
    let onSubmit: (String, String?) -> Void
    let onCancel: () -> Void

    @State private var url: String = ""
    @State private var ref: String = ""
    @FocusState private var urlFocused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Install plugin from Git URL")
                .font(.headline)
            Text("Public HTTPS or git@ URL. The repo is cloned shallowly, packaged, and validated server-side before install.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            VStack(alignment: .leading, spacing: 4) {
                Text("Git URL").font(.callout)
                TextField("https://github.com/owner/repo", text: $url)
                    .textFieldStyle(.roundedBorder)
                    .focused($urlFocused)
                    .onSubmit { submitIfValid() }
            }

            VStack(alignment: .leading, spacing: 4) {
                Text("Branch or tag (optional)").font(.callout)
                TextField("main", text: $ref)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit { submitIfValid() }
            }

            HStack {
                Spacer()
                Button("Cancel", role: .cancel) { onCancel() }
                Button("Install") { submitIfValid() }
                    .buttonStyle(.borderedProminent)
                    .disabled(!isValid)
                    .keyboardShortcut(.defaultAction)
            }
        }
        .padding(20)
        .frame(width: 460)
        .onAppear { urlFocused = true }
    }

    private var isValid: Bool {
        let trimmed = url.trimmingCharacters(in: .whitespacesAndNewlines)
        // Loose check — full validation happens once we hit the
        // installer. We just want to disable the button on empty.
        return trimmed.count >= 8 && (trimmed.contains("://") || trimmed.hasPrefix("git@"))
    }

    private func submitIfValid() {
        guard isValid else { return }
        let trimmedRef = ref.trimmingCharacters(in: .whitespacesAndNewlines)
        onSubmit(url.trimmingCharacters(in: .whitespacesAndNewlines),
                 trimmedRef.isEmpty ? nil : trimmedRef)
    }
}
