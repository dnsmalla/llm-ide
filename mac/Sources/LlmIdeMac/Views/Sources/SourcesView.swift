import SwiftUI

/// "Inputs" hub — the single home for every source that feeds the Library.
///
/// Each source is a uniform add-on card (`InputSourceCard`): Meetings
/// (auto-captured), Email (fetched via the server and ingested through the
/// meeting pipeline), and a registry of planned sources shown as upcoming.
/// This is the only place input capture is *configured* — the old
/// Settings → "Capture" card was folded into the Meetings add-on here so
/// there is exactly one switch per setting. The `.live` section remains a
/// separate runtime view (the live transcript while recording).
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
    /// Meetings "Advanced" (poll interval) disclosure, collapsed by default.
    @State private var showMeetingAdvanced = false
    /// Handle for a manual "Fetch now" import so we can cancel it if the user
    /// navigates away mid-import (the `.task` auto-fetch already auto-cancels).
    @State private var importTask: Task<Void, Never>?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.lg) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Sources")
                        .font(Typography.title)
                        .foregroundStyle(theme.current.text)
                    Text("Connect the sources that feed your Library.")
                        .font(Typography.caption)
                        .foregroundStyle(theme.current.textMuted)
                }

                meetingsCard
                emailCard

                Text("More inputs")
                    .font(Typography.section)
                    .foregroundStyle(theme.current.textMuted)
                    .padding(.top, Spacing.sm)

                ForEach(InputSourceRegistry.planned) { src in
                    InputSourceCard(icon: src.icon, title: src.title,
                                    subtitle: src.subtitle,
                                    badgeText: "Coming soon", badgeTone: .neutral,
                                    isAvailable: false)
                }
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
        // `.task` auto-cancels when the view disappears.
        .task {
            if config.emailSource?.enabled == true {
                await runImport()
            }
        }
        // Cancel an in-flight manual import if we navigate away.
        .onDisappear { importTask?.cancel() }
    }

    // MARK: - Meetings add-on

    /// The single home for meeting capture config: the auto-capture toggle
    /// plus the poll interval (migrated here from the deleted Settings →
    /// Capture card). Drives `config.autoCaptureOnMeeting` / `pollIntervalMs`
    /// — the same properties the capture runtime reads, so behaviour is
    /// unchanged; only the config UI moved.
    private var meetingsCard: some View {
        InputSourceCard(
            icon: "waveform",
            title: "Meetings",
            subtitle: "Google Meet · Teams · Zoom",
            badgeText: config.autoCaptureOnMeeting ? "On" : "Off",
            badgeTone: config.autoCaptureOnMeeting ? .positive : .neutral
        ) {
            Toggle(isOn: $config.autoCaptureOnMeeting) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Auto-capture when a meeting app is frontmost")
                        .font(Typography.body)
                        .foregroundStyle(theme.current.text)
                    Text("Starts recording automatically once Zoom or Teams becomes the active app.")
                        .font(Typography.caption)
                        .foregroundStyle(theme.current.textMuted)
                }
            }
            .toggleStyle(.switch)

            DisclosureGroup(isExpanded: $showMeetingAdvanced) {
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Poll interval")
                            .font(Typography.body)
                            .foregroundStyle(theme.current.text)
                        Text("\(config.pollIntervalMs) ms — how often the scraper reads each meeting app's caption panel. Applies on next launch.")
                            .font(Typography.caption)
                            .foregroundStyle(theme.current.textMuted)
                    }
                    Spacer()
                    Stepper("\(config.pollIntervalMs)",
                            value: $config.pollIntervalMs,
                            in: 100...2000, step: 50)
                        .labelsHidden()
                        .controlSize(.small)
                }
                .padding(.top, Spacing.xs)
            } label: {
                Text("Advanced")
                    .font(Typography.caption)
                    .foregroundStyle(theme.current.textMuted)
            }
            .padding(.top, Spacing.xs)
        }
    }

    // MARK: - Email add-on

    private var emailCard: some View {
        let configured = config.emailSource != nil
        let enabled = config.emailSource?.enabled == true
        return InputSourceCard(
            icon: "envelope",
            title: "Email",
            subtitle: "Fetch messages and turn them into notes",
            badgeText: !configured ? "Not set up" : (enabled ? "Connected" : "Paused"),
            badgeTone: !configured ? .accent : (enabled ? .positive : .neutral)
        ) {
            if let s = config.emailSource {
                Text(s.user.isEmpty ? (s.displayName.isEmpty ? "Configured" : s.displayName) : s.user)
                    .font(Typography.body)
                    .foregroundStyle(theme.current.text)
            }

            HStack(spacing: Spacing.sm) {
                Button(configured ? "Edit…" : "Configure…") {
                    showingEmailSheet = true
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)

                if enabled {
                    Button(fetching ? "Fetching…" : "Fetch now") {
                        importTask = Task { await runImport() }
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
    }

    // MARK: - Helpers

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
        case .imported(let n, let moreAvailable, let oversize):
            lastEmailWasError = false
            lastEmailResult = "Imported \(n) new email\(n == 1 ? "" : "s")."
                + (moreAvailable > 0 ? " \(moreAvailable) more pending — Fetch again to continue." : "")
                + (oversize > 0 ? " \(oversize) skipped (too large)." : "")
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
