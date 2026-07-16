import SwiftUI
import AppKit

/// Mobile Control settings — supervises the external computer-agent
/// (`npm start` on :3006) with the same start/stop/log UX as Backend.
struct MobileControlSettingsSection: View {
    @EnvironmentObject var config: AppConfig
    @EnvironmentObject var theme: ThemeStore
    @Environment(MobileControlManager.self) private var mobile

    @State private var agentDraft: String = ""
    @State private var autoScroll: Bool = true
    @State private var connection = MobileConnectionInfo.current()

    /// Tracks Screen Recording + Accessibility so the panel can show
    /// granted/needed state and offer one-click "add LLM IDE to the TCC
    /// list" — the computer-agent (screenshot-desktop + nut-js) needs both.
    @StateObject private var permissions = PermissionsService()
    @Environment(\.scenePhase) private var scenePhase

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

                    connectionBlock

                    Divider().padding(.vertical, 4)

                    permissionsBlock

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
            connection = MobileConnectionInfo.current()
            agentDraft = config.mobileControlAgentPath
            if agentDraft.isEmpty { detectAgentPath() }
            permissions.refreshAll()
            if config.mobileControlEnabled { permissions.startPolling() }
        }
        .onDisappear {
            permissions.stopPolling()
        }
        .onChange(of: config.mobileControlEnabled) { _, enabled in
            // Auto-add: toggling Mobile Control on fires the macOS prompts
            // that add LLM IDE to the Screen Recording + Accessibility
            // lists, so the user doesn't hunt through System Settings.
            if enabled {
                permissions.startPolling()
                autoPromptPermissionsIfNeeded()
            } else {
                permissions.stopPolling()
            }
        }
        .onChange(of: scenePhase) { _, phase in
            // The user likely just connected Tailscale in another app;
            // re-probe when we regain focus so the IP shows without Refresh.
            if phase == .active { connection = MobileConnectionInfo.current() }
        }
    }

    /// Refresh permission state and fire the macOS prompts for anything not
    /// yet granted — auto-adds LLM IDE to the relevant TCC lists. No-op for
    /// already-granted permissions.
    private func autoPromptPermissionsIfNeeded() {
        permissions.refreshAll()
        if permissions.accessibility != .granted { permissions.promptAccessibility() }
        if permissions.screenRecording != .granted { permissions.promptScreenRecording() }
    }

    // MARK: - Connection info

    /// The IP / Port / PIN the iPhone app needs for Direct-IP connect.
    /// Surfaces the Tailscale address first (works from any network) and the
    /// local Wi-Fi address as a fallback (same-network only). Re-detect on
    /// appear or via Refresh — the addresses move with the network.
    private var connectionBlock: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            HStack {
                Text("Connection")
                    .font(Typography.section)
                    .foregroundStyle(theme.current.textMuted)
                Spacer()
                Button {
                    connection = MobileConnectionInfo.current()
                } label: {
                    Label("Refresh", systemImage: "arrow.clockwise")
                        .font(Typography.caption)
                }
                .buttonStyle(.borderless)
                .controlSize(.small)
            }

            tailscaleRow
            copyableRow(label: "Local Wi-Fi", value: connection.lanIP, hint: "same network")
            copyableRow(label: "Port", value: "\(connection.port)")
            copyableRow(label: "PIN", value: connection.pin)

            Text("Enter these in the iOS app → Direct IP connect. Prefer the Tailscale address — it works across Wi-Fi and cellular.")
                .font(Typography.caption)
                .foregroundStyle(theme.current.textMuted)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(8)
        .background(RoundedRectangle(cornerRadius: 6).fill(theme.current.body.opacity(0.6)))
        .overlay(RoundedRectangle(cornerRadius: 6).stroke(theme.current.border.opacity(0.4)))
    }

    @ViewBuilder
    private func copyableRow(label: String, value: String?, hint: String? = nil, prominent: Bool = false) -> some View {
        HStack(spacing: Spacing.sm) {
            Text(label)
                .font(Typography.body)
                .foregroundStyle(theme.current.textMuted)
                .frame(width: 110, alignment: .leading)
            if let value, !value.isEmpty {
                Text(value)
                    .font(Typography.mono)
                    .foregroundStyle(prominent ? theme.current.accent3 : theme.current.text)
                    .textSelection(.enabled)
                if let hint {
                    Text(hint)
                        .font(Typography.caption)
                        .foregroundStyle(theme.current.textMuted)
                }
                Spacer()
                Button {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(value, forType: .string)
                } label: {
                    Image(systemName: "doc.on.doc")
                        .font(.system(size: 12))
                        .foregroundStyle(theme.current.textMuted)
                }
                .buttonStyle(.borderless)
                .help("Copy \(label)")
            } else {
                Text("—")
                    .font(Typography.mono)
                    .foregroundStyle(theme.current.textMuted)
                Spacer()
            }
        }
    }

    // MARK: - Tailscale row

    /// Adaptive: shows the Tailscale IP when connected, an "Open Tailscale"
    /// affordance when the app is installed but stopped, or an install hint
    /// when Tailscale isn't present. Avoids the bare "—" that made a healthy
    /// "not connected" state look broken.
    @ViewBuilder
    private var tailscaleRow: some View {
        if let ip = connection.tailscaleIP, !ip.isEmpty {
            copyableRow(label: "Tailscale", value: ip, hint: "any network", prominent: true)
        } else if LocalIPs.tailscaleAppURL() != nil {
            HStack(spacing: Spacing.sm) {
                Text("Tailscale")
                    .font(Typography.body)
                    .foregroundStyle(theme.current.textMuted)
                    .frame(width: 110, alignment: .leading)
                Text("Not connected")
                    .font(Typography.mono)
                    .foregroundStyle(theme.current.danger)
                Spacer()
                Button("Open Tailscale") {
                    if let url = LocalIPs.tailscaleAppURL() {
                        NSWorkspace.shared.open(url)
                    }
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .help("Launch Tailscale, sign in / connect, then return here")
            }
        } else {
            HStack(spacing: Spacing.sm) {
                Text("Tailscale")
                    .font(Typography.body)
                    .foregroundStyle(theme.current.textMuted)
                    .frame(width: 110, alignment: .leading)
                Text("Not installed")
                    .font(Typography.mono)
                    .foregroundStyle(theme.current.textMuted)
                Spacer()
                Link("Install…", destination: URL(string: "https://tailscale.com/download/mac")!)
                    .font(Typography.caption)
            }
        }
    }

    // MARK: - Permissions block

    /// Screen Recording + Accessibility status with one-click "add LLM IDE
    /// to the TCC list". The computer-agent can't stream the screen or inject
    /// input without these. Non-blocking — chat still works without them.
    private var permissionsBlock: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            Text("macOS Permissions")
                .font(Typography.section)
                .foregroundStyle(theme.current.textMuted)

            permissionRow(
                title: "Screen Recording",
                detail: "Lets the agent stream your screen to the iPhone.",
                state: permissions.screenRecording,
                enable: { permissions.promptScreenRecording() },
                pane: .screenRecording
            )
            permissionRow(
                title: "Accessibility",
                detail: "Lets the agent inject mouse + keyboard for remote control.",
                state: permissions.accessibility,
                enable: { permissions.promptAccessibility() },
                pane: .accessibility
            )

            Text("Grant these to LLM IDE. If you run the agent from your own terminal instead, that terminal needs the grant — then quit and relaunch the app.")
                .font(Typography.caption)
                .foregroundStyle(theme.current.textMuted)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(8)
        .background(RoundedRectangle(cornerRadius: 6).fill(theme.current.body.opacity(0.6)))
        .overlay(RoundedRectangle(cornerRadius: 6).stroke(theme.current.border.opacity(0.4)))
    }

    @ViewBuilder
    private func permissionRow(
        title: String,
        detail: String,
        state: PermissionsService.State,
        enable: @escaping () -> Void,
        pane: PermissionsService.SettingsPane
    ) -> some View {
        HStack(spacing: Spacing.sm) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(title).font(Typography.body).foregroundStyle(theme.current.text)
                    permStatusPill(state)
                }
                Text(detail)
                    .font(Typography.caption)
                    .foregroundStyle(theme.current.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer()
            if state != .granted {
                Button("Enable") { enable() }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
                    .help("Add LLM IDE to this list, then toggle it on in System Settings")
            }
            Button("Open Settings") { permissions.openSystemSettings(pane: pane) }
                .buttonStyle(.bordered)
                .controlSize(.small)
        }
    }

    @ViewBuilder
    private func permStatusPill(_ state: PermissionsService.State) -> some View {
        let (label, fg, bg): (String, Color, Color) = {
            switch state {
            case .granted: return ("granted",
                                   theme.current.accent3,
                                   theme.current.accent3.opacity(theme.current.isDark ? 0.20 : 0.12))
            case .denied:  return ("needed",
                                   theme.current.danger,
                                   theme.current.danger.opacity(theme.current.isDark ? 0.20 : 0.12))
            case .unknown: return ("unknown",
                                   theme.current.textMuted,
                                   theme.current.textMuted.opacity(theme.current.isDark ? 0.18 : 0.10))
            }
        }()
        Text(label)
            .font(Typography.captionStrong)
            .foregroundStyle(fg)
            .padding(.horizontal, Spacing.sm)
            .padding(.vertical, 2)
            .background(bg)
            .clipShape(Capsule())
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
                autoPromptPermissionsIfNeeded()
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
