import SwiftUI

struct SummarySections: View {
    let frontmatter: MeetingFrontmatter
    let summaryMarkdown: String?
    let transcript: String?
    let isNewest: Bool

    @State private var fullExpanded: Bool
    @State private var transcriptExpanded = false
    @State private var transcriptCopied = false
    @EnvironmentObject private var theme: ThemeStore

    init(frontmatter: MeetingFrontmatter,
         summaryMarkdown: String?,
         transcript: String?,
         isNewest: Bool = false) {
        self.frontmatter = frontmatter
        self.summaryMarkdown = summaryMarkdown
        self.transcript = transcript
        self.isNewest = isNewest
        // All sections start collapsed regardless of isNewest — the user
        // taps the disclosure to open what they want to read. Used to
        // auto-open the full summary for the newest meeting, which made
        // the panel feel noisy on launch.
        _fullExpanded = State(initialValue: false)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                metadataHeader
                Divider()
                summaryContent
            }
            .padding(20)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    // MARK: - Metadata header

    private var metadataHeader: some View {
        VStack(alignment: .leading, spacing: 10) {
            // Date + duration row
            HStack(spacing: 16) {
                metaChip(icon: "calendar", text: formattedDate)
                if let d = frontmatter.durationSeconds, d > 0 {
                    metaChip(icon: "clock", text: d.durationString)
                }
                metaChip(icon: platformIcon, text: frontmatter.platform.capitalized)
                if !frontmatter.language.isEmpty {
                    metaChip(icon: "globe", text: frontmatter.language.uppercased())
                }
            }

            // Participants
            if !frontmatter.participants.isEmpty {
                HStack(spacing: 6) {
                    Image(systemName: "person.2")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text(frontmatter.participants.joined(separator: ", "))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
            }
        }
    }

    private func metaChip(icon: String, text: String) -> some View {
        HStack(spacing: 4) {
            Image(systemName: icon)
                .font(.caption2)
            Text(text)
                .font(.caption)
        }
        .foregroundStyle(.secondary)
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(.quaternary, in: Capsule())
    }

    // MARK: - Summary sections

    @ViewBuilder
    private var summaryContent: some View {
        // Gist
        if let g = frontmatter.gist, !g.isEmpty {
            namedSection(icon: "text.quote", title: "Gist") {
                Text(g)
                    .font(.body)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }

        // TL;DR
        if !frontmatter.tldr.isEmpty {
            namedSection(icon: "list.bullet", title: "TL;DR") {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(Array(frontmatter.tldr.enumerated()), id: \.offset) { _, item in
                        HStack(alignment: .top, spacing: 8) {
                            Image(systemName: "chevron.right")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(theme.current.accent)
                                .padding(.top, 3)
                            Text(item)
                                .font(.callout)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
            }
        }

        // Full notes — collapsible
        DisclosureGroup(isExpanded: $fullExpanded) {
            if let md = summaryMarkdown,
               !md.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                Text(.init(md))
                    .font(.callout)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 8)
            } else {
                Text("No detailed notes yet.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .padding(.top, 6)
            }
        } label: {
            disclosureLabel(icon: "doc.text", title: "Full Notes")
        }

        // Transcript — collapsible with copy button
        if let t = transcript {
            DisclosureGroup(isExpanded: $transcriptExpanded) {
                VStack(alignment: .trailing, spacing: 8) {
                    HStack {
                        Spacer()
                        Button {
                            NSPasteboard.general.clearContents()
                            NSPasteboard.general.setString(t, forType: .string)
                            withAnimation { transcriptCopied = true }
                            Task { @MainActor in
                                try? await Task.sleep(for: .seconds(2))
                                withAnimation { transcriptCopied = false }
                            }
                        } label: {
                            Label(transcriptCopied ? "Copied!" : "Copy",
                                  systemImage: transcriptCopied ? "checkmark" : "doc.on.doc")
                                .font(.caption)
                        }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                    }
                    Text(t)
                        .font(.callout.monospaced())
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .padding(.top, 8)
            } label: {
                disclosureLabel(icon: "text.alignleft", title: "Transcript")
            }
        }
    }

    // MARK: - Helpers

    private func namedSection<C: View>(icon: String, title: String,
                                       @ViewBuilder content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                Image(systemName: icon)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(theme.current.accent)
                Text(title)
                    .font(.subheadline.weight(.semibold))
            }
            content()
        }
    }

    private func disclosureLabel(icon: String, title: String) -> some View {
        HStack(spacing: 6) {
            Image(systemName: icon)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(theme.current.accent)
            Text(title)
                .font(.subheadline.weight(.semibold))
        }
    }

    private var formattedDate: String {
        AppDateFormatter.absoluteMedium(frontmatter.startedAt)
    }

    private var platformIcon: String {
        switch frontmatter.platform {
        case "teams": return "video.fill"
        case "zoom":  return "video.circle.fill"
        case "mic":   return "mic.fill"
        default:      return "video.bubble.left.fill"
        }
    }
}

private extension Int {
    var durationString: String {
        if self < 60 { return "\(self)s" }
        let mins = self / 60
        if mins < 60 { return "\(mins) min" }
        let h = mins / 60; let m = mins % 60
        return m == 0 ? "\(h)h" : "\(h)h \(m)m"
    }
}
