import SwiftUI

struct LibraryRow: View {
    let row: MeetingIndex.Row
    @Environment(ShellState.self) private var shell

    private var needsSummary: Bool {
        (row.gist ?? "").isEmpty && (row.tldrJSON ?? "").isEmpty
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            // Title + platform icon
            HStack(spacing: 6) {
                Image(systemName: platformIcon)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                Text(row.title?.isEmpty == false ? row.title! : "Untitled")
                    .font(.headline)
                    .lineLimit(1)
                Spacer(minLength: 0)
            }

            // Date + duration
            Text(subtitle)
                .font(.caption)
                .foregroundStyle(.secondary)

            // Gist or summarizing indicator
            if let gist = row.gist, !gist.isEmpty {
                Text(gist)
                    .font(.callout)
                    .lineLimit(2)
                    .foregroundStyle(.secondary)
            } else if needsSummary {
                HStack(spacing: 5) {
                    ProgressView().controlSize(.mini).scaleEffect(0.8)
                    Text("Summarizing…")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                }
            }

            // Entity chips
            let totalEntities = row.actionsCount + row.decisionsCount + row.blockersCount
            if totalEntities > 0 {
                HStack(spacing: 6) {
                    if row.actionsCount > 0 {
                        chip("\(row.actionsCount)a", color: .accentColor)
                    }
                    if row.decisionsCount > 0 {
                        chip("\(row.decisionsCount)d", color: .green)
                    }
                    if row.blockersCount > 0 {
                        chip("\(row.blockersCount)b", color: .orange)
                    }
                }
                .padding(.top, 1)
            }
        }
        .padding(.vertical, 5)
        .contextMenu { contextMenuItems }
    }

    // MARK: - Helpers

    private var subtitle: String {
        let ms = TimeInterval(row.startedAt) / 1000
        let date = Date(timeIntervalSince1970: ms)
        let dateStr = AppDateFormatter.relativeDate(date)
        if let d = row.durationSec, d > 0 {
            return "\(dateStr) · \(d.durationString)"
        }
        return dateStr
    }

    private var platformIcon: String {
        switch (row as? any PlatformProvider)?.platform ?? "" {
        case "teams":  return "video.fill"
        case "zoom":   return "video.circle.fill"
        case "mic":    return "mic.fill"
        default:       return "video.bubble.left.fill"   // meet / default
        }
    }

    private func chip(_ text: String, color: Color) -> some View {
        Text(text)
            .font(.system(size: 10, weight: .medium, design: .rounded))
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(color.opacity(0.12))
            .foregroundStyle(color)
            .clipShape(Capsule())
    }

    @ViewBuilder
    private var contextMenuItems: some View {
        Button {
            // Select the meeting (mounts its detail) and flag the intent; the
            // detail re-summarizes once loaded. A bare notification was lost
            // when the detail pane wasn't already showing this meeting.
            shell.pendingResummarizeMeetingId = row.id
            shell.selectedMeetingId = row.id
        } label: {
            Label("Re-summarize", systemImage: "sparkles")
        }
        Divider()
        Button {
            NotificationCenter.default.post(
                name: .exportMeeting, object: row.id)
        } label: {
            Label("Export…", systemImage: "square.and.arrow.up")
        }
        Button {
            NotificationCenter.default.post(
                name: .revealMeetingInFinder, object: row.id)
        } label: {
            Label("Reveal in Finder", systemImage: "folder")
        }
        Divider()
        Button(role: .destructive) {
            NotificationCenter.default.post(
                name: .deleteMeeting, object: row.id)
        } label: {
            Label("Remove from List", systemImage: "minus.circle")
        }
    }
}

// MARK: - Platform icon protocol shim
// MeetingIndex.Row is a plain struct without platform; the platform
// lives in the .md frontmatter, not the index.  We show a generic
// icon and will refine once the index grows a platform column.
private protocol PlatformProvider { var platform: String { get } }

private extension Int {
    var durationString: String {
        if self < 60 { return "\(self)s" }
        let mins = self / 60
        if mins < 60 { return "\(mins) min" }
        let h = mins / 60; let m = mins % 60
        return m == 0 ? "\(h)h" : "\(h)h \(m)m"
    }
}

// Notification.Name extensions moved to Services/NotificationNames.swift
