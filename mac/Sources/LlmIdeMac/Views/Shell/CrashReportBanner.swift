import SwiftUI
import AppKit

/// One-time "LLM-IDE didn't close properly last time" notice, mounted at
/// the top of AppShell so it shows regardless of Welcome vs. active-project
/// state. Not built on StatusBanner — that component has no slot for a
/// secondary action button, and this needs a "View" alongside "Dismiss".
struct CrashReportBanner: View {
    let store: CrashReportStore

    @State private var showingDetail = false

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.orange)
                .font(.callout)
                .accessibilityHidden(true)
            Text(message)
                .font(.callout)
                .foregroundStyle(.primary)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button("View") { showingDetail = true }
                .buttonStyle(.link)
                .font(.callout)
            Button(action: store.dismissAll) {
                Image(systemName: "xmark")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Dismiss")
            .help("Dismiss")
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.orange.opacity(0.08))
        .sheet(isPresented: $showingDetail) {
            CrashReportDetailSheet(store: store) { showingDetail = false }
        }
    }

    private var message: String {
        let count = store.pendingCrashes.count
        return count == 1
            ? "LLM-IDE didn't close properly last time."
            : "LLM-IDE didn't close properly \(count) times since you last checked."
    }
}

/// Raw crash-log viewer — Copy, Reveal in Finder, and a Dismiss that
/// deletes every pending file (mirrors the banner's Dismiss).
private struct CrashReportDetailSheet: View {
    let store: CrashReportStore
    let onClose: () -> Void

    @State private var selectedId: String?

    private var selected: CrashReportFile? {
        store.pendingCrashes.first { $0.id == selectedId } ?? store.pendingCrashes.first
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            Text("Crash Report").font(Typography.title)

            if store.pendingCrashes.count > 1 {
                Picker("", selection: $selectedId) {
                    ForEach(store.pendingCrashes) { file in
                        Text(file.capturedAt.formatted(date: .abbreviated, time: .shortened))
                            .tag(Optional(file.id))
                    }
                }
                .labelsHidden()
                .pickerStyle(.menu)
            }

            ScrollView {
                Text(selected.map(store.contents) ?? "")
                    .font(Typography.mono)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(8)
            }
            .frame(minWidth: 480, minHeight: 260)
            .background(Color(NSColor.textBackgroundColor))
            .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Color.secondary.opacity(0.3), lineWidth: 1))
            .cornerRadius(6)

            HStack {
                Button("Reveal in Finder") {
                    if let selected {
                        NSWorkspace.shared.activateFileViewerSelecting([selected.url])
                    }
                }
                Button("Copy") {
                    if let selected {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(store.contents(of: selected), forType: .string)
                    }
                }
                Spacer()
                Button("Dismiss") {
                    store.dismissAll()
                    onClose()
                }
                .keyboardShortcut(.defaultAction)
            }
        }
        .padding(Spacing.md)
        .frame(width: 560)
        .onAppear { selectedId = store.pendingCrashes.first?.id }
    }
}
