import SwiftUI

/// State of the "Trust this folder" banner. Trusting is only ever an explicit
/// click followed by a confirmation naming what will run; nothing here trusts
/// a folder on its own.
@MainActor
@Observable
final class WorkspaceTrustBannerModel {
    private let api: any ExtensionsTrustAPI
    let notice: ChatWorkspaceTrustNotice
    var confirming = false
    private(set) var saving = false
    private(set) var errorText: String?
    private(set) var trusted = false

    init(api: any ExtensionsTrustAPI, notice: ChatWorkspaceTrustNotice) {
        self.api = api
        self.notice = notice
    }

    var message: String { WorkspaceTrustPresentation.bannerText(notice) }
    var confirmation: String { WorkspaceTrustPresentation.confirmationText(notice) }

    /// Runs after the user confirmed. Returns true when the folder is now trusted.
    @discardableResult
    func confirmTrust() async -> Bool {
        guard !saving else { return false }
        saving = true
        errorText = nil
        defer { saving = false }
        do {
            let r = try await api.setWorkspaceTrust(path: notice.path, trusted: true)
            trusted = r.item.trusted
            return trusted
        } catch {
            if let api = error as? APIError, case .http(_, let code, let msg, _) = api {
                errorText = WorkspaceTrustPresentation.message(forCode: code, serverMessage: msg)
            } else {
                errorText = WorkspaceTrustPresentation.message(forCode: nil, serverMessage: nil)
            }
            return false
        }
    }
}

/// Banner above the composer when the server reports the chat's folder as untrusted.
struct WorkspaceTrustBanner: View {
    @EnvironmentObject var theme: ThemeStore
    @State private var model: WorkspaceTrustBannerModel
    let onDone: () -> Void

    init(api: LlmIdeAPIClient, notice: ChatWorkspaceTrustNotice, onDone: @escaping () -> Void) {
        _model = State(initialValue: WorkspaceTrustBannerModel(api: api, notice: notice))
        self.onDone = onDone
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .top, spacing: 6) {
                Image(systemName: "lock.shield")
                    .foregroundStyle(theme.current.warning)
                    .accessibilityHidden(true)
                Text(model.message)
                    .font(Typography.caption)
                    .foregroundStyle(theme.current.text)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
                Button {
                    onDone()
                } label: {
                    Image(systemName: "xmark.circle.fill").foregroundStyle(theme.current.textMuted)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Dismiss folder trust notice")
                .help("Dismiss")
            }
            HStack(spacing: 8) {
                Button("Trust this folder") { model.confirming = true }
                    .buttonStyle(.bordered).controlSize(.small)
                    .disabled(model.saving)
                    .accessibilityHint("Asks for confirmation before this folder's MCP servers can start")
                if model.saving { ProgressView().controlSize(.small) }
                if let e = model.errorText {
                    Text(e).font(Typography.caption).foregroundStyle(theme.current.danger)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .padding(10)
        .background(theme.current.warning.opacity(0.1))
        .confirmationDialog("Trust this folder?", isPresented: $model.confirming, titleVisibility: .visible) {
            Button("Trust and allow its MCP servers", role: .destructive) {
                Task { if await model.confirmTrust() { onDone() } }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(model.confirmation)
        }
    }
}
