import SwiftUI
import AVFoundation

/// Result of scanning the agent's pairing QR code
/// (`aicontrol://pair?ip=…&port=…&pin=…`).
struct PairingInfo {
    let ip: String
    let port: Int
    let pin: String

    init?(from string: String) {
        guard let components = URLComponents(string: string),
              components.scheme == "aicontrol",
              let items = components.queryItems,
              let ip = items.first(where: { $0.name == "ip" })?.value, !ip.isEmpty,
              let pin = items.first(where: { $0.name == "pin" })?.value, !pin.isEmpty
        else { return nil }
        self.ip = ip
        self.pin = pin
        self.port = items.first(where: { $0.name == "port" })?.value.flatMap(Int.init) ?? 3006
    }
}

/// Full-screen camera sheet that scans the pairing QR code shown in the
/// agent's terminal and hands back the connection details.
struct QRScannerSheet: View {
    let onScan: (PairingInfo) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var permissionDenied = false

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
                            guard let info = PairingInfo(from: code) else { return }
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
                        Text("Point at the QR code in the agent's terminal")
                            .font(.system(size: DesignSystem.Typography.subheadline))
                            .foregroundColor(.white.opacity(0.9))
                            .padding(.top, DesignSystem.Spacing.lg)
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
