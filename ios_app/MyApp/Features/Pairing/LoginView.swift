import SwiftUI
import SharedProtocol

/// Entry screen: pair with the desktop by scanning its Host API pairing QR (the only way this iPhone
/// learns the desktop's certificate pin), or enroll offline sync with a sync QR. A PIN typed by hand
/// re-pairs a desktop this iPhone already pinned from a QR.
struct ConnectView: View {
    @EnvironmentObject var syncStore: SyncStore
    @EnvironmentObject var connectionStore: ConnectionStore
    @EnvironmentObject var connection: ConnectionService

    @State private var ip: String  = ""
    @State private var pin: String = ""
    @State private var showManual: Bool = false
    @State private var showScanner: Bool = false
    @State private var errorMessage: String?
    @State private var connectAttempted: Bool = false
    @AppStorage("llmide.demo") private var demo = false

    private var isConnecting: Bool { connection.connectionStatus == .connecting }

    var body: some View {
        ScrollView {
            VStack(spacing: DesignSystem.Spacing.xl) {
                header
                Button {
                    demo = true
                } label: {
                    Label("Explore demo", systemImage: "sparkles")
                        .font(DesignSystem.Typography.headlineFont)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 12)
                }
                .buttonStyle(.bordered)
                .accessibilityIdentifier("explore-demo")
                Text("Sample data only. No desktop, account or network connection is needed.")
                    .font(DesignSystem.Typography.captionFont)
                    .foregroundColor(DesignSystem.Colors.textSecondary)
                    .multilineTextAlignment(.center)
                if connection.requiresRepair {
                    VStack(alignment: .leading, spacing: DesignSystem.Spacing.sm) {
                        Label("Pairing expired or removed", systemImage: "person.badge.key")
                            .font(DesignSystem.Typography.subheadlineFont.weight(.semibold))
                            .foregroundColor(DesignSystem.Colors.textPrimary)
                        Text(HostApiNegotiation.rePairMessage)
                            .font(DesignSystem.Typography.footnoteFont)
                            .foregroundColor(DesignSystem.Colors.textSecondary)
                            .fixedSize(horizontal: false, vertical: true)
                        HStack(spacing: DesignSystem.Spacing.sm) {
                            Button("Scan pairing QR") { showScanner = true }
                                .buttonStyle(.borderedProminent)
                            Button("Enter PIN") { withAnimation { showManual = true } }
                                .buttonStyle(.bordered)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(DesignSystem.Spacing.md)
                    .background(DesignSystem.Colors.primary.opacity(0.08))
                    .cornerRadius(DesignSystem.Layout.cornerRadiusM)
                }
                if let err = errorMessage, !connection.requiresRepair {
                    HStack(spacing: 6) {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .foregroundColor(DesignSystem.Colors.danger)
                        Text(err)
                            .font(DesignSystem.Typography.footnoteFont)
                            .foregroundColor(DesignSystem.Colors.danger)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(DesignSystem.Spacing.md)
                    .background(DesignSystem.Colors.danger.opacity(0.08))
                    .cornerRadius(DesignSystem.Layout.cornerRadiusM)
                }
                Button {
                    withAnimation { showManual.toggle() }
                } label: {
                    Text(showManual ? "Hide manual entry" : "Enter a PIN manually")
                        .font(DesignSystem.Typography.footnoteFont)
                        .foregroundColor(DesignSystem.Colors.primary)
                }
                .frame(maxWidth: .infinity, alignment: .trailing)
                if showManual {
                    manualSection
                }
            }
            .padding(DesignSystem.Layout.marginMobile)
        }
        .background(DesignSystem.Colors.background)
        .navigationTitle("LLM-IDE")
        .navigationBarTitleDisplayMode(.large)
        .onAppear {
            ip  = connectionStore.deviceIP
            pin = connectionStore.devicePIN
            // Carry over a failure that happened while another view was up — an `auth_failed` clears the
            // saved credentials, which remounts this view, so its own onChange can never observe that.
            if let pending = connection.errorMessage { errorMessage = pending }
        }
        // Observe the MESSAGE, not only the status: the service sets .disconnected and then .connecting
        // within one MainActor turn while auto-retrying, so SwiftUI coalesces them.
        .onChange(of: connection.errorMessage) { message in
            if let message, !message.isEmpty {
                errorMessage = message
                connectAttempted = false
            }
        }
        .onChange(of: connection.connectionStatus) { status in
            switch status {
            case .disconnected where connectAttempted:
                errorMessage = connection.errorMessage
                    ?? "Could not reach the desktop. Check it's on the same network (or Tailscale) and LLM-IDE is running."
                connectAttempted = false
            case .connected:
                errorMessage = nil
                connectAttempted = false
            default:
                break
            }
        }
    }

    // MARK: — Subviews

    private var header: some View {
        VStack(spacing: DesignSystem.Spacing.sm) {
            ZStack {
                Circle()
                    .fill(DesignSystem.Colors.primary.opacity(0.12))
                    .frame(width: 80, height: 80)
                Image(systemName: "desktopcomputer")
                    .font(.system(size: 36))
                    .foregroundColor(DesignSystem.Colors.primary)
            }
            Text("Connect to Your Desktop")
                .font(DesignSystem.Typography.titleFont.weight(.bold))
                .foregroundColor(DesignSystem.Colors.textPrimary)
            Text("On the desktop, open LLM-IDE → Settings → Phone and browser → Live Chat pairing, and scan its QR. An Offline sync code only adds read-only history.")
                .font(DesignSystem.Typography.bodyFont)
                .foregroundColor(DesignSystem.Colors.textSecondary)
                .multilineTextAlignment(.center)

            Button {
                showScanner = true
            } label: {
                HStack(spacing: DesignSystem.Spacing.xs) {
                    Image(systemName: "qrcode.viewfinder")
                        .font(.system(size: 18))
                    Text("Scan QR Code")
                        .font(DesignSystem.Typography.bodyFont.weight(.semibold))
                }
                .foregroundColor(.white)
                .padding(.horizontal, DesignSystem.Spacing.lg)
                .padding(.vertical, DesignSystem.Spacing.sm)
                .background(DesignSystem.Colors.primary)
                .cornerRadius(DesignSystem.Layout.cornerRadiusM)
            }
            .padding(.top, DesignSystem.Spacing.xs)
        }
        .padding(.top, DesignSystem.Spacing.lg)
        .sheet(isPresented: $showScanner) {
            QRScannerSheet { scan in
                if let info = scan.desktop {
                    errorMessage = nil
                    connectAttempted = true
                    connectionStore.save(ip: info.ip, pin: info.pin, hostApiOffer: info.hostApiOffer, source: .qrScan, addresses: info.addresses)
                    connection.connect(ip: info.ip, pin: info.pin)
                }
                if let pair = scan.sync { syncStore.startEnrollment(pair) }
            }
        }
    }

    private var manualSection: some View {
        VStack(spacing: DesignSystem.Spacing.lg) {
            Text("Re-pair a desktop this iPhone already scanned")
                .font(DesignSystem.Typography.subheadlineFont.weight(.semibold))
                .foregroundColor(DesignSystem.Colors.textPrimary)
                .frame(maxWidth: .infinity, alignment: .leading)

            inputField(label: "IP Address", placeholder: "192.168.0.100",
                       text: $ip, keyboard: .numbersAndPunctuation)
            inputField(label: "PIN", placeholder: "123456",
                       text: $pin, keyboard: .numberPad, isSecure: true)

            Button {
                let host = ip.trimmingCharacters(in: .whitespaces)
                let code = pin.trimmingCharacters(in: .whitespaces)
                // Same validation as a scanned code — a typo'd host would otherwise be saved and retried forever.
                guard PairingInfo.isPrivateHost(host) else {
                    errorMessage = "Enter the desktop's local address (e.g. 192.168.0.100, a 100.x Tailscale address, or name.local)."
                    return
                }
                guard PairingInfo.isWellFormedPin(code) else {
                    errorMessage = "The PIN is the 6 digits shown in the desktop's Settings → Phone and browser → Live Chat pairing."
                    return
                }
                errorMessage = nil
                connectAttempted = true
                // A typed PIN keeps this host's pin from an earlier QR scan; with none, connect asks for the QR.
                connectionStore.save(ip: host, pin: code, source: .typedPin)
                connection.connect(ip: host, pin: code)
            } label: {
                HStack(spacing: DesignSystem.Spacing.sm) {
                    if isConnecting { ProgressView().tint(.white).scaleEffect(0.85) }
                    Text(isConnecting ? "Connecting…" : "Connect")
                        .font(DesignSystem.Typography.bodyFont.weight(.semibold))
                }
                .frame(maxWidth: .infinity)
                .padding(DesignSystem.Spacing.md)
                .background(!ip.isEmpty && !pin.isEmpty && !isConnecting
                    ? DesignSystem.Colors.primary
                    : DesignSystem.Colors.primary.opacity(0.4))
                .foregroundColor(.white)
                .cornerRadius(DesignSystem.Layout.cornerRadiusM)
            }
            .disabled(ip.isEmpty || pin.isEmpty || isConnecting)
        }
        .padding(DesignSystem.Spacing.lg)
        .background(DesignSystem.Colors.surface)
        .cornerRadius(DesignSystem.Layout.cornerRadiusL)
    }

    @ViewBuilder
    private func inputField(label: String, placeholder: String,
                            text: Binding<String>, keyboard: UIKeyboardType,
                            isSecure: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: DesignSystem.Spacing.xs) {
            Text(label)
                .font(DesignSystem.Typography.subheadlineFont.weight(.medium))
                .foregroundColor(DesignSystem.Colors.textPrimary)
            Group {
                if isSecure {
                    SecureField(placeholder, text: text)
                } else {
                    TextField(placeholder, text: text)
                        .keyboardType(keyboard)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                }
            }
            .padding(DesignSystem.Spacing.md)
            .background(DesignSystem.Colors.background)
            .cornerRadius(DesignSystem.Layout.cornerRadiusM)
            .overlay(RoundedRectangle(cornerRadius: DesignSystem.Layout.cornerRadiusM)
                .stroke(DesignSystem.Colors.primary.opacity(0.2), lineWidth: 1))
        }
    }
}

// MARK: — Reviewer demo

/// Local, offline sample data so an App Review reviewer can evaluate the app without a desktop.
/// Nothing here connects to the network, reads the Keychain or represents real user data.
struct DemoRootView: View {
    /// The demo switch lives in `ContentView` (`llmide.demo`); this view only asks to leave.
    let onExit: () -> Void
    @State private var tab = 0

    var body: some View {
        TabView(selection: $tab) {
            DemoChatView()
                .tabItem { Label("Chat", systemImage: "bubble.left.and.bubble.right.fill") }
                .tag(0)
            DemoHistoryView()
                .tabItem { Label("History", systemImage: "clock.arrow.circlepath") }
                .tag(1)
            DemoSettingsView(onExit: onExit)
                .tabItem { Label("Settings", systemImage: "gearshape.fill") }
                .tag(2)
        }
        .tint(DesignSystem.Colors.primary)
        .overlay(alignment: .top) {
            Text("Demo data · no desktop or network connection")
                .font(DesignSystem.Typography.captionFont.weight(.semibold))
                .foregroundColor(DesignSystem.Colors.textSecondary)
                .padding(.horizontal, 12).padding(.vertical, 6)
                .background(DesignSystem.Colors.background.opacity(0.95))
                .clipShape(Capsule())
                .padding(.top, 6)
                .accessibilityIdentifier("demo-banner")
        }
    }
}

private struct DemoChatView: View {
    @State private var draft = ""
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: DesignSystem.Spacing.lg) {
                    HStack(spacing: 6) {
                        Image(systemName: "desktopcomputer")
                        Text("Alex's MacBook Pro · Demo")
                    }
                    .font(DesignSystem.Typography.captionFont.weight(.medium))
                    .foregroundColor(DesignSystem.Colors.textSecondary)

                    ChatBubble(message: ChatMessage(role: .user, text: "Summarise the release risks and suggest the next step."))
                    ChatBubble(message: ChatMessage(role: .assistant, text: """
                    The main risk is the migration running before the backup is verified.

                    **Suggested next step:** verify the latest encrypted backup, then run the migration on staging.
                    """))

                    VStack(alignment: .leading, spacing: DesignSystem.Spacing.sm) {
                        Label("Approval waiting", systemImage: "hand.raised.fill")
                            .font(DesignSystem.Typography.headlineFont)
                        Text("The agent wants to run the test suite in the project.")
                            .font(DesignSystem.Typography.bodyFont)
                            .foregroundColor(DesignSystem.Colors.textSecondary)
                        HStack {
                            Button("Allow once") {}.buttonStyle(.borderedProminent)
                            Button("Deny") {}.buttonStyle(.bordered)
                        }
                        Text("Demo only — approvals are not sent anywhere.")
                            .font(DesignSystem.Typography.captionFont)
                            .foregroundColor(DesignSystem.Colors.textSecondary)
                    }
                    .padding(DesignSystem.Spacing.md)
                    .background(DesignSystem.Colors.surface)
                    .cornerRadius(DesignSystem.Layout.cornerRadiusM)

                    HStack {
                        TextField("Message the agent", text: $draft).disabled(true)
                            .padding(10)
                            .background(DesignSystem.Colors.surface)
                            .cornerRadius(DesignSystem.Layout.cornerRadiusM)
                        Button {} label: { Image(systemName: "arrow.up.circle.fill") }.disabled(true)
                    }
                    .accessibilityHint("Sending is disabled in the demo")
                }
                .padding(DesignSystem.Layout.marginMobile)
            }
            .background(DesignSystem.Colors.background)
            .navigationTitle("LLM-IDE")
        }
    }
}

private struct DemoHistoryView: View {
    var body: some View {
        NavigationStack {
            List {
                Section("Recent chats") {
                    Label("Release risk review", systemImage: "bubble.left.and.text.bubble.right")
                    Label("Fix the failing checkout test", systemImage: "checkmark.seal")
                    Label("Plan the Box migration", systemImage: "shippingbox")
                }
                Section("Meeting notes") {
                    Label("Weekly sync · 24 Oct", systemImage: "person.2.wave.2")
                    Label("Incident review · 22 Oct", systemImage: "exclamationmark.triangle")
                }
                Section("Usage") {
                    LabeledContent("Claude", value: "42% of weekly limit")
                    LabeledContent("Requests today", value: "18")
                }
            }
            .navigationTitle("History")
        }
    }
}

private struct DemoSettingsView: View {
    let onExit: () -> Void
    var body: some View {
        NavigationStack {
            Form {
                Section("Reviewer demo") {
                    Text("This mode uses local sample data. It does not pair with a desktop, does not use the network and does not collect anything.")
                    Button("Exit demo", action: onExit)
                }
                Section("About") {
                    LabeledContent("App", value: "LLM-IDE")
                    LabeledContent("Mode", value: "Demo")
                }
            }
            .navigationTitle("Settings")
        }
    }
}
