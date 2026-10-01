import SwiftUI
import SharedProtocol

/// What the Mac's "Model & Limits" panel shows, read-only: per-model meters, Claude subscription
/// windows, and the edit-permission mode the Mac's chat is running under.
struct UsageView: View {
    @EnvironmentObject var connection: ConnectionService
    @EnvironmentObject var store: UsageStore

    var body: some View {
        List {
            if let s = store.state {
                Section {
                    permissionRow(s.permissionMode)
                } footer: {
                    Text("Phone chats run under the Mac's setting. It can only be changed on the Mac.")
                }
                if let error = s.error {
                    Section { Label(error, systemImage: "exclamationmark.triangle.fill")
                        .font(DesignSystem.Typography.footnoteFont)
                        .foregroundColor(DesignSystem.Colors.danger) }
                }
                if let status = s.status, status != "ok" {
                    Section { statusBanner(status, reason: s.statusReason, model: s.activeModel) }
                }
                if !s.subscription.isEmpty {
                    Section("Claude subscription") { ForEach(s.subscription) { meterRow($0) } }
                } else if let note = s.subscriptionNote {
                    Section("Claude subscription") {
                        Text(note).font(DesignSystem.Typography.footnoteFont)
                            .foregroundColor(DesignSystem.Colors.textTertiary)
                    }
                }
                Section(s.provider.map { "Models · \($0)" } ?? "Models") {
                    if s.models.isEmpty {
                        Text("No model limits are set on the Mac.")
                            .font(DesignSystem.Typography.footnoteFont)
                            .foregroundColor(DesignSystem.Colors.textTertiary)
                    } else {
                        ForEach(s.models) { meterRow($0) }
                    }
                }
            } else {
                Section {
                    if let error = store.loadError {
                        Text(error).font(DesignSystem.Typography.footnoteFont)
                            .foregroundColor(DesignSystem.Colors.textTertiary)
                    } else {
                        HStack(spacing: DesignSystem.Spacing.sm) {
                            ProgressView()
                            Text("Loading usage…").font(DesignSystem.Typography.footnoteFont)
                                .foregroundColor(DesignSystem.Colors.textTertiary)
                        }
                        .frame(maxWidth: .infinity).padding(.vertical, DesignSystem.Spacing.md)
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(DesignSystem.Colors.background.ignoresSafeArea())
        .navigationTitle("Usage & limits")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { store.refresh() } label: { Image(systemName: "arrow.clockwise") }
                    .accessibilityLabel("Refresh usage")
            }
        }
        .refreshable { store.refresh() }
        .task { store.refresh() }
    }

    private func permissionRow(_ raw: String) -> some View {
        let label = UsageStore.permissionLabel(raw)
        return HStack {
            Label("Mac permission mode", systemImage: "lock.shield")
            Spacer()
            Text(label?.text ?? raw)
                .font(DesignSystem.Typography.bodyFont.weight(.semibold))
                .foregroundColor(label?.isRisky == true ? DesignSystem.Colors.danger : DesignSystem.Colors.textSecondary)
        }
    }

    private func statusBanner(_ status: String, reason: String?, model: String?) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Label(status.capitalized + (model.map { " · \($0)" } ?? ""), systemImage: "exclamationmark.circle")
                .foregroundColor(status == "paused" ? DesignSystem.Colors.danger : DesignSystem.Colors.textSecondary)
            if let reason { Text(reason).font(DesignSystem.Typography.footnoteFont)
                .foregroundColor(DesignSystem.Colors.textTertiary) }
        }
    }

    private func meterRow(_ m: UsageMeter) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(m.name).font(DesignSystem.Typography.bodyFont)
                Spacer()
                if let pct = m.pct { Text("\(Int(pct))%").font(DesignSystem.Typography.subheadlineFont.monospacedDigit())
                    .foregroundColor(color(m.state)) }
            }
            if let pct = m.pct {
                ProgressView(value: min(max(pct, 0), 100), total: 100).tint(color(m.state))
            }
            Text(m.detail + (m.resetsAt.map { " · resets \(Date(epochSeconds: $0).relativeTimeShort())" } ?? ""))
                .font(DesignSystem.Typography.captionFont)
                .foregroundColor(DesignSystem.Colors.textTertiary)
        }
        .padding(.vertical, 2)
    }

    private func color(_ state: String) -> Color {
        switch state {
        case "exhausted": return DesignSystem.Colors.danger
        case "warning":   return .orange
        default:          return DesignSystem.Colors.primary
        }
    }
}
