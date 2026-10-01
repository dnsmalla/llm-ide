import SwiftUI
import SharedProtocol

/// The Mac's activity feed: what happened while you were away (loops finished, meetings added,
/// model fallbacks…). Newest first, with a dot on entries you haven't seen.
struct ActivityView: View {
    @EnvironmentObject var connection: ConnectionService
    @EnvironmentObject var store: ActivityFeedStore

    /// Unread entries are the newest `unread` ones; captured when the screen opens, because
    /// opening it clears the count and the dots would vanish before they were read.
    @State private var unreadAtOpen = 0

    private var isConnected: Bool { connection.connectionStatus == .connected }

    var body: some View {
        NavigationStack {
            List {
                if !store.loaded {
                    Section {
                        if let error = store.loadError {
                            Text(error).font(DesignSystem.Typography.footnoteFont)
                                .foregroundColor(DesignSystem.Colors.textTertiary)
                        } else {
                            HStack(spacing: DesignSystem.Spacing.sm) {
                                ProgressView()
                                Text(isConnected ? "Loading activity…" : "Connect to your Mac to see activity.")
                                    .font(DesignSystem.Typography.footnoteFont)
                                    .foregroundColor(DesignSystem.Colors.textTertiary)
                            }
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, DesignSystem.Spacing.md)
                        }
                    }
                } else if store.entries.isEmpty {
                    Section {
                        Text("Nothing yet. Events from your Mac — finished loops, new meetings, model fallbacks — show up here.")
                            .font(DesignSystem.Typography.footnoteFont)
                            .foregroundColor(DesignSystem.Colors.textTertiary)
                    }
                } else {
                    ForEach(groups, id: \.title) { group in
                        Section(group.title) {
                            ForEach(group.entries) { entry in row(entry) }
                        }
                    }
                }
            }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
            .background(DesignSystem.Colors.background.ignoresSafeArea())
            .navigationTitle("Activity")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { store.refresh() } label: { Image(systemName: "arrow.clockwise") }
                        .accessibilityLabel("Refresh activity")
                }
            }
            .refreshable { store.refresh() }
            .onChange(of: connection.connectionStatus) { status in
                if status == .connected, !store.loaded { store.refresh() }
            }
            .onAppear {
                unreadAtOpen = store.unread
                store.refresh()
                store.markSeen()
            }
            // New events arriving while the tab is open count as read straight away.
            .onChange(of: store.entries.first?.id) { _ in
                unreadAtOpen = max(unreadAtOpen, store.unread)
                store.markSeen()
            }
        }
    }

    // MARK: — Rows

    private func row(_ entry: ActivityEntry) -> some View {
        let isUnread = (store.entries.firstIndex(of: entry) ?? Int.max) < unreadAtOpen
        return HStack(alignment: .top, spacing: DesignSystem.Spacing.sm) {
            Image(systemName: Self.icon(for: entry.kind))
                .foregroundColor(DesignSystem.Colors.primary)
                .frame(width: 24)
            VStack(alignment: .leading, spacing: 2) {
                Text(entry.title)
                    .font(DesignSystem.Typography.bodyFont)
                    .foregroundColor(DesignSystem.Colors.textPrimary)
                Text(Date(epochSeconds: entry.createdAt).relativeTimeShort())
                    .font(DesignSystem.Typography.captionFont)
                    .foregroundColor(DesignSystem.Colors.textTertiary)
            }
            Spacer(minLength: 0)
            if isUnread {
                Circle().fill(DesignSystem.Colors.primary).frame(width: 8, height: 8)
                    .accessibilityLabel("Unread")
            }
        }
    }

    private struct Group { let title: String; let entries: [ActivityEntry] }

    private var groups: [Group] {
        let cal = Calendar.current
        var today: [ActivityEntry] = [], earlier: [ActivityEntry] = []
        for e in store.entries {
            if cal.isDateInToday(Date(epochSeconds: e.createdAt)) { today.append(e) } else { earlier.append(e) }
        }
        return [Group(title: "Today", entries: today), Group(title: "Earlier", entries: earlier)]
            .filter { !$0.entries.isEmpty }
    }

    static func icon(for kind: String?) -> String {
        switch kind {
        case "knowledge_updated":      return "brain"
        case "regression_done":        return "checkmark.shield"
        case "loop_engineering_done":  return "arrow.triangle.2.circlepath"
        case "issue_created":          return "exclamationmark.circle"
        case "comment_added":          return "text.bubble"
        case "dispatch_issue_created": return "paperplane"
        case "outcome_changed":        return "flag"
        case "meeting_added":          return "person.2"
        case "email_fetched":          return "envelope"
        case "slack_fetched":          return "number"
        case "model_fallback":         return "arrow.triangle.branch"
        default:                       return "bell"
        }
    }
}
