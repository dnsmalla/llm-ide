import SwiftUI
import AppKit

struct MeetingDetailView: View {
    let api: LlmIdeAPIClient
    @Environment(ShellState.self) private var shell
    @Environment(AppEnvironment.self) private var env
    @EnvironmentObject var capture: CaptionOrchestrator
    @EnvironmentObject var theme: ThemeStore
    @State private var vm: MeetingDetailViewModel?
    @State private var meetingTitleDraft: String = ""
    @State private var recordingPulse = false
    @State private var isLoadingVM = false
    @State private var loadError: String?

    var body: some View {
        Group {
            if capture.isRunning || isPostStopBanner {
                recordingView
            } else if let vm, shell.selectedMeetingId != nil {
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

    // MARK: - Recording / post-stop view

    private var isPostStopBanner: Bool {
        if case .success = capture.lastIngestStatus { return true }
        if case .failure = capture.lastIngestStatus { return true }
        if case .ingesting = capture.lastIngestStatus { return true }
        return false
    }

    private var recordingView: some View {
        VStack(spacing: 0) {
            recordingBanner
            Divider()
            TranscriptView(api: api)
        }
    }

    private var recordingBanner: some View {
        HStack(spacing: 12) {
            // Pulsing indicator
            ZStack {
                if capture.isRunning {
                    Circle()
                        .fill(theme.current.danger.opacity(0.3))
                        .frame(width: 20, height: 20)
                        .scaleEffect(recordingPulse ? 1.5 : 1.0)
                        .animation(.easeInOut(duration: 0.8).repeatForever(autoreverses: true),
                                   value: recordingPulse)
                }
                Image(systemName: capture.isRunning ? "waveform" : "checkmark.circle.fill")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(capture.isRunning ? theme.current.danger : theme.current.accent3)
            }
            .onAppear { recordingPulse = true }
            .onDisappear { recordingPulse = false }

            if capture.isRunning {
                TextField("Meeting title…", text: $meetingTitleDraft)
                    .textFieldStyle(.roundedBorder)
                    .frame(maxWidth: 280)
                Button("Stop & Save") {
                    Task {
                        _ = await capture.stopAndIngest(api: api, meetingTitle: meetingTitleDraft)
                        meetingTitleDraft = ""
                    }
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.regular)
            } else if let copy = ingestStatusCopy {
                VStack(alignment: .leading, spacing: 2) {
                    Text(copy.text)
                        .font(.callout)
                        .foregroundStyle(copy.isError ? theme.current.danger : theme.current.textMuted)
                        .lineLimit(2)
                }
            }
            Spacer()
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(.regularMaterial)
    }

    private var ingestStatusCopy: (text: String, isError: Bool)? {
        switch capture.lastIngestStatus {
        case .idle:     return nil
        case .ingesting: return ("Saving…", false)
        case .success(let id, let dur):
            return ("Saved · summarizing in background (\(id.suffix(6)), \(dur)s)", false)
        case .failure(let msg):
            return (msg, true)
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

            Button(action: { shell.section = .plans }) {
                Label("Open in Plan", systemImage: "list.bullet.rectangle")
            }
            .disabled(vm?.frontmatter == nil)
            .help("Generate a plan from this meeting")
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
        (try? env.index.list().first?.id) == id
    }

    private func reload(for id: String?) async {
        guard let id, let row = try? env.index.get(id: id) else { vm = nil; return }
        loadError = nil
        isLoadingVM = true
        defer { isLoadingVM = false }
        let url = env.notesConfig.currentFolder.appendingPathComponent(row.path)
        let newVM = MeetingDetailViewModel(fileURL: url, api: api)
        do {
            try await newVM.load()
            vm = newVM
            // Just-mounted case for the Library list "Re-summarize" action:
            // the view model is now loaded for this id, so honor the flag.
            if shell.pendingResummarizeMeetingId == id {
                shell.pendingResummarizeMeetingId = nil
                await newVM.resummarize()
            }
        } catch {
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
    do {
        if FileManager.default.fileExists(atPath: dst.path) {
            try FileManager.default.removeItem(at: dst)
        }
        try FileManager.default.copyItem(at: src, to: dst)
    } catch {
        NSAlert(error: error).runModal()
    }
}
