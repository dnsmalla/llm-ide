import SwiftUI
import SharedProtocol

/// Errors the Mac recorded and the fixes its Self-Heal loop proposed. Review a proposal's diff here;
/// applying it is a Mac-side switch (Settings → Mobile Control → Phone access).
struct SelfHealView: View {
    @EnvironmentObject var connection: ConnectionService
    @EnvironmentObject var store: SelfHealStore

    var body: some View {
        List {
            if let s = store.state {
                if !s.enabled {
                    Section { Label("Self-Heal is switched off on the Mac.", systemImage: "pause.circle")
                        .font(DesignSystem.Typography.footnoteFont)
                        .foregroundColor(DesignSystem.Colors.textTertiary) }
                }
                if let error = s.error {
                    Section { Label(error, systemImage: "exclamationmark.triangle.fill")
                        .font(DesignSystem.Typography.footnoteFont).foregroundColor(DesignSystem.Colors.danger) }
                } else if let message = s.message {
                    Section { Label(message, systemImage: "checkmark.circle.fill")
                        .font(DesignSystem.Typography.footnoteFont).foregroundColor(DesignSystem.Colors.success) }
                }
                if s.incidents.isEmpty {
                    Section { Text("No incidents recorded. Errors the Mac app hits show up here with proposed fixes.")
                        .font(DesignSystem.Typography.footnoteFont)
                        .foregroundColor(DesignSystem.Colors.textTertiary) }
                } else {
                    Section {
                        ForEach(s.incidents) { incident in
                            NavigationLink { SelfHealDetailView(incident: incident) } label: { row(incident) }
                        }
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
                            Text(connection.connectionStatus == .connected ? "Loading incidents…" : "Connect to your Mac.")
                                .font(DesignSystem.Typography.footnoteFont)
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
        .navigationTitle("Self-Heal")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { store.refresh() } label: { Image(systemName: "arrow.clockwise") }
                    .accessibilityLabel("Refresh incidents")
            }
        }
        .refreshable { store.refresh() }
        .task { store.refresh() }
        .onChange(of: connection.connectionStatus) { status in
            if status == .connected, store.state == nil { store.refresh() }
        }
    }

    private func row(_ i: SelfHealIncident) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text("\(i.source) · \(i.category)").font(DesignSystem.Typography.captionFont.weight(.semibold))
                    .foregroundColor(DesignSystem.Colors.textSecondary)
                if i.count > 1 { Text("×\(i.count)").font(DesignSystem.Typography.captionFont)
                    .foregroundColor(DesignSystem.Colors.textTertiary) }
                Spacer()
                SelfHealStatusBadge(status: i.status)
            }
            Text(i.message).font(DesignSystem.Typography.subheadlineFont).lineLimit(2)
                .foregroundColor(DesignSystem.Colors.textPrimary)
            Text(Date(epochSeconds: i.lastSeen).relativeTimeShort())
                .font(DesignSystem.Typography.captionFont).foregroundColor(DesignSystem.Colors.textTertiary)
        }
        .padding(.vertical, 2)
    }
}

struct SelfHealStatusBadge: View {
    let status: String
    private var style: (String, Color) {
        switch status {
        case "proposed":   return ("Fix proposed", DesignSystem.Colors.primary)
        case "fixing":     return ("Fixing…", .orange)
        case "fixed":      return ("Fixed", DesignSystem.Colors.success)
        case "needsHuman": return ("Needs you", DesignSystem.Colors.danger)
        case "ignored":    return ("Ignored", DesignSystem.Colors.textTertiary)
        default:           return ("New", DesignSystem.Colors.textSecondary)
        }
    }
    var body: some View {
        Text(style.0)
            .font(DesignSystem.Typography.captionFont.weight(.semibold))
            .padding(.horizontal, 8).padding(.vertical, 2)
            .foregroundColor(style.1)
            .background(style.1.opacity(0.14), in: Capsule())
    }
}

struct SelfHealDetailView: View {
    let incident: SelfHealIncident
    @EnvironmentObject var store: SelfHealStore
    @State private var confirmApply = false
    @State private var confirmDiscard = false

    /// The freshest copy of this incident (the Mac pushes updates; the row we were opened with goes stale).
    private var current: SelfHealIncident { store.state?.incidents.first { $0.id == incident.id } ?? incident }
    private var canApply: Bool { store.state?.canApply == true }

    var body: some View {
        List {
            Section {
                HStack { SelfHealStatusBadge(status: current.status); Spacer()
                    Text("\(current.source) · \(current.category) · ×\(current.count)")
                        .font(DesignSystem.Typography.captionFont).foregroundColor(DesignSystem.Colors.textTertiary) }
                Text(current.message).font(DesignSystem.Typography.subheadlineFont.monospaced()).textSelection(.enabled)
                if let note = current.note, !note.isEmpty {
                    Text(note).font(DesignSystem.Typography.footnoteFont).foregroundColor(DesignSystem.Colors.textSecondary)
                }
            }
            if let result = store.state?.message ?? store.state?.error {
                Section { Text(result).font(DesignSystem.Typography.footnoteFont)
                    .foregroundColor(store.state?.error != nil ? DesignSystem.Colors.danger : DesignSystem.Colors.success) }
            }
            if current.hasProposal { proposalSection }
            actionsSection
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(DesignSystem.Colors.background.ignoresSafeArea())
        .navigationTitle("Incident")
        .navigationBarTitleDisplayMode(.inline)
        .confirmationDialog("Apply this fix to the LLM-IDE source checkout on your Mac? Nothing is committed.",
                            isPresented: $confirmApply, titleVisibility: .visible) {
            Button("Apply on Mac") { store.perform(.apply, on: current) }
            Button("Cancel", role: .cancel) {}
        }
        .confirmationDialog("Discard this proposal? The branch and worktree are deleted and can't be restored.",
                            isPresented: $confirmDiscard, titleVisibility: .visible) {
            Button("Discard", role: .destructive) { store.perform(.discard, on: current) }
            Button("Cancel", role: .cancel) {}
        }
    }

    @ViewBuilder
    private var proposalSection: some View {
        Section("Proposed fix") {
            if let branch = current.branch { Label(branch, systemImage: "arrow.triangle.branch")
                .font(DesignSystem.Typography.footnoteFont) }
            NavigationLink { SelfHealDiffScreen(incident: current) } label: {
                Label("Review the diff", systemImage: "doc.text.magnifyingglass")
            }
        }
    }

    @ViewBuilder
    private var actionsSection: some View {
        Section {
            if current.status == "new" || current.status == "needsHuman" {
                Button { store.perform(.ignore, on: current) } label: { Label("Ignore", systemImage: "eye.slash") }
            }
            if current.status == "ignored" || current.status == "needsHuman" {
                Button { store.perform(.retry, on: current) } label: { Label("Retry", systemImage: "arrow.counterclockwise") }
            }
            if current.status == "proposed" && current.hasProposal {
                if canApply {
                    Button { confirmApply = true } label: { Label("Apply to checkout…", systemImage: "square.and.arrow.down") }
                    Button(role: .destructive) { confirmDiscard = true } label: { Label("Discard proposal…", systemImage: "trash") }
                } else {
                    // The Mac refuses both without the switch, so don't offer a button that can only fail.
                    Label("Applying and discarding are off. Enable “Apply or discard Self-Heal fixes” in the Mac's Settings → Mobile Control → Phone access.",
                          systemImage: "lock")
                        .font(DesignSystem.Typography.footnoteFont).foregroundColor(DesignSystem.Colors.textTertiary)
                }
            }
        } footer: {
            if current.status == "proposed" {
                Text("Apply changes files in the LLM-IDE source checkout on the Mac, not your active project.")
            }
        }
        .disabled(store.isBusy)
    }
}

/// A proposal's diff on its own screen: a diff scrolls both ways, which fights a `List` row.
struct SelfHealDiffScreen: View {
    let incident: SelfHealIncident
    @EnvironmentObject var store: SelfHealStore
    @EnvironmentObject var connection: ConnectionService

    var body: some View {
        let diff = store.diffs[incident.id]
        ScrollView {
            if let diff {
                if let error = diff.error {
                    Text(error).font(DesignSystem.Typography.footnoteFont).foregroundColor(DesignSystem.Colors.danger)
                        .padding(DesignSystem.Spacing.md)
                } else if let text = diff.diff {
                    VStack(alignment: .leading, spacing: DesignSystem.Spacing.xs) {
                        if diff.truncated {
                            Label("Long diff — showing the first part.", systemImage: "scissors")
                                .font(DesignSystem.Typography.captionFont).foregroundColor(DesignSystem.Colors.textTertiary)
                        }
                        DiffTextView(text: text)
                    }
                    .padding(DesignSystem.Spacing.sm)
                }
            } else {
                ProgressView().padding(.top, 60).frame(maxWidth: .infinity)
            }
        }
        .background(DesignSystem.Colors.background.ignoresSafeArea())
        .navigationTitle("Proposed fix")
        .navigationBarTitleDisplayMode(.inline)
        .task { if diff == nil || diff?.error != nil { store.loadDiff(for: incident) } }
        .onChange(of: connection.connectionStatus) { status in
            if status == .connected, store.diffs[incident.id] == nil { store.loadDiff(for: incident) }
        }
    }
}
