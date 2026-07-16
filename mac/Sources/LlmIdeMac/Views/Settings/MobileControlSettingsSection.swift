import SwiftUI

/// Mobile Control settings — supervises the external computer-agent
/// (`npm start` on :3006) with the same start/stop/log UX as Backend.
struct MobileControlSettingsSection: View {
    @EnvironmentObject var config: AppConfig
    @EnvironmentObject var theme: ThemeStore
    @Environment(MobileControlManager.self) private var mobile

    @State private var agentDraft: String = ""
    @State private var autoScroll: Bool = true

    private let iosAppPath = "~/Desktop/auto_sys/swift_apps/auto_swift_aicontrol/apps/ios"

    var body: some View {
        SettingsSectionCard(icon: "iphone", title: "Mobile Control") {
            VStack(alignment: .leading, spacing: Spacing.sm) {

                Toggle(isOn: $config.mobileControlEnabled) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Enable Mobile Control")
                            .font(Typography.body)
                            .foregroundStyle(theme.current.text)
                        Text("iPhone remote desktop + LLM IDE chat via computer agent (:3006)")
                            .font(Typography.caption)
                            .foregroundStyle(theme.current.textMuted)
                    }
                }
                .toggleStyle(.switch)

                if config.mobileControlEnabled {
                    Divider().padding(.vertical, 4)

                    pathRow(
                        label: "Agent folder",
                        text: $agentDraft,
                        placeholder: "~/Desktop/.../computer-agent",
                        onPick: pickAgentDir,
                        onDetect: detectAgentPath
                    )

                    Toggle("Start computer agent on app launch", isOn: Binding(
                        get: { config.mobileControlAutoStart },
                        set: { config.mobileControlAutoStart = $0 }
                    ))
                    .font(Typography.body)
                    .toggleStyle(.checkbox)

                    HStack(spacing: Spacing.sm) {
                        statusPill
                        Spacer()
                        Button("Save path") { savePath() }
                            .buttonStyle(.bordered)
                            .controlSize(.small)
                            .disabled(!pathDirty)
                        actionButton
                    }

                    if let err = mobile.lastError, !err.isEmpty {
                        Text(err)
                            .font(Typography.caption)
                            .foregroundStyle(theme.current.danger)
                            .fixedSize(horizontal: false, vertical: true)
                    }

                    logHeader
                    logPane

                    Divider().padding(.vertical, 4)

                    iosHint
                    featuresBlock
                }
            }
        }
        .onAppear {
            agentDraft = config.mobileControlAgentPath
            if agentDraft.isEmpty { detectAgentPath() }
        }
    }

    // MARK: - Path row

    @ViewBuilder
    private func pathRow(
        label: String,
        text: Binding<String>,
        placeholder: String,
        onPick: @escaping () -> Void,
        onDetect: @escaping () -> Void
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
            Button("Auto-detect") { onDetect() }
                .buttonStyle(.bordered)
                .controlSize(.small)
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
            if let pid = mobile.pid {
                Text("· pid \(pid)")
                    .font(Typography.caption)
                    .foregroundStyle(theme.current.textMuted)
            }
        }
    }

    private var statusDisplay: (String, Color) {
        switch mobile.status {
        case .stopped:               return ("Stopped",  theme.current.textMuted)
        case .starting:              return ("Starting", theme.current.accent)
        case .running:                 return ("Running",  theme.current.accent3)
        case .crashed(let exitCode):   return ("Crashed (exit \(exitCode))", theme.current.danger)
        }
    }

    @ViewBuilder
    private var actionButton: some View {
        switch mobile.status {
        case .running, .starting:
            Button("Stop") { mobile.stopIfOwned() }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .tint(theme.current.danger)
        default:
            Button("Start") {
                savePath()
                mobile.start(agentPath: config.mobileControlAgentPath)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.small)
            .disabled(agentDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
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
            Text("\(mobile.logLines.count) lines")
                .font(Typography.caption)
                .foregroundStyle(theme.current.textMuted)
            Spacer()
            Toggle("Auto-scroll", isOn: $autoScroll)
                .toggleStyle(.checkbox)
                .font(Typography.caption)
            Button("Clear") { mobile.clearLog() }
                .buttonStyle(.borderless)
                .controlSize(.small)
                .disabled(mobile.logLines.isEmpty)
        }
        .padding(.top, Spacing.xs)
    }

    private var logPane: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 1) {
                    ForEach(mobile.logLines) { line in
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
            .frame(height: 180)
            .background(RoundedRectangle(cornerRadius: 6).fill(theme.current.body.opacity(0.6)))
            .overlay(RoundedRectangle(cornerRadius: 6).stroke(theme.current.border.opacity(0.4)))
            .onChange(of: mobile.logLines.count) { _, _ in
                guard autoScroll, let last = mobile.logLines.last else { return }
                withAnimation(.easeOut(duration: 0.1)) {
                    proxy.scrollTo(last.id, anchor: .bottom)
                }
            }
        }
    }

    private func colour(for stream: MobileLogLine.Stream) -> Color {
        switch stream {
        case .stdout: return theme.current.text
        case .stderr: return theme.current.danger
        case .info:   return theme.current.accent
        }
    }

    // MARK: - iOS + features

    private var iosHint: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("iOS app")
                .font(Typography.section)
                .foregroundStyle(theme.current.textMuted)
            Text("open \(iosAppPath)/MyApp.xcodeproj — run on iPhone (same Wi-Fi), connect with PIN or QR")
                .font(Typography.caption)
                .foregroundStyle(theme.current.textMuted)
                .textSelection(.enabled)
        }
    }

    private var featuresBlock: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("Features")
                .font(Typography.section)
                .foregroundStyle(theme.current.textMuted)
            featureRow(icon: "app.dashed", title: "Remote Desktop", subtitle: "Screen streaming + touch control")
            featureRow(icon: "bubble.left.and.bubble.right", title: "LLM IDE Chat", subtitle: "Ask questions from iPhone")
            featureRow(icon: "person.2", title: "Meeting Agent", subtitle: "AI co-pilot during calls")
        }
    }

    @ViewBuilder
    private func featureRow(icon: String, title: String, subtitle: String) -> some View {
        HStack(spacing: 10) {
            Image(systemName: icon)
                .font(.system(size: 12))
                .foregroundStyle(theme.current.accent)
                .frame(width: 20)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(Typography.body).foregroundStyle(theme.current.text)
                Text(subtitle).font(Typography.caption).foregroundStyle(theme.current.textMuted)
            }
            Spacer()
        }
        .padding(.horizontal, 4)
        .padding(.vertical, 2)
    }

    // MARK: - Path helpers

    private var pathDirty: Bool {
        agentDraft != config.mobileControlAgentPath
    }

    private func savePath() {
        config.mobileControlAgentPath = agentDraft.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func pickAgentDir() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.title = "Select the computer-agent folder"
        if panel.runModal() == .OK, let url = panel.url {
            agentDraft = url.path
        }
    }

    private func detectAgentPath() {
        LaunchPathResolver.resolveMobileAgentPath(config: config)
        if !config.mobileControlAgentPath.isEmpty {
            agentDraft = config.mobileControlAgentPath
        } else {
            mobile.lastError = "Computer agent not found at the default location. Browse to the folder containing package.json."
        }
    }
}
