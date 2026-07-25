import SwiftUI
import AppKit
import CoreImage

/// Mobile Control settings — runs the native WebSocket server + Bonjour
/// advertiser (:3006) the iPhone app discovers and pairs with, with the same
/// start/stop/log UX as Backend.
struct MobileControlSettingsSection: View {
    @EnvironmentObject var config: AppConfig
    @EnvironmentObject var theme: ThemeStore
    @Environment(MobileControlManager.self) private var mobile

    @State private var autoScroll: Bool = true
    @State private var connection = MobileConnectionInfo.current()

    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        SettingsSectionCard(icon: "iphone", title: "Mobile Control") {
            VStack(alignment: .leading, spacing: Spacing.sm) {

                Toggle(isOn: $config.mobileControlEnabled) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Enable Mobile Control")
                            .font(Typography.body)
                            .foregroundStyle(theme.current.text)
                        Text("iPhone companion: chat, explorer, and auto-tasks via native server (:3006)")
                            .font(Typography.caption)
                            .foregroundStyle(theme.current.textMuted)
                    }
                }
                .toggleStyle(.switch)

                if config.mobileControlEnabled {
                    Divider().padding(.vertical, 4)

                    if case .running = mobile.status {
                        connectionBlock
                    } else {
                        notReadyBlock
                    }

                    Divider().padding(.vertical, 4)

                    Toggle("Start Mobile Control on app launch", isOn: Binding(
                        get: { config.mobileControlAutoStart },
                        set: { config.mobileControlAutoStart = $0 }
                    ))
                    .font(Typography.body)
                    .toggleStyle(.checkbox)

                    HStack(spacing: Spacing.sm) {
                        statusPill
                        Spacer()
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

                    featuresBlock
                }
            }
        }
        .onAppear {
            connection = MobileConnectionInfo.current()
        }
        .onChange(of: scenePhase) { _, phase in
            // The user likely just connected Tailscale in another app;
            // re-probe when we regain focus so the IP shows without Refresh.
            if phase == .active { connection = MobileConnectionInfo.current() }
        }
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

            Text("Enter these in the iOS app → Direct IP connect, or scan the QR below. Prefer the Tailscale address — it works across Wi-Fi and cellular.")
                .font(Typography.caption)
                .foregroundStyle(theme.current.textMuted)
                .fixedSize(horizontal: false, vertical: true)

            qrBlock
        }
        .padding(8)
        .background(RoundedRectangle(cornerRadius: 6).fill(theme.current.body.opacity(0.6)))
        .overlay(RoundedRectangle(cornerRadius: 6).stroke(theme.current.border.opacity(0.4)))
    }

    /// Shown in place of `connectionBlock` when the native server isn't
    /// running. Prevents the old failure mode where IP/Port/PIN/QR stayed
    /// visible after a bind failure (e.g. port :3006 already taken) — the user
    /// and misread the failure as "wrong PIN". The detailed reason, when there
    /// is one, is surfaced by `lastError` below; this block just steers the
    /// user to Start. The status pill + Start/Stop button remain visible in
    /// every state so the user can always recover.
    private var notReadyBlock: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            Text("Pairing info unavailable")
                .font(Typography.section)
                .foregroundStyle(theme.current.textMuted)
            Text(hintForNotRunning)
                .font(Typography.caption)
                .foregroundStyle(theme.current.textMuted)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(8)
        .background(RoundedRectangle(cornerRadius: 6).fill(theme.current.body.opacity(0.6)))
        .overlay(RoundedRectangle(cornerRadius: 6).stroke(theme.current.border.opacity(0.4)))
    }

    /// One-line, state-specific hint for `notReadyBlock`. The `.running` case
    /// is unreachable in practice (`notReadyBlock` is only rendered when not
    /// running) but required for exhaustiveness.
    private var hintForNotRunning: String {
        switch mobile.status {
        case .crashed:
            return "The mobile server isn't running. If port \(MobileControlManager.defaultAgentPort) is already in use, run `lsof -i :3006`, quit the other process, then press Start."
        case .starting:
            return "Starting the mobile server — pairing details will appear here once it's ready."
        case .stopped:
            return "Press Start to launch the mobile server and reveal the pairing IP, port, and PIN."
        case .running:
            return ""
        }
    }

    // MARK: - Pairing QR

    /// Renders the pairing QR (`llmide://pair?ip=…&port=…&pin=…`) from the
    /// current connection snapshot, so the iPhone app can scan instead of
    /// typing. nil when no LAN/Tailscale address is available.
    private var qrBlock: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            Text("Pairing QR")
                .font(Typography.section)
                .foregroundStyle(theme.current.textMuted)
            if let payload = connection.qrPayload, let image = qrImage(for: payload) {
                HStack(alignment: .center, spacing: Spacing.md) {
                    Image(nsImage: image)
                        .interpolation(.none)
                        .resizable()
                        .scaledToFit()
                        .frame(width: 200, height: 200)
                    Text("Scan with the iPhone app to auto-fill the address, port, and PIN.")
                        .font(Typography.caption)
                        .foregroundStyle(theme.current.textMuted)
                        .fixedSize(horizontal: false, vertical: true)
                }
            } else {
                Text("Connect to Wi-Fi or Tailscale to generate a pairing QR.")
                    .font(Typography.caption)
                    .foregroundStyle(theme.current.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
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

    // MARK: - Status + actions

    private var statusPill: some View {
        let (label, colour) = statusDisplay
        return HStack(spacing: 6) {
            Circle().fill(colour).frame(width: 8, height: 8)
            Text(label)
                .font(Typography.caption)
                .foregroundStyle(theme.current.text)
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
            Button("Stop") { mobile.stop() }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .tint(theme.current.danger)
        default:
            Button("Start") { mobile.start() }
            .buttonStyle(.borderedProminent)
            .controlSize(.small)
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

    // MARK: - Features

    private var featuresBlock: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("Features")
                .font(Typography.section)
                .foregroundStyle(theme.current.textMuted)
            featureRow(icon: "bubble.left.and.bubble.right", title: "LLM-IDE Chat", subtitle: "Ask questions from iPhone")
            featureRow(icon: "safari", title: "Explorer", subtitle: "Browse and chat with Mac explorer sessions")
            featureRow(icon: "bolt.fill", title: "Auto Tasks", subtitle: "Toggle and inspect scheduled auto-code tasks")
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
}

// MARK: - QR helper

/// Renders a string as an `NSImage` QR code via CoreImage. Used by the Mobile
/// settings panel to show a pairing QR for `MobileConnectionInfo.qrPayload`.
private func qrImage(for string: String) -> NSImage? {
    guard let filter = CIFilter(name: "CIQRCodeGenerator") else { return nil }
    filter.setValue(string.data(using: .utf8), forKey: "inputMessage")
    filter.setValue("M", forKey: "inputCorrectionLevel")
    guard let ciImage = filter.outputImage else { return nil }
    // CoreImage renders the QR at ~1px per module; scale up so it scans cleanly.
    let scale = 8.0
    let scaled = ciImage.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
    let rep = NSCIImageRep(ciImage: scaled)
    let nsImage = NSImage(size: rep.size)
    nsImage.addRepresentation(rep)
    return nsImage
}
