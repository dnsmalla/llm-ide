import SwiftUI

// MARK: - ActivityBell

/// Bell icon in the status bar.  Shows a red count badge when there are
/// unread activity items, and opens `ActivityPanel` in a popover.
/// `markSeen()` is called as the popover opens so the badge clears
/// immediately without waiting for the next poll cycle.
struct ActivityBell: View {
    @Environment(ActivityStore.self) private var activity
    @State private var showPanel = false

    var body: some View {
        Button {
            showPanel.toggle()
        } label: {
            Image(systemName: activity.unreadCount > 0 ? "bell.badge" : "bell")
                .font(.system(size: 13))
                .overlay(alignment: .topTrailing) {
                    if activity.unreadCount > 0 {
                        Text("\(min(activity.unreadCount, 99))")
                            .font(.caption2)
                            .padding(.horizontal, 3)
                            .padding(.vertical, 2)
                            .background(Capsule().fill(Color.red))
                            .foregroundStyle(.white)
                            .offset(x: 7, y: -5)
                    }
                }
        }
        .buttonStyle(.plain)
        .help("Activity feed")
        .popover(isPresented: $showPanel, arrowEdge: .top) {
            ActivityPanel()
        }
        .onChange(of: showPanel) { _, open in
            if open { activity.markSeen() }
        }
    }
}

// MARK: - ActivityPanel

/// Scrollable, day-grouped list of activity items rendered in the
/// `ActivityBell` popover.  Reads `@Environment(ActivityStore.self)`
/// directly so it always reflects the live store — no separate data
/// passing required.
struct ActivityPanel: View {
    @Environment(ActivityStore.self) private var activity

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                if activity.items.isEmpty {
                    Text("No activity yet")
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity)
                        .padding(.top, 60)
                        .padding()
                } else {
                    ForEach(groupedByDay(), id: \.0) { (dayLabel, rows) in
                        Text(dayLabel)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 12)
                            .padding(.top, 10)
                            .padding(.bottom, 2)
                        ForEach(rows) { item in
                            ActivityRow(item: item)
                            Divider()
                                .padding(.leading, 40)
                        }
                    }
                }
            }
        }
        .frame(width: 360, height: 420)
    }

    /// Groups `activity.items` into labelled buckets: "Today",
    /// "Yesterday", or an abbreviated date string.  Items arrive
    /// newest-first from `ActivityStore`, so bucket order reflects
    /// recency automatically.
    private func groupedByDay() -> [(String, [ActivityItem])] {
        let cal = Calendar.current
        var buckets: [(String, [ActivityItem])] = []

        func bucketLabel(_ date: Date) -> String {
            if cal.isDateInToday(date) { return "Today" }
            if cal.isDateInYesterday(date) { return "Yesterday" }
            return date.formatted(date: .abbreviated, time: .omitted)
        }

        for item in activity.items {
            let label = bucketLabel(item.createdAt)
            if let idx = buckets.firstIndex(where: { $0.0 == label }) {
                buckets[idx].1.append(item)
            } else {
                buckets.append((label, [item]))
            }
        }
        return buckets
    }
}

// MARK: - ActivityRow

/// A single activity-feed row.  Tapping posts `.openSection` with
/// `item.link` as the object when the link is set; the handler in
/// `AppShell` casts the object to `String` and maps it to a
/// `ShellState.Section` rawValue — so links work only when `link`
/// holds a valid Section rawValue (e.g. "issues", "regression").
/// If the link is nil or does not map to a known section the post
/// is a silent no-op on AppShell's side (the cast to Section fails
/// and the block returns without changing state).  For v1 all activity
/// links emitted by the backend use Section rawValues, so deep-links
/// work for all items that carry a link.
struct ActivityRow: View {
    let item: ActivityItem

    var body: some View {
        Button {
            if let link = item.link {
                NotificationCenter.default.post(name: .openSection, object: link)
            }
        } label: {
            HStack(spacing: 10) {
                Image(systemName: kindIcon(for: item.kind))
                    .font(.system(size: 14))
                    .frame(width: 20)
                    .foregroundStyle(.secondary)
                VStack(alignment: .leading, spacing: 2) {
                    Text(item.title)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                    Text(item.createdAt, format: .relative(presentation: .named))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                if item.link != nil {
                    Image(systemName: "chevron.right")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 7)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func kindIcon(for kind: ActivityKind?) -> String {
        switch kind {
        case .knowledgeUpdated:     return "brain"
        case .regressionDone:       return "checkmark.seal"
        case .issueCreated:         return "exclamationmark.bubble"
        case .dispatchIssueCreated: return "exclamationmark.bubble"
        case .commentAdded:         return "text.bubble"
        case .outcomeChanged:       return "arrow.triangle.branch"
        case .meetingAdded:         return "person.3"
        case .emailFetched:         return "envelope"
        case .slackFetched:         return "number"
        case .none:                 return "circle"
        }
    }
}
