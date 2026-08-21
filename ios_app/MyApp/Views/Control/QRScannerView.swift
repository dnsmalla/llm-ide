import SwiftUI
import AVFoundation

/// Result of scanning the Mac app's pairing QR code
/// (`llmide://pair?ip=…&port=…&pin=…`; also accepts the legacy `aicontrol://`).
///
/// Every field is VALIDATED before it is accepted. A scanned code — or any app
/// invoking the `llmide://` scheme — silently re-points this phone at whatever
/// host it names, and the receiving server can then push fabricated chat
/// replies, session lists, and status frames while harvesting whatever the user
/// types next. So the host must be a literal address on a local/private network
/// (or an mDNS `.local` name), the PIN must have the exact shape `MobilePin`
/// mints, and the port must be a real high port. Anything else is not a pairing
/// code we are willing to act on.
struct PairingInfo {
    let ip: String
    let port: Int
    let pin: String

    static let defaultPort = 3006

    init?(from string: String) {
        guard let components = URLComponents(string: string),
              ["llmide", "aicontrol"].contains(components.scheme),
              let items = components.queryItems,
              let host = items.first(where: { $0.name == "ip" })?.value,
              let pin = items.first(where: { $0.name == "pin" })?.value
        else { return nil }
        let port = items.first(where: { $0.name == "port" })?.value
            .flatMap(Int.init) ?? Self.defaultPort
        guard let canonicalHost = Self.canonicalPrivateHost(host),
              Self.isWellFormedPin(pin), Self.isUsablePort(port)
        else { return nil }
        // Store the VALIDATED string, not the raw one: validating `bare` while
        // persisting `host` is a parser differential — `192.168.1.1%25evil.com`
        // validated as `192.168.1.1` and was saved with the suffix attached.
        self.ip = canonicalHost
        self.pin = pin
        self.port = port
    }

    /// Exactly six ASCII digits — the shape `MobilePin.regenerate` produces.
    /// Also stops a junk value from reaching the pairing frame at all.
    static func isWellFormedPin(_ pin: String) -> Bool {
        pin.count == 6 && pin.allSatisfy { $0.isASCII && $0.isNumber }
    }

    static func isUsablePort(_ port: Int) -> Bool {
        (1024...65_535).contains(port)
    }

    /// A host this app is willing to be re-pointed at: a literal IPv4 in a
    /// private/link-local/loopback range, Tailscale's CGNAT range (the Mac
    /// PREFERS that address in the QR — see `MobileConnectionInfo`), a
    /// link-local/ULA IPv6, or an mDNS `.local` name. Public addresses and
    /// arbitrary DNS names are refused, as is anything carrying URL syntax
    /// (`/`, `?`, `@`, …) that would rewrite the WebSocket URL's path or query.
    static func isPrivateHost(_ host: String) -> Bool {
        canonicalPrivateHost(host) != nil
    }

    /// The accepted host, exactly as it should be stored and dialled, or nil
    /// when it isn't one we're willing to be re-pointed at. A zone id is kept
    /// ONLY for an IPv6 literal (`fe80::1%en0`), where it is meaningful.
    static func canonicalPrivateHost(_ host: String) -> String? {
        guard !host.isEmpty, host.count <= 255 else { return nil }

        if host.contains(":") {
            let parts = host.split(separator: "%", maxSplits: 1, omittingEmptySubsequences: false)
            let addr = String(parts[0])
            guard isPrivateIPv6(addr) else { return nil }
            guard parts.count == 2 else { return addr }
            let zone = String(parts[1])
            guard !zone.isEmpty, zone.count <= 15,
                  zone.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber) }) else { return nil }
            return "\(addr)%\(zone)"
        }
        // Anything else must be exactly what it claims to be — no zone ids, no
        // trailing URL syntax.
        guard !host.contains("%") else { return nil }

        let octets = host.split(separator: ".", omittingEmptySubsequences: false)
        if octets.count == 4, octets.allSatisfy({ !$0.isEmpty && $0.allSatisfy(\.isNumber) }) {
            let values = octets.compactMap { Int($0) }
            guard values.count == 4, values.allSatisfy({ (0...255).contains($0) }) else { return nil }
            return isPrivateIPv4(values) ? host : nil
        }
        // Not an IP literal — only mDNS / Tailscale MagicDNS names qualify.
        return isPrivateName(host) ? host : nil
    }

    private static func isPrivateIPv4(_ o: [Int]) -> Bool {
        switch (o[0], o[1]) {
        case (10, _):                       return true   // 10.0.0.0/8
        case (127, _):                      return true   // loopback / simulator
        case (169, 254):                    return true   // link-local
        case (172, 16...31):                return true   // 172.16.0.0/12
        case (192, 168):                    return true   // 192.168.0.0/16
        case (100, 64...127):               return true   // 100.64.0.0/10 — Tailscale CGNAT
        default:                            return false
        }
    }

    private static func isPrivateIPv6(_ addr: String) -> Bool {
        let lower = addr.lowercased()
        guard lower.allSatisfy({ $0.isHexDigit || $0 == ":" }) else { return false }
        if lower == "::1" { return true }                       // loopback
        if lower.hasPrefix("fe8") || lower.hasPrefix("fe9")
            || lower.hasPrefix("fea") || lower.hasPrefix("feb") { return true }  // fe80::/10
        if lower.hasPrefix("fc") || lower.hasPrefix("fd") { return true }        // fc00::/7 ULA
        return false
    }

    /// mDNS (`*.local`) or Tailscale MagicDNS (`*.ts.net`) — both name a host
    /// reachable only on the user's own local network / tailnet.
    private static func isPrivateName(_ name: String) -> Bool {
        let lower = name.lowercased()
        guard lower.hasSuffix(".local") || lower.hasSuffix(".ts.net") else { return false }
        let labels = name.split(separator: ".", omittingEmptySubsequences: false)
        guard labels.count >= 2 else { return false }
        return labels.allSatisfy { label in
            !label.isEmpty && label.count <= 63
                && label.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-") }
        }
    }
}

/// Full-screen camera sheet that scans the pairing QR from Mac Settings →
/// Mobile Control and hands back the connection details.
struct QRScannerSheet: View {
    let onScan: (PairingInfo) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var permissionDenied = false
    /// Set when a scanned code parsed but failed validation (wrong scheme,
    /// non-local host, malformed PIN/port).
    @State private var rejectionNotice: String?

    var body: some View {
        NavigationStack {
            ZStack {
                Color.black.ignoresSafeArea()

                if permissionDenied {
                    VStack(spacing: DesignSystem.Spacing.md) {
                        Image(systemName: "camera.fill")
                            .font(.system(size: 40))
                            .foregroundColor(.white.opacity(0.5))
                        Text("Camera access is needed to scan the QR code.")
                            .font(.system(size: DesignSystem.Typography.body))
                            .foregroundColor(.white.opacity(0.8))
                            .multilineTextAlignment(.center)
                        Button("Open Settings") {
                            if let url = URL(string: UIApplication.openSettingsURLString) {
                                UIApplication.shared.open(url)
                            }
                        }
                        .foregroundColor(DesignSystem.Colors.primary)
                    }
                    .padding(DesignSystem.Spacing.xl)
                } else {
                    CameraPreview(
                        onCode: { code in
                            guard let info = PairingInfo(from: code) else {
                                // Silently ignoring a REJECTED code is
                                // indistinguishable from "camera didn't see it",
                                // so say so — the scanner keeps running.
                                guard !code.isEmpty, rejectionNotice == nil else { return }
                                UINotificationFeedbackGenerator().notificationOccurred(.error)
                                rejectionNotice = "That isn't a valid LLM-IDE pairing code. Scan the QR in LLM-IDE → Settings → Mobile Control."
                                return
                            }
                            UINotificationFeedbackGenerator().notificationOccurred(.success)
                            onScan(info)
                            dismiss()
                        },
                        onPermissionDenied: { permissionDenied = true }
                    )
                    .ignoresSafeArea()

                    // Viewfinder + hint
                    VStack {
                        Spacer()
                        RoundedRectangle(cornerRadius: 24)
                            .stroke(Color.white.opacity(0.8), lineWidth: 3)
                            .frame(width: 230, height: 230)
                        Text("Point at the pairing QR in LLM-IDE on your Mac")
                            .font(.system(size: DesignSystem.Typography.subheadline))
                            .foregroundColor(.white.opacity(0.9))
                            .padding(.top, DesignSystem.Spacing.lg)
                        if let rejectionNotice {
                            Text(rejectionNotice)
                                .font(.system(size: DesignSystem.Typography.footnote))
                                .foregroundColor(.white)
                                .multilineTextAlignment(.center)
                                .padding(DesignSystem.Spacing.md)
                                .background(DesignSystem.Colors.danger.opacity(0.9),
                                            in: RoundedRectangle(cornerRadius: 10))
                                .padding(.horizontal, DesignSystem.Spacing.xl)
                                .padding(.top, DesignSystem.Spacing.md)
                                .transition(.opacity)
                                .onTapGesture { self.rejectionNotice = nil }
                        }
                        Spacer()
                    }
                }
            }
            .navigationTitle("Scan to Pair")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .foregroundColor(.white)
                }
            }
            .toolbarBackground(.black, for: .navigationBar)
        }
    }
}

// MARK: — AVFoundation camera preview with QR detection

private struct CameraPreview: UIViewControllerRepresentable {
    let onCode: (String) -> Void
    let onPermissionDenied: () -> Void

    func makeUIViewController(context: Context) -> ScannerViewController {
        let vc = ScannerViewController()
        vc.onCode = onCode
        vc.onPermissionDenied = onPermissionDenied
        return vc
    }

    func updateUIViewController(_ vc: ScannerViewController, context: Context) {}
}

final class ScannerViewController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    var onCode: ((String) -> Void)?
    var onPermissionDenied: (() -> Void)?

    private let session = AVCaptureSession()
    private var previewLayer: AVCaptureVideoPreviewLayer?
    private var lastCode: String?

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black

        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            configureSession()
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
                DispatchQueue.main.async {
                    if granted { self?.configureSession() }
                    else { self?.onPermissionDenied?() }
                }
            }
        default:
            onPermissionDenied?()
        }
    }

    private func configureSession() {
        guard let device = AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: device),
              session.canAddInput(input) else {
            onPermissionDenied?()
            return
        }
        session.addInput(input)

        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else { return }
        session.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: .main)
        output.metadataObjectTypes = [.qr]

        let layer = AVCaptureVideoPreviewLayer(session: session)
        layer.videoGravity = .resizeAspectFill
        layer.frame = view.bounds
        view.layer.addSublayer(layer)
        previewLayer = layer

        DispatchQueue.global(qos: .userInitiated).async { [session] in
            session.startRunning()
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        previewLayer?.frame = view.bounds
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        if session.isRunning {
            DispatchQueue.global(qos: .userInitiated).async { [session] in
                session.stopRunning()
            }
        }
    }

    func metadataOutput(_ output: AVCaptureMetadataOutput,
                        didOutput metadataObjects: [AVMetadataObject],
                        from connection: AVCaptureConnection) {
        guard let obj = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
              obj.type == .qr,
              let code = obj.stringValue,
              code != lastCode else { return }
        lastCode = code
        onCode?(code)
    }
}
