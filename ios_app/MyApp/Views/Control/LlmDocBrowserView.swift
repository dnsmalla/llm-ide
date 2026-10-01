import SwiftUI
import SharedProtocol

/// Read-only browser for the Mac project's `llm-doc/` folder. Content only —
/// the caller supplies the navigation stack (Project tab or a sheet).
struct LlmDocBrowserView: View {
    /// `llm-doc`-relative directory; "" is the root.
    var path: String = ""
    @EnvironmentObject var connection: ConnectionService
    @EnvironmentObject var store: GenerationStore

    private var listing: LlmDocListing? { store.listings[path] }
    private var isConnected: Bool { connection.connectionStatus == .connected }

    var body: some View {
        List {
            if let listing {
                if let error = listing.error {
                    Section { Text(error).font(DesignSystem.Typography.footnoteFont)
                        .foregroundColor(DesignSystem.Colors.textTertiary) }
                } else if listing.entries.isEmpty {
                    Section { Text("Nothing here yet. Documents generated from the phone are saved in generated/.")
                        .font(DesignSystem.Typography.footnoteFont)
                        .foregroundColor(DesignSystem.Colors.textTertiary) }
                } else {
                    Section {
                        ForEach(listing.entries) { entry in
                            let child = path.isEmpty ? entry.name : path + "/" + entry.name
                            NavigationLink {
                                if entry.isDirectory {
                                    LlmDocBrowserView(path: child)
                                } else {
                                    LlmDocFileView(path: child)
                                }
                            } label: { row(entry) }
                        }
                    }
                }
            } else {
                Section {
                    HStack(spacing: DesignSystem.Spacing.sm) {
                        ProgressView()
                        Text(isConnected ? "Loading…" : "Connect to your Mac to browse llm-doc.")
                            .font(DesignSystem.Typography.footnoteFont)
                            .foregroundColor(DesignSystem.Colors.textTertiary)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, DesignSystem.Spacing.md)
                }
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(DesignSystem.Colors.background.ignoresSafeArea())
        .navigationTitle(path.isEmpty ? "llm-doc" : (path.split(separator: "/").last.map(String.init) ?? path))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { reload() } label: { Image(systemName: "arrow.clockwise") }
                    .accessibilityLabel("Refresh")
            }
        }
        .task { if listing == nil { store.list(path) } }
        .onChange(of: connection.connectionStatus) { status in
            if status == .connected { reload() }
        }
        .refreshable { reload() }
    }

    private func reload() {
        guard isConnected else { return }
        store.invalidate(path)
        store.list(path)
    }

    private func row(_ entry: LlmDocEntry) -> some View {
        HStack(spacing: DesignSystem.Spacing.sm) {
            Image(systemName: entry.isDirectory ? "folder.fill" : "doc.text")
                .foregroundColor(DesignSystem.Colors.primary)
                .frame(width: 24)
            VStack(alignment: .leading, spacing: 2) {
                Text(entry.name)
                    .font(DesignSystem.Typography.bodyFont)
                    .foregroundColor(DesignSystem.Colors.textPrimary)
                    .lineLimit(1)
                if !entry.isDirectory {
                    Text("\(ByteCountFormatter.string(fromByteCount: Int64(entry.size), countStyle: .file)) · \(Date(epochSeconds: entry.modified).relativeTimeShort())")
                        .font(DesignSystem.Typography.captionFont)
                        .foregroundColor(DesignSystem.Colors.textTertiary)
                }
            }
        }
    }
}

/// One document from `llm-doc/`, rendered as Markdown.
struct LlmDocFileView: View {
    let path: String
    @EnvironmentObject var connection: ConnectionService
    @EnvironmentObject var store: GenerationStore

    private var file: LlmDocFile? { store.files[path] }

    var body: some View {
        ScrollView {
            if let file {
                if let error = file.error {
                    Text(error)
                        .font(DesignSystem.Typography.footnoteFont)
                        .foregroundColor(DesignSystem.Colors.textTertiary)
                        .padding(DesignSystem.Spacing.md)
                } else if let text = file.text {
                    VStack(alignment: .leading, spacing: DesignSystem.Spacing.sm) {
                        if file.truncated {
                            Label("Long file — showing the first part.", systemImage: "scissors")
                                .font(DesignSystem.Typography.captionFont)
                                .foregroundColor(DesignSystem.Colors.textTertiary)
                        }
                        MarkdownDocumentView(text: text)
                    }
                    .padding(DesignSystem.Spacing.md)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            } else {
                ProgressView().padding(.top, 60).frame(maxWidth: .infinity)
            }
        }
        .background(DesignSystem.Colors.background.ignoresSafeArea())
        .navigationTitle(path.split(separator: "/").last.map(String.init) ?? path)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if let text = file?.text {
                ToolbarItem(placement: .topBarTrailing) {
                    ShareLink(item: text) { Image(systemName: "square.and.arrow.up") }
                        .accessibilityLabel("Share document")
                }
            }
        }
        .task { if file == nil { store.read(path) } }
    }
}

/// Markdown text with fenced code kept verbatim, using the chat's renderer
/// (`ChatMarkdown` segments + `ChatBubble.inlineMarkdown`).
struct MarkdownDocumentView: View {
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(ChatMarkdown.segments(from: text).enumerated()), id: \.offset) { _, segment in
                switch segment {
                case .prose(let prose):
                    Text(ChatBubble.inlineMarkdown(prose))
                        .font(DesignSystem.Typography.bodyFont)
                        .foregroundColor(DesignSystem.Colors.textPrimary)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                case .code(_, let body):
                    ScrollView(.horizontal, showsIndicators: false) {
                        Text(body)
                            .font(DesignSystem.Typography.footnoteFont.monospaced())
                            .foregroundColor(DesignSystem.Colors.textPrimary)
                            .textSelection(.enabled)
                    }
                    .padding(DesignSystem.Spacing.sm)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(DesignSystem.Colors.surfaceSecondary, in: RoundedRectangle(cornerRadius: 8))
                }
            }
        }
    }
}
