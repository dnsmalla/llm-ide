import SwiftUI

/// Add an LLM source: a public Git URL (cloned server-side — see
/// extension/llm-sources/registry.mjs's `addSource`) or a local directory
/// already containing `registry.yaml`, `.claude-plugin/plugin.json` +
/// `skills/`, an `agents/` dir, or a hooks manifest. Loose client-side
/// validation only disables the submit button early; the server's
/// `normalizeGitUrl`/`isValidLlmSource` are the real gate, and their
/// rejection message is what the caller (LibraryView) surfaces on failure —
/// this sheet does not duplicate that logic.
struct LlmSourceAddSheet: View {
    let onSubmit: (_ url: String?, _ path: String?, _ ref: String?, _ name: String?) -> Void
    let onCancel: () -> Void

    private enum Kind: String, CaseIterable { case git = "Git URL", local = "Local Path" }
    @State private var kind: Kind = .git
    @State private var url = ""
    @State private var ref = ""
    @State private var path = ""
    @State private var name = ""
    @FocusState private var urlFocused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Add LLM source").font(.headline)
            Picker("", selection: $kind) {
                ForEach(Kind.allCases, id: \.self) { Text($0.rawValue).tag($0) }
            }
            .pickerStyle(.segmented)
            .labelsHidden()

            if kind == .git {
                Text("Public HTTPS URL only. Cloned shallowly on the server.")
                    .font(.caption).foregroundStyle(.secondary)
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
            } else {
                Text("A local directory containing registry.yaml; .claude-plugin/plugin.json + skills/; an agents/ dir; or a hooks manifest.")
                    .font(.caption).foregroundStyle(.secondary)
                HStack {
                    TextField("/path/to/repo", text: $path)
                        .textFieldStyle(.roundedBorder)
                    Button("Choose…") { chooseFolder() }
                }
            }

            VStack(alignment: .leading, spacing: 4) {
                Text("Name (optional)").font(.callout)
                TextField("Display name", text: $name)
                    .textFieldStyle(.roundedBorder)
            }

            HStack {
                Spacer()
                Button("Cancel", role: .cancel) { onCancel() }
                Button("Add") { submitIfValid() }
                    .buttonStyle(.borderedProminent)
                    .disabled(!isValid)
                    .keyboardShortcut(.defaultAction)
            }
        }
        .padding(20)
        .frame(width: 460)
        .onAppear { urlFocused = kind == .git }
    }

    private var isValid: Bool {
        switch kind {
        case .git:
            return url.trimmingCharacters(in: .whitespacesAndNewlines).hasPrefix("https://")
        case .local:
            return !path.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
    }

    private func chooseFolder() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.message = "Choose an LLM source directory"
        panel.prompt = "Choose"
        if panel.runModal() == .OK, let chosen = panel.url {
            path = chosen.path
        }
    }

    private func submitIfValid() {
        guard isValid else { return }
        let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        switch kind {
        case .git:
            let trimmedRef = ref.trimmingCharacters(in: .whitespacesAndNewlines)
            onSubmit(url.trimmingCharacters(in: .whitespacesAndNewlines), nil,
                     trimmedRef.isEmpty ? nil : trimmedRef,
                     trimmedName.isEmpty ? nil : trimmedName)
        case .local:
            onSubmit(nil, path.trimmingCharacters(in: .whitespacesAndNewlines), nil,
                     trimmedName.isEmpty ? nil : trimmedName)
        }
    }
}
