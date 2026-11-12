import SwiftUI
import SharedProtocol
import AVFoundation

struct ScanResult {
    /// The desktop's Host API pairing (Settings → Phone and browser → Live Chat pairing).
    let desktop: PairingInfo?
    /// An offline sync enrollment (Settings → Phone and browser → Offline sync → Add a device for offline sync).
    let sync: SyncPair?
    init?(_ code: String) {
        desktop = PairingInfo(from: code)
        sync = code.hasPrefix("llmide://pair?") ? try? SyncEnroll.parsePair(code) : nil
        if desktop == nil && sync == nil { return nil }
    }
}

struct QRScannerSheet: View {
    let onScan: (ScanResult) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var permissionDenied = false
    /// Set when a scanned code parsed but failed validation (wrong scheme,
    /// non-local host, malformed PIN, no certificate pin).
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
                            .font(DesignSystem.Typography.bodyFont)
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
                            guard let info = ScanResult(code) else {
                                // Silently ignoring a REJECTED code is
                                // indistinguishable from "camera didn't see it",
                                // so say so — the scanner keeps running.
                                guard !code.isEmpty, rejectionNotice == nil else { return }
                                UINotificationFeedbackGenerator().notificationOccurred(.error)
                                rejectionNotice = "That isn't an LLM-IDE pairing code. Scan the QR in the desktop's Settings → Phone and browser (Live Chat pairing, or Offline sync → Add a device for offline sync)."
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
                        Text("Point at the pairing QR in LLM-IDE on your desktop")
                            .font(DesignSystem.Typography.subheadlineFont)
                            .foregroundColor(.white.opacity(0.9))
                            .padding(.top, DesignSystem.Spacing.lg)
                        if let rejectionNotice {
                            Text(rejectionNotice)
                                .font(DesignSystem.Typography.footnoteFont)
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
