import SwiftUI

/// "Add from catalog…" — the whole curated connector catalog, with the ones
/// this user already selected shown as added and unclickable.
///
/// Modelled on `McpAddSheet`'s catalog flow, but there is no form to fill in:
/// selecting a connector only makes it visible in Settings → Connections, so a
/// single tap is the entire interaction. Credentials and folder choices are
/// collected later, in that connector's own Settings card.
struct ConnectorAddSheet: View {
    @EnvironmentObject private var theme: ThemeStore
    @Environment(\.dismiss) private var dismiss

    let catalog: [ConnectorCatalogEntry]
    let onAdd: (ConnectorCatalogEntry) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.md) {
            header
            Divider()
            if catalog.isEmpty {
                Text("Catalog unavailable — the server didn't return any connectors.")
                    .font(Typography.caption)
                    .foregroundStyle(theme.current.textMuted)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: Spacing.xs) {
                        ForEach(catalog) { entry in
                            entryRow(entry)
                        }
                    }
                }
                .frame(maxHeight: 320)
            }
            Text("Removing a connector later keeps its fetched data and notes — selection controls visibility only.")
                .font(Typography.caption)
                .foregroundStyle(theme.current.textMuted)
                .fixedSize(horizontal: false, vertical: true)
            footer
        }
        .padding(Spacing.lg)
        .frame(width: 420)
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Add a connector").font(Typography.title).foregroundStyle(theme.current.text)
            Text("Connectors you add appear in Settings → Connections. Meetings and Email are always available and aren't listed here.")
                .font(Typography.caption)
                .foregroundStyle(theme.current.textMuted)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    @ViewBuilder
    private func entryRow(_ entry: ConnectorCatalogEntry) -> some View {
        Button {
            onAdd(entry)
            dismiss()
        } label: {
            HStack(alignment: .top, spacing: Spacing.sm) {
                Image(systemName: entry.icon)
                    .foregroundStyle(theme.current.info)
                    .frame(width: 20)
                VStack(alignment: .leading, spacing: 2) {
                    Text(entry.name)
                        .font(Typography.bodyStrong)
                        .foregroundStyle(theme.current.text)
                    Text(entry.description)
                        .font(Typography.caption)
                        .foregroundStyle(theme.current.textMuted)
                        .fixedSize(horizontal: false, vertical: true)
                        .multilineTextAlignment(.leading)
                }
                Spacer(minLength: Spacing.sm)
                trailingBadge(entry)
            }
            .padding(.vertical, 5)
            .padding(.horizontal, 6)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(entry.selected)
        .opacity(entry.selected ? 0.55 : 1)
        .help(entry.selected ? "Already added" : "Add \(entry.name)")
    }

    @ViewBuilder
    private func trailingBadge(_ entry: ConnectorCatalogEntry) -> some View {
        if entry.selected {
            Image(systemName: "checkmark")
                .font(Typography.captionStrong)
                .foregroundStyle(theme.current.success)
        } else if !entry.pipelineReady {
            // Honest about what selecting buys you today: the card shows up,
            // nothing fetches until a later phase ships the pipeline.
            Text("soon")
                .font(.system(size: 9, weight: .bold))
                .foregroundStyle(theme.current.warning)
                .padding(.horizontal, 5).padding(.vertical, 1)
                .background(theme.current.warning.opacity(0.15))
                .clipShape(Capsule())
        }
    }

    private var footer: some View {
        HStack {
            Spacer()
            Button("Done") { dismiss() }
                .keyboardShortcut(.cancelAction)
        }
    }
}
