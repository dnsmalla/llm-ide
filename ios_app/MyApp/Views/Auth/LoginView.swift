import SwiftUI

/// Entry screen — discovers Macs automatically; falls back to manual IP + PIN entry.
struct ConnectView: View {
    @EnvironmentObject var connectionStore: ConnectionStore
    @EnvironmentObject var connection: ConnectionService
    @StateObject private var discovery = DeviceDiscovery()

    @State private var ip: String  = ""
    @State private var pin: String = ""
    @State private var showManual: Bool = false
    @State private var showScanner: Bool = false
    @State private var errorMessage: String?
    @State private var connectAttempted: Bool = false

    private var isConnecting: Bool { connection.connectionStatus == .connecting }

    var body: some View {
        ScrollView {
            VStack(spacing: DesignSystem.Spacing.xl) {
                header
                if let err = errorMessage {
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
                discoveredSection
                if showManual || discovery.devices.isEmpty {
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
            // Carry over a failure that happened while another view was up —
            // an `auth_failed` clears the saved PIN, which remounts this view,
            // so its own onChange can never observe that transition.
            if let pending = connection.errorMessage { errorMessage = pending }
            discovery.start()
        }
        .onDisappear { discovery.stop() }
        // Observe the MESSAGE, not only the status: the service sets
        // .disconnected and then .connecting within one MainActor turn while
        // auto-retrying, so SwiftUI coalesces them and the status-only path saw
        // no failure at all — every error looked like "still connecting".
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
                    ?? "Could not reach the Mac. Check it's on the same network (or Tailscale) and the agent is running."
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
            Text("Connect to Your Mac")
                .font(DesignSystem.Typography.titleFont.weight(.bold))
                .foregroundColor(DesignSystem.Colors.textPrimary)
            Text("Start Mobile Control on your Mac (Settings → Mobile Control), then scan the QR or pick your Mac below.")
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
            QRScannerSheet { info in
                errorMessage = nil
                connectAttempted = true
                connectionStore.save(ip: info.ip, port: info.port, pin: info.pin)
                connection.connectDirect(ip: info.ip, port: info.port, pin: info.pin)
            }
        }
    }

    private var discoveredSection: some View {
        VStack(alignment: .leading, spacing: DesignSystem.Spacing.sm) {
            if discovery.isSearching && discovery.devices.isEmpty {
                HStack(spacing: DesignSystem.Spacing.sm) {
                    ProgressView().scaleEffect(0.8)
                    Text("Scanning for Macs on your network…")
                        .font(DesignSystem.Typography.subheadlineFont)
                        .foregroundColor(DesignSystem.Colors.textSecondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(DesignSystem.Spacing.md)
                .background(DesignSystem.Colors.surface)
                .cornerRadius(DesignSystem.Layout.cornerRadiusL)
            }

            ForEach(discovery.devices) { device in
                DiscoveredDeviceCard(
                    device: device,
                    isKnown: connectionStore.deviceIP == device.host,
                    isConnecting: isConnecting,
                    savedPIN: connectionStore.devicePIN,
                    onConnect: { resolvedPIN in
                        errorMessage = nil
                        connectAttempted = true
                        // `device.port` is what Bonjour resolved for THIS Mac;
                        // the saved port may belong to another one. Fall back to
                        // the saved/default only when discovery gave us none.
                        let portToUse = device.port > 0
                            ? device.port
                            : (connectionStore.devicePort > 0 ? connectionStore.devicePort : PairingInfo.defaultPort)
                        connectionStore.save(ip: device.host, port: portToUse, pin: resolvedPIN)
                        connection.connectDirect(ip: device.host, port: portToUse, pin: resolvedPIN)
                    }
                )
            }

            if !discovery.devices.isEmpty {
                Button {
                    withAnimation { showManual.toggle() }
                } label: {
                    Text(showManual ? "Hide manual entry" : "Enter details manually")
                        .font(DesignSystem.Typography.footnoteFont)
                        .foregroundColor(DesignSystem.Colors.primary)
                }
                .frame(maxWidth: .infinity, alignment: .trailing)
            }
        }
    }

    private var manualSection: some View {
        VStack(spacing: DesignSystem.Spacing.lg) {
            Text(discovery.devices.isEmpty ? "Enter your Mac's details" : "Manual entry")
                .font(DesignSystem.Typography.subheadlineFont.weight(.semibold))
                .foregroundColor(DesignSystem.Colors.textPrimary)
                .frame(maxWidth: .infinity, alignment: .leading)

            inputField(label: "IP Address", placeholder: "192.168.0.100 or 192.168.0.100:3007",
                       text: $ip, keyboard: .numbersAndPunctuation)
            inputField(label: "PIN", placeholder: "123456",
                       text: $pin, keyboard: .numberPad, isSecure: true)

            Button {
                let raw = ip.trimmingCharacters(in: .whitespaces)
                // Accept "host:port" — the Mac's server falls back to the
                // next free port when its configured one is busy, and manual
                // entry (unlike Bonjour or the QR) has no other way to learn
                // a non-default port. A lone host keeps the saved/default.
                var host = raw
                var enteredPort: Int?
                if let colon = raw.lastIndex(of: ":"), colon != raw.startIndex {
                    let suffix = raw[raw.index(after: colon)...]
                    if let p = Int(suffix), (1...65535).contains(p) {
                        host = String(raw[..<colon])
                        enteredPort = p
                    }
                }
                let code = pin.trimmingCharacters(in: .whitespaces)
                // Same validation as a scanned code — a typo'd host would
                // otherwise be saved and retried forever.
                guard PairingInfo.isPrivateHost(host) else {
                    errorMessage = "Enter your Mac's local address (e.g. 192.168.0.100, optionally with :port, a 100.x Tailscale address, or name.local)."
                    return
                }
                guard PairingInfo.isWellFormedPin(code) else {
                    errorMessage = "The PIN is the 6 digits shown in LLM-IDE → Settings → Mobile Control."
                    return
                }
                errorMessage = nil
                connectAttempted = true
                let port = enteredPort
                    ?? (connectionStore.devicePort > 0 ? connectionStore.devicePort : PairingInfo.defaultPort)
                connectionStore.save(ip: host, port: port, pin: code)
                connection.connectDirect(ip: host, port: port, pin: code)
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

// MARK: — Discovered Device Card

private struct DiscoveredDeviceCard: View {
    let device: DiscoveredDevice
    let isKnown: Bool          // IP matches saved connection
    let isConnecting: Bool
    let savedPIN: String
    let onConnect: (String) -> Void

    @State private var pinEntry: String = ""
    @State private var showPINField: Bool = false
    @FocusState private var pinFocused: Bool

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: DesignSystem.Spacing.md) {
                ZStack {
                    RoundedRectangle(cornerRadius: 10)
                        .fill(DesignSystem.Colors.primary.opacity(0.12))
                        .frame(width: 44, height: 44)
                    Image(systemName: "apple.logo")
                        .font(.system(size: 20))
                        .foregroundColor(DesignSystem.Colors.primary)
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(device.name)
                        .font(DesignSystem.Typography.bodyFont.weight(.semibold))
                        .foregroundColor(DesignSystem.Colors.textPrimary)
                    Text(device.host)
                        .font(DesignSystem.Typography.footnoteFont.monospaced())
                        .foregroundColor(DesignSystem.Colors.textSecondary)
                }
                Spacer()
                if isKnown && !savedPIN.isEmpty {
                    // Already paired — one tap to connect
                    Button {
                        onConnect(savedPIN)
                    } label: {
                        Text(isConnecting ? "Connecting…" : "Connect")
                            .font(DesignSystem.Typography.subheadlineFont.weight(.semibold))
                            .foregroundColor(.white)
                            .padding(.horizontal, 14)
                            .padding(.vertical, 8)
                            .background(DesignSystem.Colors.primary)
                            .cornerRadius(DesignSystem.Layout.cornerRadiusM)
                    }
                    .disabled(isConnecting)
                } else {
                    // First time — need PIN
                    Button {
                        withAnimation { showPINField.toggle() }
                        if showPINField { pinFocused = true }
                    } label: {
                        Text("Enter PIN")
                            .font(DesignSystem.Typography.subheadlineFont.weight(.semibold))
                            .foregroundColor(DesignSystem.Colors.primary)
                            .padding(.horizontal, 14)
                            .padding(.vertical, 8)
                            .background(DesignSystem.Colors.primary.opacity(0.12))
                            .cornerRadius(DesignSystem.Layout.cornerRadiusM)
                    }
                }
            }
            .padding(DesignSystem.Spacing.md)

            if showPINField && !(isKnown && !savedPIN.isEmpty) {
                Divider().padding(.horizontal, DesignSystem.Spacing.md)
                HStack(spacing: DesignSystem.Spacing.sm) {
                    SecureField("PIN from Mac Settings", text: $pinEntry)
                        .focused($pinFocused)
                        .keyboardType(.numberPad)
                        .padding(DesignSystem.Spacing.sm)
                        .background(DesignSystem.Colors.background)
                        .cornerRadius(DesignSystem.Layout.cornerRadiusS)
                    Button {
                        guard !pinEntry.isEmpty else { return }
                        onConnect(pinEntry)
                    } label: {
                        Image(systemName: "arrow.right.circle.fill")
                            .font(.system(size: 32))
                            .foregroundColor(pinEntry.isEmpty
                                ? DesignSystem.Colors.primary.opacity(0.3)
                                : DesignSystem.Colors.primary)
                    }
                    .disabled(pinEntry.isEmpty)
                }
                .padding([.horizontal, .bottom], DesignSystem.Spacing.md)
            }
        }
        .background(DesignSystem.Colors.surface)
        .cornerRadius(DesignSystem.Layout.cornerRadiusL)
        .shadow(color: .black.opacity(DesignSystem.Layout.shadowOpacity),
                radius: DesignSystem.Layout.shadowRadius, x: 0, y: 2)
    }
}
