import SwiftUI
import SharedProtocol

/// The Mac project's GitHub/GitLab issues. Read-only unless the Mac has "Comment on issues" on;
/// closing, editing and deleting aren't available from the phone.
struct IssuesView: View {
    @EnvironmentObject var connection: ConnectionService
    @EnvironmentObject var store: IssuesStore

    var body: some View {
        List {
            Section {
                Picker("State", selection: Binding(get: { store.filter }, set: { store.setFilter($0) })) {
                    Text("Open").tag("opened"); Text("Closed").tag("closed"); Text("All").tag("all")
                }
                .pickerStyle(.segmented)
            }
            if let s = store.list {
                if !s.available {
                    Section { Text(s.error ?? "No GitHub or GitLab project is connected on the Mac.")
                        .font(DesignSystem.Typography.footnoteFont).foregroundColor(DesignSystem.Colors.textTertiary) }
                } else if let error = s.error {
                    Section { Label(error, systemImage: "exclamationmark.triangle.fill")
                        .font(DesignSystem.Typography.footnoteFont).foregroundColor(DesignSystem.Colors.danger) }
                } else if s.issues.isEmpty {
                    Section { Text("No issues.").font(DesignSystem.Typography.footnoteFont)
                        .foregroundColor(DesignSystem.Colors.textTertiary) }
                } else {
                    Section(s.provider ?? "Issues") {
                        ForEach(s.issues) { issue in
                            NavigationLink { IssueDetailView(number: issue.number, fallback: issue) } label: { row(issue) }
                        }
                    }
                }
            } else {
                Section {
                    if let error = store.loadError {
                        Text(error).font(DesignSystem.Typography.footnoteFont).foregroundColor(DesignSystem.Colors.textTertiary)
                    } else {
                        HStack(spacing: DesignSystem.Spacing.sm) {
                            ProgressView()
                            Text(connection.connectionStatus == .connected ? "Loading issues…" : "Connect to your Mac.")
                                .font(DesignSystem.Typography.footnoteFont).foregroundColor(DesignSystem.Colors.textTertiary)
                        }
                        .frame(maxWidth: .infinity).padding(.vertical, DesignSystem.Spacing.md)
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(DesignSystem.Colors.background.ignoresSafeArea())
        .navigationTitle("Issues")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { store.list = nil; store.refresh() } label: { Image(systemName: "arrow.clockwise") }
                    .accessibilityLabel("Refresh issues")
            }
        }
        .refreshable { store.refresh() }
        .task { store.refresh() }
        .onChange(of: connection.connectionStatus) { status in
            if status == .connected, store.list == nil { store.refresh() }
        }
    }

    private func row(_ i: IssueSummary) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline) {
                Image(systemName: i.state == "opened" ? "circle.dotted" : "checkmark.circle.fill")
                    .foregroundColor(i.state == "opened" ? DesignSystem.Colors.success : DesignSystem.Colors.textTertiary)
                Text(i.title).font(DesignSystem.Typography.bodyFont).lineLimit(2)
            }
            HStack(spacing: 8) {
                Text("#\(i.number)").font(DesignSystem.Typography.captionFont.monospacedDigit())
                if let who = i.assignee { Label(who, systemImage: "person").font(DesignSystem.Typography.captionFont) }
                if i.commentCount > 0 { Label("\(i.commentCount)", systemImage: "text.bubble").font(DesignSystem.Typography.captionFont) }
                ForEach(i.labels.prefix(3), id: \.self) { label in
                    Text(label).font(DesignSystem.Typography.captionFont)
                        .padding(.horizontal, 6).padding(.vertical, 1)
                        .background(DesignSystem.Colors.surfaceSecondary, in: Capsule())
                }
            }
            .foregroundColor(DesignSystem.Colors.textTertiary)
        }
        .padding(.vertical, 2)
    }
}

struct IssueDetailView: View {
    let number: Int
    let fallback: IssueSummary
    @EnvironmentObject var store: IssuesStore
    @EnvironmentObject var connection: ConnectionService
    @State private var draft = ""

    private var detail: IssueDetail? { store.details[number] }

    var body: some View {
        List {
            if let d = detail, d.error == nil || !d.title.isEmpty {
                Section {
                    Text(d.title).font(DesignSystem.Typography.headlineFont)
                    HStack {
                        Text(d.state == "opened" ? "Open" : "Closed").font(DesignSystem.Typography.captionFont.weight(.semibold))
                            .padding(.horizontal, 8).padding(.vertical, 2)
                            .background((d.state == "opened" ? DesignSystem.Colors.success : DesignSystem.Colors.textTertiary).opacity(0.15), in: Capsule())
                        Text("#\(d.number) by \(d.author)").font(DesignSystem.Typography.captionFont)
                            .foregroundColor(DesignSystem.Colors.textTertiary)
                    }
                    if !d.labels.isEmpty { Text(d.labels.joined(separator: " · ")).font(DesignSystem.Typography.captionFont)
                        .foregroundColor(DesignSystem.Colors.textSecondary) }
                    if let url = d.webUrl.flatMap(URL.init(string:)) {
                        Link(destination: url) { Label("Open in browser", systemImage: "safari") }
                    }
                }
                if let body = d.body { Section("Description") { MarkdownDocumentView(text: body) } }
                if let message = d.message { Section { Label(message, systemImage: "checkmark.circle.fill")
                    .font(DesignSystem.Typography.footnoteFont).foregroundColor(DesignSystem.Colors.success) } }
                if let error = d.error { Section { Label(error, systemImage: "exclamationmark.triangle.fill")
                    .font(DesignSystem.Typography.footnoteFont).foregroundColor(DesignSystem.Colors.danger) } }
                if !d.comments.isEmpty {
                    Section("Comments (\(d.comments.count))") {
                        ForEach(d.comments) { note in
                            VStack(alignment: .leading, spacing: 4) {
                                Text(note.author).font(DesignSystem.Typography.captionFont.weight(.semibold))
                                MarkdownDocumentView(text: note.body)
                            }
                        }
                    }
                }
                commentSection(d)
            } else if let d = detail, let error = d.error {
                Section { Text(error).font(DesignSystem.Typography.footnoteFont).foregroundColor(DesignSystem.Colors.danger) }
            } else {
                Section {
                    Text(fallback.title).font(DesignSystem.Typography.headlineFont)
                    HStack(spacing: DesignSystem.Spacing.sm) { ProgressView()
                        Text("Loading…").font(DesignSystem.Typography.footnoteFont).foregroundColor(DesignSystem.Colors.textTertiary) }
                }
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(DesignSystem.Colors.background.ignoresSafeArea())
        .navigationTitle("#\(number)")
        .navigationBarTitleDisplayMode(.inline)
        .task { store.loadDetail(number) }
        .refreshable { store.loadDetail(number) }
        .onChange(of: connection.connectionStatus) { status in
            if status == .connected, store.details[number] == nil { store.loadDetail(number) }
        }
        // Keep what was typed until the Mac confirms the post; only a success clears it.
        .onChange(of: store.details[number]?.message) { message in
            if message == "Comment posted." { draft = "" }
        }
    }

    @ViewBuilder
    private func commentSection(_ d: IssueDetail) -> some View {
        Section {
            if d.canComment {
                TextField("Add a comment…", text: $draft, axis: .vertical).lineLimit(1...6)
                Button {
                    let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !text.isEmpty else { return }
                    store.post(text, to: number)
                    haptic(.light)
                } label: {
                    if store.isPosting { ProgressView() } else { Label("Post comment", systemImage: "paperplane") }
                }
                .disabled(store.isPosting || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            } else {
                Label("Commenting is off. Enable “Comment on issues” in the Mac's Settings → Mobile Control → Phone access.",
                      systemImage: "lock").font(DesignSystem.Typography.footnoteFont)
                    .foregroundColor(DesignSystem.Colors.textTertiary)
            }
        } footer: {
            if d.canComment { Text("Posts as you on \(d.webUrl.flatMap { URL(string: $0)?.host } ?? "the tracker"). Closing and editing stay on the Mac.") }
        }
    }
}
