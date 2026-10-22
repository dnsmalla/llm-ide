import SwiftUI
import AppKit

struct MeetingDetailView: View {
    let api: LlmIdeAPIClient
    @Environment(ShellState.self) private var shell
    @Environment(AppEnvironment.self) private var env
    @EnvironmentObject var theme: ThemeStore
    @State private var vm: MeetingDetailViewModel?
    @State private var isLoadingVM = false
    @State private var loadError: String?
    /// Bumped by every `reload(for:)`; only the newest reload may publish
    /// its result or clear the loading state.
    @State private var reloadGeneration = 0
    /// Cached newest meeting id; `isNewest` used to list the whole index on
    /// every render.  Refreshed in `reload(for:)`, which runs on every
    /// selection change and every `.meetingIndexChanged`.
    @State private var newestMeetingId: String?

    var body: some View {
        // A running capture (or its post-stop ingest banner) takes the pane
        // over. Live owns that view and the decision, behind the Core seam,
        // so Library never names Live's `CaptionOrchestrator`/`TranscriptView`.
        LiveCaptureGate(api: api) {
            if let vm, shell.selectedMeetingId != nil {
                detailContent(vm: vm)
            } else if isLoadingVM {
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let err = loadError {
                Text(err)
                    .font(Typography.caption)
                    .foregroundStyle(theme.current.danger)
                    .padding()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                placeholderView
            }
        }
        .onChange(of: shell.selectedMeetingId) { _, newId in
            Task { await reload(for: newId) }
        }
        .onReceive(NotificationCenter.default.publisher(for: .meetingIndexChanged)) { _ in
            Task { await reload(for: shell.selectedMeetingId) }
        }
        // Library list "Re-summarize" already-open case: when the flagged
        // meeting is the one currently loaded, run now. The just-mounted case
        // is handled in reload(for:) after the view model loads. (Export from
        // the list is handled by LibraryView, which is always mounted.)
        .onChange(of: shell.pendingResummarizeMeetingId) { _, pending in
            guard let pending, pending == shell.selectedMeetingId, let vm else { return }
            shell.pendingResummarizeMeetingId = nil
            Task { await vm.resummarize() }
        }
        .toolbar { toolbarContent }
    }

    // MARK: - Placeholder

    private var placeholderView: some View {
        ContentUnavailableView {
            Label("Select a Meeting", systemImage: "doc.text")
        } description: {
            Text("Choose a meeting from the list to view its summary and transcript.")
        }
    }

    // MARK: - Detail content

    @ViewBuilder
    private func detailContent(vm: MeetingDetailViewModel) -> some View {
        switch vm.state {
        case .loading:
            loadingShimmer
        case .error(let msg):
            ContentUnavailableView {
                Label("Couldn't Open Meeting", systemImage: "exclamationmark.triangle")
            } description: {
                Text(msg)
            } actions: {
                Button("Retry") { Task { try? await vm.load() } }
                    .buttonStyle(.borderedProminent)
            }
        case .idle, .loaded:
            if let fm = vm.frontmatter {
                VStack(spacing: 0) {
                    if case .error(let msg) = vm.state {
                        HStack(spacing: 10) {
                            StatusBanner(severity: .warning, message: msg)
                            Button("Retry") { Task { await vm.resummarize() } }
                                .buttonStyle(.bordered)
                                .controlSize(.small)
                        }
                        .padding(.horizontal, 16)
                        .padding(.vertical, 10)
                        Divider()
                    }
                    if vm.summarizing {
                        summarizingBanner
                    } else if needsBackfill(fm, vm: vm) {
                        backfillBanner(vm: vm)
                    }
                    SummarySections(frontmatter: fm,
                                    summaryMarkdown: vm.summarySectionMarkdown,
                                    transcript: vm.transcript,
                                    isNewest: isNewest(id: shell.selectedMeetingId ?? ""))
                        .navigationTitle(fm.title.isEmpty ? "Untitled" : fm.title)
                        .navigationSubtitle(navSubtitle(fm))
                }
            }
        }
    }

    // MARK: - Banners

    @ViewBuilder
    private var summarizingBanner: some View {
        HStack(spacing: 10) {
            ProgressView().controlSize(.small)
            Text("Generating summary…")
                .font(.callout)
                .foregroundStyle(.secondary)
            Spacer()
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(.regularMaterial)
        Divider()
    }

    private func backfillBanner(vm: MeetingDetailViewModel) -> some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                Image(systemName: "sparkles")
                    .foregroundStyle(.tint)
                Text("Transcript available — no summary yet.")
                    .font(.callout)
                Spacer()
                Button {
                    Task { await vm.resummarize() }
                } label: {
                    Label("Summarize", systemImage: "sparkles")
                        .font(.callout)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .background(.regularMaterial)
            Divider()
        }
    }

    // MARK: - Loading shimmer

    private var loadingShimmer: some View {
        VStack(alignment: .leading, spacing: 16) {
            shimmerLine(width: 180, height: 14)
            shimmerLine(width: 120, height: 11)
            Divider().padding(.vertical, 4)
            shimmerLine(width: 260, height: 13)
            shimmerLine(width: 220, height: 13)
            shimmerLine(width: 200, height: 13)
            Divider().padding(.vertical, 4)
            shimmerLine(width: 300, height: 12)
            shimmerLine(width: 280, height: 12)
            shimmerLine(width: 240, height: 12)
        }
        .padding(20)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private func shimmerLine(width: CGFloat, height: CGFloat) -> some View {
        RoundedRectangle(cornerRadius: height / 2)
            .fill(.quaternary)
            .frame(width: width, height: height)
    }

    // MARK: - Toolbar

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        ToolbarItemGroup(placement: .primaryAction) {
            Button {
                Task { await vm?.resummarize() }
            } label: {
                Label("Re-summarize", systemImage: "sparkles")
            }
            .disabled(vm?.frontmatter == nil || (vm?.summarizing ?? false))
            .keyboardShortcut("r", modifiers: .command)
            .help("Re-summarize this meeting (⌘R)")

            Button(action: { exportMeeting(id: shell.selectedMeetingId) }) {
                Label("Export", systemImage: "square.and.arrow.up")
            }
            .disabled(vm?.frontmatter == nil)
            .keyboardShortcut("e", modifiers: .command)
            .help("Export as Markdown (⌘E)")
        }
    }

    // MARK: - Helpers

    private func navSubtitle(_ fm: MeetingFrontmatter) -> String {
        let date = AppDateFormatter.absoluteMedium(fm.startedAt)
        if let d = fm.durationSeconds, d > 0 {
            return "\(date) · \(d / 60) min"
        }
        return date
    }

    private func needsBackfill(_ fm: MeetingFrontmatter, vm: MeetingDetailViewModel) -> Bool {
        (fm.gist ?? "").isEmpty && fm.tldr.isEmpty
            && (vm.transcript ?? "").isEmpty == false
    }

    private func isNewest(id: String) -> Bool {
        newestMeetingId == id
    }

    private func reload(for id: String?) async {
        reloadGeneration += 1
        let generation = reloadGeneration
        newestMeetingId = try? env.index.list().first?.id
        guard let id, let row = try? env.index.get(id: id) else {
            // This load supersedes an in-flight one, whose `defer` will now
            // skip clearing the spinner — clear it here or it spins forever.
            vm = nil
            isLoadingVM = false
            loadError = nil
            return
        }
        loadError = nil
        let url = env.notesConfig.currentFolder.appendingPathComponent(row.path)
        // Same meeting (index refresh, e.g. after a summarize finished):
        // refresh the existing view model in place.  Replacing it would drop
        // its state mid-run and briefly blank the pane.
        if let current = vm, current.fileURL == url {
            try? await current.load()
            return
        }
        // Different meeting: drop the old view model now, so the toolbar
        // and banners can't act on meeting A while B is loading.
        vm = nil
        isLoadingVM = true
        defer {
            if generation == reloadGeneration { isLoadingVM = false }
        }
        let newVM = MeetingDetailViewModel(fileURL: url, api: api)
        do {
            try await newVM.load()
            // A slower load for an EARLIER selection (or an older reload of
            // the same one) must not land after a newer one: it would show
            // meeting A under B's selected row, and Re-summarize / Export
            // would act on the wrong file.
            guard generation == reloadGeneration, shell.selectedMeetingId == id else { return }
            vm = newVM
            // Just-mounted case for the Library list "Re-summarize" action:
            // the view model is now loaded for this id, so honor the flag.
            if shell.pendingResummarizeMeetingId == id {
                shell.pendingResummarizeMeetingId = nil
                await newVM.resummarize()
            }
        } catch {
            guard generation == reloadGeneration, shell.selectedMeetingId == id else { return }
            loadError = error.localizedDescription
            vm = nil
        }
    }

    private func exportMeeting(id: String?) {
        presentMeetingExportPanel(id: id, env: env)
    }
}

/// Shared "save this meeting as Markdown" panel — used by the meeting detail's
/// toolbar/menu and by the Library list's Export context action (LibraryView,
/// which is always mounted, unlike the detail pane). Self-contained: resolves
/// the file from the index, so it needs no meeting view model.
@MainActor
func presentMeetingExportPanel(id: String?, env: AppEnvironment) {
    guard let id, let row = try? env.index.get(id: id) else { return }
    let src = env.notesConfig.currentFolder.appendingPathComponent(row.path)
    let panel = NSSavePanel()
    panel.allowedContentTypes = [.plainText]
    panel.nameFieldStringValue = src.lastPathComponent
    panel.title = "Export Meeting"
    panel.message = "Save this meeting as a Markdown file"
    guard panel.runModal() == .OK, let dst = panel.url else { return }
    // Replacing the source with itself would delete the meeting before the
    // copy fails (same path, symlink or hardlink to it).
    guard dst.resolvingSymlinksInPath() != src.resolvingSymlinksInPath() else {
        NSAlert(error: CocoaError(.fileWriteFileExists)).runModal()
        return
    }
    do {
        if FileManager.default.fileExists(atPath: dst.path) {
            try FileManager.default.removeItem(at: dst)
        }
        try FileManager.default.copyItem(at: src, to: dst)
    } catch {
        NSAlert(error: error).runModal()
    }
}
