import SwiftUI

struct BackendSettingsSection: View {
    @EnvironmentObject var theme: ThemeStore
    @EnvironmentObject var config: AppConfig
    @Environment(BackendManager.self) private var backend

    @State private var nodeDraft: String = ""
    @State private var dirDraft: String = ""
    @State private var autoScroll: Bool = true

    var body: some View {
        SettingsSectionCard(icon: "terminal", title: "Backend") {
            VStack(alignment: .leading, spacing: Spacing.sm) {
                pathRow(
                    label: "Node binary",
                    text: $nodeDraft,
                    placeholder: "/opt/homebrew/bin/node",
                    onPick: pickNode,
                    onDetect: detectNode,
                    detectHint: "Auto-detect"
                )

                pathRow(
                    label: "Project folder",
                    text: $dirDraft,
                    placeholder: "/path/to/llm-ide/extension",
                    onPick: pickDir,
                    onDetect: detectProjectDir,
                    detectHint: "Auto-detect"
                )

                Toggle("Start backend on app launch", isOn: Binding(
                    get: { config.backendAutoStart },
                    set: { config.backendAutoStart = $0 }
                ))
                .font(Typography.body)
                .toggleStyle(.checkbox)

                HStack(spacing: Spacing.sm) {
                    statusPill
                    Spacer()
                    Button("Save paths") { savePaths() }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                        .disabled(!pathsDirty)
                    actionButton
                }

                if let err = backend.lastError, !err.isEmpty {
                    Text(err)
                        .font(Typography.caption)
                        .foregroundStyle(theme.current.danger)
                        .fixedSize(horizontal: false, vertical: true)
                }

                logHeader
                logPane
            }
        }
        .onAppear {
            nodeDraft = config.backendNodePath
            dirDraft = config.backendWorkingDir
            if nodeDraft.isEmpty { detectNode() }
            if dirDraft.isEmpty { detectProjectDir() }
        }
    }

    // MARK: - Rows

    @ViewBuilder
    private func pathRow(
        label: String,
        text: Binding<String>,
        placeholder: String,
        onPick: @escaping () -> Void,
        onDetect: (() -> Void)?,
        detectHint: String?
    ) -> some View {
        HStack(spacing: Spacing.sm) {
            Text(label)
                .font(Typography.body)
                .foregroundStyle(theme.current.textMuted)
                .frame(width: 110, alignment: .leading)
            TextField(placeholder, text: text)
                .textFieldStyle(.roundedBorder)
                .font(Typography.mono)
                .disableAutocorrection(true)
            Button("Browse…") { onPick() }
                .buttonStyle(.bordered)
                .controlSize(.small)
            if let onDetect = onDetect, let hint = detectHint {
                Button(hint) { onDetect() }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
            }
        }
    }

    // MARK: - Status + actions

    private var statusPill: some View {
        let (label, colour) = statusDisplay
        return HStack(spacing: 6) {
            Circle().fill(colour).frame(width: 8, height: 8)
            Text(label)
                .font(Typography.caption)
                .foregroundStyle(theme.current.text)
            if let pid = backend.pid {
                Text("· pid \(pid)")
                    .font(Typography.caption)
                    .foregroundStyle(theme.current.textMuted)
            }
        }
    }

    private var statusDisplay: (String, Color) {
        switch backend.status {
        case .stopped:               return ("Stopped",  theme.current.textMuted)
        case .starting:              return ("Starting", theme.current.accent)
        case .running:               return ("Running",  theme.current.accent3)
        case .crashed(let exitCode): return ("Crashed (exit \(exitCode))", theme.current.danger)
        }
    }

    @ViewBuilder
    private var actionButton: some View {
        switch backend.status {
        case .running, .starting:
            Button("Stop") { backend.stop() }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .tint(theme.current.danger)
        default:
            Button("Start") {
                savePaths()
                backend.start(nodePath: config.backendNodePath,
                              workingDirectory: config.backendWorkingDir)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.small)
            .disabled(nodeDraft.isEmpty || dirDraft.isEmpty)
        }
    }

    // MARK: - Log pane

    private var logHeader: some View {
        HStack {
            Text("Log")
                .font(Typography.caption)
                .foregroundStyle(theme.current.textMuted)
            Text("·")
                .foregroundStyle(theme.current.textMuted)
            Text("\(backend.log.count) lines")
                .font(Typography.caption)
                .foregroundStyle(theme.current.textMuted)
            Spacer()
            Toggle("Auto-scroll", isOn: $autoScroll)
                .toggleStyle(.checkbox)
                .font(Typography.caption)
            Button("Clear") { backend.clearLog() }
                .buttonStyle(.borderless)
                .controlSize(.small)
                .disabled(backend.log.isEmpty)
        }
        .padding(.top, Spacing.xs)
    }

    private var logPane: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 1) {
                    ForEach(backend.log) { line in
                        Text(line.text)
                            .font(.system(size: 11, weight: .regular, design: .monospaced))
                            .foregroundStyle(colour(for: line.stream))
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .id(line.id)
                    }
                }
                .padding(8)
            }
            .frame(height: 220)
            .background(RoundedRectangle(cornerRadius: 6).fill(theme.current.body.opacity(0.6)))
            .overlay(RoundedRectangle(cornerRadius: 6).stroke(theme.current.border.opacity(0.4)))
            .onChange(of: backend.log.count) { _, _ in
                guard autoScroll, let last = backend.log.last else { return }
                withAnimation(.easeOut(duration: 0.1)) {
                    proxy.scrollTo(last.id, anchor: .bottom)
                }
            }
        }
    }

    private func colour(for stream: BackendLogLine.Stream) -> Color {
        switch stream {
        case .stdout: return theme.current.text
        case .stderr: return theme.current.danger
        case .info:   return theme.current.accent
        }
    }

    // MARK: - Path helpers

    private var pathsDirty: Bool {
        nodeDraft != config.backendNodePath || dirDraft != config.backendWorkingDir
    }

    private func savePaths() {
        config.backendNodePath = nodeDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        config.backendWorkingDir = dirDraft.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func pickNode() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.title = "Select the node binary"
        panel.directoryURL = URL(fileURLWithPath: "/usr/local/bin")
        if panel.runModal() == .OK, let url = panel.url { nodeDraft = url.path }
    }

    private func pickDir() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.title = "Select the folder containing server.mjs"
        if panel.runModal() == .OK, let url = panel.url {
            dirDraft = resolveServerDir(url.path)
        }
    }

    /// Accepts whatever the user clicked and walks toward `server.mjs`:
    /// - If `<picked>/server.mjs` exists, use that folder.
    /// - Else if `<picked>/../server.mjs` exists, use the parent (catches
    ///   the common mistake of drilling into `extension/server/`).
    /// - Else if `<picked>/extension/server.mjs` exists, use that subdir
    ///   (catches picking the repo root by mistake).
    /// - Otherwise return the picked path unchanged and let `start()`
    ///   surface the standard error.
    private func resolveServerDir(_ picked: String) -> String {
        let fm = FileManager.default
        let pickedURL = URL(fileURLWithPath: picked)
        if fm.fileExists(atPath: pickedURL.appendingPathComponent("server.mjs").path) {
            return pickedURL.path
        }
        let parent = pickedURL.deletingLastPathComponent()
        if fm.fileExists(atPath: parent.appendingPathComponent("server.mjs").path) {
            backend.lastError = "Picked '\(pickedURL.lastPathComponent)/' — server.mjs lives in the parent. Using \(parent.path)."
            return parent.path
        }
        let childExt = pickedURL.appendingPathComponent("extension")
        if fm.fileExists(atPath: childExt.appendingPathComponent("server.mjs").path) {
            backend.lastError = "Picked the repo root — server.mjs lives in extension/. Using \(childExt.path)."
            return childExt.path
        }
        return pickedURL.path
    }

    private func detectNode() {
        if let p = BackendManager.autoDetectNode() {
            nodeDraft = p
        } else {
            backend.lastError = "Could not find a node binary in /opt/homebrew, /usr/local, or /usr/bin. Paste the full path manually."
        }
    }

    private func detectProjectDir() {
        BackendManager.resolveLaunchPaths(config: config)
        if !config.backendWorkingDir.isEmpty {
            dirDraft = config.backendWorkingDir
        } else if let found = LaunchPathResolver.findServerDirectory() {
            dirDraft = found
        } else {
            backend.lastError = "Could not find server.mjs. Browse to the extension folder or clone llm-ide."
        }
    }
}
