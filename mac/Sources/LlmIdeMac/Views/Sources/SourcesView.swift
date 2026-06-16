import SwiftUI

/// "Sources" section — lists the input sources that feed the Library.
/// Today: Meetings (auto-captured) and Email (fetched via the server and
/// ingested through the meeting pipeline). More sources are stubbed as a
/// muted footer note so the section reads as intentionally extensible.
struct SourcesView: View {
    let api: LlmIdeAPIClient
    @EnvironmentObject var config: AppConfig
    @EnvironmentObject var theme: ThemeStore
    @Environment(AppEnvironment.self) private var env

    @State private var showingEmailSheet = false
    @State private var fetching = false
    /// Short human-readable line shown under the Email card after a fetch.
    @State private var lastEmailResult: String?
    /// True when `lastEmailResult` describes an error (drives the colour).
    @State private var lastEmailWasError = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.lg) {
                Text("Sources")
                    .font(Typography.title)
                    .foregroundStyle(theme.current.textMuted)

                meetingsCard
                emailCard

                Text("More sources coming soon.")
                    .font(Typography.caption)
                    .foregroundStyle(theme.current.textMuted)
                    .padding(.top, Spacing.xs)
            }
            .padding(Spacing.lg)
            .frame(maxWidth: 720, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .center)
        }
        .background(theme.current.body)
        .navigationTitle("Sources")
        .sheet(isPresented: $showingEmailSheet) {
            EmailSourceSheet(api: api)
                .environmentObject(theme)
                .environmentObject(config)
        }
        // Light auto-fetch on appear (no global timer — periodic polling
        // can come later). Only runs when a source is configured + enabled.
        .task {
            if config.emailSource?.enabled == true {
                await runImport()
            }
        }
    }

    // MARK: - Meetings card

    /// Surfaces the existing auto-capture toggle — does NOT change capture
    /// behaviour, it just exposes `config.autoCaptureOnMeeting` here so the
    /// Sources view is the single place to reason about all inputs.
    private var meetingsCard: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            cardHeader(icon: "waveform", title: "Meetings (Google Meet · Teams · Zoom)")
            Text("Captured automatically during calls.")
                .font(Typography.caption)
                .foregroundStyle(theme.current.textMuted)

            Toggle(isOn: $config.autoCaptureOnMeeting) {
                Text("Auto-capture when a meeting app is frontmost")
                    .font(Typography.body)
            }
            .toggleStyle(.switch)
            .padding(.top, Spacing.xs)
        }
        .card(padding: Spacing.lg)
    }

    // MARK: - Email card

    private var emailCard: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            cardHeader(icon: "envelope", title: "Email")

            // Status line.
            if let s = config.emailSource {
                HStack(spacing: 6) {
                    Image(systemName: s.enabled ? "checkmark.circle.fill" : "pause.circle.fill")
                        .font(.system(size: 11))
                        .foregroundStyle(s.enabled ? theme.current.accent3 : theme.current.textMuted)
                    Text(s.user.isEmpty ? (s.displayName.isEmpty ? "Configured" : s.displayName) : s.user)
                        .font(Typography.body)
                        .foregroundStyle(theme.current.text)
                    if !s.enabled {
                        Text("(paused)")
                            .font(Typography.caption)
                            .foregroundStyle(theme.current.textMuted)
                    }
                }
            } else {
                Text("Not configured")
                    .font(Typography.body)
                    .foregroundStyle(theme.current.textMuted)
            }

            // Actions.
            HStack(spacing: Spacing.sm) {
                Button(config.emailSource == nil ? "Configure…" : "Edit…") {
                    showingEmailSheet = true
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)

                if let s = config.emailSource, s.enabled {
                    Button(fetching ? "Fetching…" : "Fetch now") {
                        Task { await runImport() }
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .disabled(fetching)
                    if fetching {
                        ProgressView().controlSize(.mini).scaleEffect(0.8)
                    }
                }
            }
            .padding(.top, Spacing.xs)

            if let line = lastEmailResult {
                Text(line)
                    .font(Typography.caption)
                    .foregroundStyle(lastEmailWasError ? theme.current.danger : theme.current.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .card(padding: Spacing.lg)
    }

    // MARK: - Helpers

    private func cardHeader(icon: String, title: String) -> some View {
        HStack(spacing: Spacing.sm) {
            Image(systemName: icon)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(theme.current.accent2)
            Text(title)
                .font(Typography.bodyStrong)
                .foregroundStyle(theme.current.text)
        }
    }

    /// Run the email import flow and reflect the outcome on the card.
    private func runImport() async {
        guard !fetching else { return }
        fetching = true
        defer { fetching = false }

        let service = SourceIngestService(
            api: api,
            config: config,
            root: env.notesConfig.currentFolder,
            notesOutputFolder: env.notesOutputFolder,
            indexer: env.indexer)
        switch await service.importNewEmails() {
        case .imported(let n):
            lastEmailWasError = false
            lastEmailResult = "Imported \(n) new email\(n == 1 ? "" : "s")."
        case .none:
            lastEmailWasError = false
            lastEmailResult = "No new emails."
        case .noSource:
            lastEmailWasError = false
            lastEmailResult = nil
        case .failure(let msg):
            lastEmailWasError = true
            lastEmailResult = "Fetch failed: \(msg)"
        }
    }
}
