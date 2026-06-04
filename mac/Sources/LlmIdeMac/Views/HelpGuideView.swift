import SwiftUI

/// Full-screen help guide presented as a sheet from the sidebar
/// profile menu. Covers every major section of the app with
/// gentle explanations for new users.
struct HelpGuideView: View {
    @EnvironmentObject var theme: ThemeStore
    let onDismiss: () -> Void

    @State private var selected: HelpTopic = .gettingStarted

    var body: some View {
        let t = theme.current
        NavigationSplitView {
            List(HelpTopic.allCases, id: \.self, selection: $selected) { topic in
                Label {
                    Text(topic.title)
                } icon: {
                    Image(systemName: topic.icon)
                        .foregroundStyle(topic.tint)
                }
            }
            .listStyle(.sidebar)
            .navigationSplitViewColumnWidth(min: 160, ideal: 190, max: 240)
        } detail: {
            ScrollView {
                VStack(alignment: .leading, spacing: Spacing.lg) {
                    topicContent(selected)
                }
                .padding(Spacing.xl)
                .frame(maxWidth: 620, alignment: .leading)
                .frame(maxWidth: .infinity, alignment: .center)
            }
            .background(t.body)
        }
        .frame(minWidth: 700, idealWidth: 820, maxWidth: 1000,
               minHeight: 500, idealHeight: 620, maxHeight: 800)
        .background(t.body)
        .overlay(alignment: .topTrailing) {
            Button { onDismiss() } label: {
                Image(systemName: "xmark.circle.fill")
                    .font(.system(size: 18))
                    .foregroundStyle(t.textMuted)
            }
            .buttonStyle(.plain)
            .padding(12)
            .help("Close help")
            .keyboardShortcut(.escape, modifiers: [])
        }
    }

    // MARK: - Topic content

    @ViewBuilder
    private func topicContent(_ topic: HelpTopic) -> some View {
        switch topic {
        case .gettingStarted:  gettingStartedContent
        case .library:         libraryContent
        case .live:            liveContent
        case .reviewCode:      reviewCodeContent
        case .reviewDoc:       reviewDocContent
        case .issues:          issuesContent
        case .gantt:           ganttContent
        case .docGen:          docGenContent
        case .autoTasks:       autoTasksContent
        case .codeGraph:        codeGraphContent
        case .regression:      regressionContent
        case .settings:        settingsContent
        case .shortcuts:       shortcutsContent
        case .troubleshooting: troubleshootingContent
        }
    }

    // MARK: - Getting Started

    private var gettingStartedContent: some View {
        VStack(alignment: .leading, spacing: Spacing.lg) {
            helpHeader("Welcome to LLM IDE", icon: "hand.wave", tint: .blue)

            helpParagraph("LLM IDE captures live meeting captions from Zoom and Microsoft Teams, then uses AI to generate structured notes, action items, and summaries — so you can focus on the conversation instead of typing.")

            helpCard("How it works", icon: "arrow.triangle.2.circlepath") {
                helpStep(1, "Open a meeting in Zoom or Teams on your Mac")
                helpStep(2, "Click Record in the sidebar to start capturing captions")
                helpStep(3, "When the meeting ends, click Stop — notes are generated automatically")
                helpStep(4, "Find your notes in the Library, ready to review, edit, or export")
            }

            helpCard("First-time setup", icon: "checkmark.seal") {
                helpBullet("Grant Accessibility permission so the app can read captions from meeting windows")
                helpBullet("Sign in with your LLM IDE account (your admin provides the server URL)")
                helpBullet("Create or open a project — this is where your notes will be saved")
            }

            helpTip("You can also capture meetings from the Chrome extension for Google Meet, Teams Web, and Zoom Web. The Mac app and extension share the same account and server.")
        }
    }

    // MARK: - Library

    private var libraryContent: some View {
        VStack(alignment: .leading, spacing: Spacing.lg) {
            helpHeader("Library", icon: "books.vertical", tint: .blue)

            helpParagraph("The Library is your home base. It shows every meeting note, document, agent persona, and plugin in your current project — all in one searchable list.")

            helpCard("What you'll find here", icon: "tray.full") {
                helpBullet("Meeting notes — each meeting gets its own markdown file with a timestamp, transcript excerpt, and AI-generated summary")
                helpBullet("Documents — any extra markdown or text files in your project folder")
                helpBullet("Agent personas — the AI assistant's personality and instruction set")
                helpBullet("Plugins — optional extensions that add new capabilities")
            }

            helpCard("Tips", icon: "lightbulb") {
                helpBullet("Use ⌘F to focus the search bar and quickly filter by title or date")
                helpBullet("Click any meeting row to open the full note with transcript, summary, and action items")
                helpBullet("Right-click a meeting to re-summarize, export, or reveal the file in Finder")
            }
        }
    }

    // MARK: - Live

    private var liveContent: some View {
        VStack(alignment: .leading, spacing: Spacing.lg) {
            helpHeader("Live Capture", icon: "waveform", tint: .red)

            helpParagraph("The Live page shows a real-time transcript while you're recording a meeting. Captions appear as they're spoken — you can watch the conversation unfold without switching windows.")

            helpCard("How to start a live session", icon: "play.circle") {
                helpStep(1, "Join your meeting in Zoom or Teams")
                helpStep(2, "Make sure captions/subtitles are turned on in the meeting app")
                helpStep(3, "Click the Record button in the sidebar footer")
                helpStep(4, "The Live tab appears automatically with a red dot indicator")
            }

            helpCard("During the session", icon: "text.bubble") {
                helpBullet("Captions scroll in real time — the app reads them from the meeting window via Accessibility APIs")
                helpBullet("Speaker names are detected automatically when the platform provides them")
                helpBullet("You can minimize LLM IDE — capture continues in the background")
            }

            helpTip("When the Chrome extension is capturing a web meeting, the Live page mirrors that remote session too — you'll see captions from Google Meet, Teams Web, or Zoom Web in real time.")

            helpWarning("Don't close the meeting window while recording. The app needs the captions to be visible (even if the window is behind other windows).")
        }
    }

    // MARK: - Review Code

    private var reviewCodeContent: some View {
        VStack(alignment: .leading, spacing: Spacing.lg) {
            helpHeader("Review Code", icon: "checkmark.shield", tint: .green)

            helpParagraph("Paste a merge request or pull request URL, and the AI reviews the diff — highlighting potential bugs, style issues, missing tests, and security concerns.")

            helpCard("How to use it", icon: "doc.text.magnifyingglass") {
                helpStep(1, "Link your project to a GitLab or GitHub repository in Settings")
                helpStep(2, "Open Review Code from the sidebar")
                helpStep(3, "Paste an MR/PR URL or select from recent merge requests")
                helpStep(4, "The AI reads the diff and returns a structured review with severity ratings")
            }

            helpTip("Reviews are saved in your project so you can revisit them later. Great for async code review workflows.")
        }
    }

    // MARK: - Review Doc

    private var reviewDocContent: some View {
        VStack(alignment: .leading, spacing: Spacing.lg) {
            helpHeader("Review Doc", icon: "doc.text.magnifyingglass", tint: .orange)

            helpParagraph("Upload or paste a design document, RFC, or technical spec — the AI reviews it for clarity, completeness, logical gaps, and feasibility.")

            helpCard("Great for", icon: "star") {
                helpBullet("Design docs and architecture proposals")
                helpBullet("Product requirement documents (PRDs)")
                helpBullet("RFCs and technical specifications")
                helpBullet("Migration and rollout plans")
            }

            helpTip("The AI flags questions a reviewer would ask — ambiguous scope, missing error handling, unclear rollback plans — so you can strengthen the doc before sharing it with the team.")
        }
    }

    // MARK: - Issues

    private var issuesContent: some View {
        VStack(alignment: .leading, spacing: Spacing.lg) {
            helpHeader("Issues", icon: "checklist", tint: .purple)

            helpParagraph("A kanban-style board that syncs with your linked GitLab or GitHub repository. View, create, and manage issues without leaving LLM IDE.")

            helpCard("Features", icon: "rectangle.3.group") {
                helpBullet("Drag-and-drop columns — To Do, In Progress, Done")
                helpBullet("Create issues directly from meeting action items")
                helpBullet("Filter by assignee, label, or milestone")
                helpBullet("Changes sync back to your remote repository")
            }
        }
    }

    // MARK: - Gantt

    private var ganttContent: some View {
        VStack(alignment: .leading, spacing: Spacing.lg) {
            helpHeader("Gantt", icon: "chart.bar.doc.horizontal", tint: .indigo)

            helpParagraph("A timeline view of your project's milestones and issues. Useful for sprint planning and understanding how work is distributed over time.")

            helpCard("How it works", icon: "calendar") {
                helpBullet("Issues with due dates appear as bars on the timeline")
                helpBullet("Milestones group related issues together")
                helpBullet("Zoom in/out to see days, weeks, or months at a glance")
            }

            helpTip("Link your repo in Settings first — the Gantt chart pulls milestone and issue data from GitLab or GitHub.")
        }
    }

    // MARK: - Doc Gen

    private var docGenContent: some View {
        VStack(alignment: .leading, spacing: Spacing.lg) {
            helpHeader("Doc Gen", icon: "wand.and.stars", tint: .pink)

            helpParagraph("Generate documentation from your codebase automatically. Point it at source files and the AI produces markdown docs covering modules, functions, and usage examples.")

            helpCard("Use cases", icon: "doc.richtext") {
                helpBullet("API reference docs from source code")
                helpBullet("README generation for new modules")
                helpBullet("Onboarding guides for team members joining the project")
            }
        }
    }

    // MARK: - Auto Tasks

    private var autoTasksContent: some View {
        VStack(alignment: .leading, spacing: Spacing.lg) {
            helpHeader("Auto Tasks", icon: "arrow.triangle.2.circlepath.circle", tint: .teal)

            helpParagraph("Automate recurring development tasks. Define a task once — like running tests, linting, or generating changelogs — and Auto Tasks runs it on a schedule or when triggered by an event.")

            helpCard("Examples", icon: "list.bullet.rectangle") {
                helpBullet("Auto-generate release notes when a new tag is pushed")
                helpBullet("Run a code style check before every commit")
                helpBullet("Sync meeting notes to a shared wiki nightly")
            }

            helpTip("Configure Auto Tasks in Settings → Auto Code. Each task has its own schedule and trigger conditions.")
        }
    }

    // MARK: - Code Graph

    private var codeGraphContent: some View {
        VStack(alignment: .leading, spacing: Spacing.lg) {
            helpHeader("Code Graph", icon: "point.3.connected.trianglepath.dotted", tint: .cyan)

            helpParagraph("Visualize your codebase as an interactive knowledge graph powered by Understand-Anything. Nodes represent files, functions, or modules — edges show how they connect. Great for understanding unfamiliar repos or spotting architectural patterns.")

            helpCard("How to build a graph", icon: "hammer") {
                helpStep(1, "Open Code Graph from the sidebar")
                helpStep(2, "Select a folder or file set to analyze")
                helpStep(3, "The AI parses the code and builds a graph of relationships")
                helpStep(4, "Explore — click nodes to see details, drag to rearrange, zoom to focus")
            }

            helpTip("Understand-Anything works best with well-structured projects. Try starting with a single module to see how the graph looks before analyzing the full repo.")
        }
    }

    // MARK: - Regression

    private var regressionContent: some View {
        VStack(alignment: .leading, spacing: Spacing.lg) {
            helpHeader("Regression", icon: "arrow.uturn.backward.circle", tint: .orange)

            helpParagraph("Run regression checks against your codebase. The AI compares the current state of your code against previous snapshots to detect unintended changes, broken contracts, or missing functionality.")

            helpCard("When to use it", icon: "exclamationmark.shield") {
                helpBullet("After a large refactor — make sure nothing was accidentally removed")
                helpBullet("Before a release — verify that known critical paths still work")
                helpBullet("When onboarding — understand what changed since you last looked at the code")
            }
        }
    }

    // MARK: - Settings

    private var settingsContent: some View {
        VStack(alignment: .leading, spacing: Spacing.lg) {
            helpHeader("Settings", icon: "gearshape", tint: .gray)

            helpParagraph("Settings is split into two groups: App settings that apply everywhere, and Project settings that are specific to the currently open project.")

            helpCard("App settings", icon: "macwindow") {
                helpBullet("Account — view your profile and sign out")
                helpBullet("Server — configure which LLM IDE server to connect to")
                helpBullet("Backend — choose AI providers and models for note generation")
                helpBullet("Appearance — switch between light, dark, and system themes")
                helpBullet("Sidebar — show or hide sidebar sections you don't use")
                helpBullet("Capture — configure how captions are captured (Accessibility settings)")
                helpBullet("Updates — check for app updates (powered by Sparkle)")
            }

            helpCard("Project settings", icon: "folder.badge.gearshape") {
                helpBullet("Paths — where your project files and notes are stored")
                helpBullet("GitLab / GitHub — link a remote repository for code review and issues")
                helpBullet("CLI — choose between Claude Code, Cursor, or other AI coding tools")
                helpBullet("Preferences — language, auto-dispatch, and note formatting options")
                helpBullet("Auto Code — configure automated tasks and triggers")
                helpBullet("Plugins — enable or disable plugin extensions")
            }

            helpTip("Press ⌘, (comma) from anywhere to jump straight to Settings.")
        }
    }

    // MARK: - Shortcuts

    private var shortcutsContent: some View {
        VStack(alignment: .leading, spacing: Spacing.lg) {
            helpHeader("Keyboard Shortcuts", icon: "keyboard", tint: .blue)

            helpParagraph("Speed up your workflow with these keyboard shortcuts.")

            shortcutRow("⌘1 – ⌘9", "Jump to sidebar sections (Library, Live, Review, etc.)")
            shortcutRow("⌘F", "Focus the Library search bar")
            shortcutRow("⌘N", "Start recording a new meeting")
            shortcutRow("⌘,", "Open Settings")
            shortcutRow("Esc", "Close sheets and panels")
        }
    }

    // MARK: - Troubleshooting

    private var troubleshootingContent: some View {
        VStack(alignment: .leading, spacing: Spacing.lg) {
            helpHeader("Troubleshooting", icon: "wrench.and.screwdriver", tint: .orange)

            helpCard("Captions aren't being captured", icon: "mic.slash") {
                helpStep(1, "Open System Settings → Privacy & Security → Accessibility")
                helpStep(2, "Make sure LLM IDE is listed and enabled")
                helpStep(3, "Restart the meeting app (Zoom/Teams) after granting permission")
                helpStep(4, "Ensure captions/subtitles are turned on inside the meeting")
            }

            helpCard("Can't connect to the server", icon: "wifi.exclamationmark") {
                helpStep(1, "Check the server URL in Settings → Server")
                helpStep(2, "Make sure the LLM IDE server is running")
                helpStep(3, "If using localhost, check that the port matches (default: 3456)")
                helpStep(4, "Try signing out and signing back in to refresh your token")
            }

            helpCard("Notes aren't being generated", icon: "doc.questionmark") {
                helpBullet("Check Settings → Backend to make sure an AI provider is configured")
                helpBullet("Verify the transcript has enough content — very short meetings may not generate useful notes")
                helpBullet("Check the status bar at the bottom for error messages")
            }

            helpWarning("If something still isn't working, check the server logs for detailed error messages. The Mac app communicates with your self-hosted server — most issues originate there.")
        }
    }

    // MARK: - Reusable helpers

    private func helpHeader(_ title: String, icon: String, tint: Color) -> some View {
        let t = theme.current
        return HStack(spacing: Spacing.md) {
            Image(systemName: icon)
                .font(.system(size: 28))
                .foregroundStyle(tint)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(Typography.display)
                    .foregroundStyle(t.text)
            }
        }
        .padding(.bottom, Spacing.sm)
    }

    private func helpParagraph(_ text: String) -> some View {
        Text(text)
            .font(Typography.body)
            .foregroundStyle(theme.current.text)
            .fixedSize(horizontal: false, vertical: true)
    }

    private func helpCard<Content: View>(_ title: String, icon: String,
                                          @ViewBuilder content: () -> Content) -> some View {
        let t = theme.current
        return VStack(alignment: .leading, spacing: Spacing.sm) {
            Label {
                Text(title).font(Typography.bodyStrong)
            } icon: {
                Image(systemName: icon).foregroundStyle(t.accent)
            }
            .foregroundStyle(t.text)

            content()
        }
        .card(padding: Spacing.lg)
    }

    private func helpStep(_ n: Int, _ text: String) -> some View {
        let t = theme.current
        return HStack(alignment: .top, spacing: Spacing.sm) {
            Text("\(n)")
                .font(.system(size: 11, weight: .bold, design: .rounded))
                .foregroundStyle(.white)
                .frame(width: 22, height: 22)
                .background(t.accent, in: Circle())
            Text(text)
                .font(Typography.body)
                .foregroundStyle(t.text)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func helpBullet(_ text: String) -> some View {
        let t = theme.current
        return HStack(alignment: .top, spacing: Spacing.sm) {
            Circle()
                .fill(t.textMuted)
                .frame(width: 5, height: 5)
                .padding(.top, 6)
            Text(text)
                .font(Typography.body)
                .foregroundStyle(t.text)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func helpTip(_ text: String) -> some View {
        let t = theme.current
        return HStack(alignment: .top, spacing: Spacing.sm) {
            Image(systemName: "lightbulb.fill")
                .foregroundStyle(.yellow)
                .font(.system(size: 14))
                .padding(.top, 2)
            Text(text)
                .font(Typography.caption)
                .foregroundStyle(t.text)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(Spacing.md)
        .background(Color.yellow.opacity(t.isDark ? 0.08 : 0.06), in: RoundedRectangle(cornerRadius: Radius.sm))
    }

    private func helpWarning(_ text: String) -> some View {
        let t = theme.current
        return HStack(alignment: .top, spacing: Spacing.sm) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.orange)
                .font(.system(size: 14))
                .padding(.top, 2)
            Text(text)
                .font(Typography.caption)
                .foregroundStyle(t.text)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(Spacing.md)
        .background(Color.orange.opacity(t.isDark ? 0.08 : 0.06), in: RoundedRectangle(cornerRadius: Radius.sm))
    }

    private func shortcutRow(_ keys: String, _ description: String) -> some View {
        let t = theme.current
        return HStack(spacing: Spacing.md) {
            Text(keys)
                .font(.system(size: 12, weight: .medium, design: .monospaced))
                .foregroundStyle(t.accent)
                .frame(width: 100, alignment: .trailing)
            Text(description)
                .font(Typography.body)
                .foregroundStyle(t.text)
            Spacer()
        }
        .padding(.vertical, 4)
    }
}

// MARK: - Help topics

enum HelpTopic: String, CaseIterable, Identifiable {
    case gettingStarted
    case library
    case live
    case reviewCode
    case reviewDoc
    case issues
    case gantt
    case docGen
    case autoTasks
    case codeGraph
    case regression
    case settings
    case shortcuts
    case troubleshooting

    var id: String { rawValue }

    var title: String {
        switch self {
        case .gettingStarted:  return "Getting Started"
        case .library:         return "Library"
        case .live:            return "Live Capture"
        case .reviewCode:      return "Review Code"
        case .reviewDoc:       return "Review Doc"
        case .issues:          return "Issues"
        case .gantt:           return "Gantt"
        case .docGen:          return "Doc Gen"
        case .autoTasks:       return "Auto Tasks"
        case .codeGraph:        return "Code Graph"
        case .regression:      return "Regression"
        case .settings:        return "Settings"
        case .shortcuts:       return "Keyboard Shortcuts"
        case .troubleshooting: return "Troubleshooting"
        }
    }

    var icon: String {
        switch self {
        case .gettingStarted:  return "hand.wave"
        case .library:         return "books.vertical"
        case .live:            return "waveform"
        case .reviewCode:      return "checkmark.shield"
        case .reviewDoc:       return "doc.text.magnifyingglass"
        case .issues:          return "checklist"
        case .gantt:           return "chart.bar.doc.horizontal"
        case .docGen:          return "wand.and.stars"
        case .autoTasks:       return "arrow.triangle.2.circlepath.circle"
        case .codeGraph:        return "point.3.connected.trianglepath.dotted"
        case .regression:      return "arrow.uturn.backward.circle"
        case .settings:        return "gearshape"
        case .shortcuts:       return "keyboard"
        case .troubleshooting: return "wrench.and.screwdriver"
        }
    }

    /// Colors match the category-based sidebar scheme:
    ///   Notes  = blue family
    ///   Code   = green family
    ///   Data   = purple family
    var tint: Color {
        switch self {
        case .gettingStarted:  return .blue
        // ── Notes (blue family) ──────────────────────
        case .library:         return .blue
        case .live:            return Color(red: 0.20, green: 0.45, blue: 0.95)
        case .docGen:          return Color(red: 0.35, green: 0.55, blue: 0.95)
        // ── Code (green family) ──────────────────────
        case .reviewCode:      return Color(red: 0.22, green: 0.70, blue: 0.45)
        case .reviewDoc:       return Color(red: 0.30, green: 0.65, blue: 0.55)
        case .autoTasks:       return .teal
        case .codeGraph:        return Color(red: 0.15, green: 0.68, blue: 0.65) // code graph teal
        case .regression:      return Color(red: 0.40, green: 0.75, blue: 0.50)
        // ── Data (purple family) ─────────────────────
        case .issues:          return .purple
        case .gantt:           return .indigo
        // ── Neutral ──────────────────────────────────
        case .settings:        return .gray
        case .shortcuts:       return .blue
        case .troubleshooting: return .orange
        }
    }
}
