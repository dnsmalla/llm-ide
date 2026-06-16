import SwiftUI

struct SidebarView: View {
    let api: LlmIdeAPIClient
    @Environment(ShellState.self) private var shell
    @EnvironmentObject var capture: CaptionOrchestrator
    @EnvironmentObject var liveMirror: LiveSessionMirror
    @EnvironmentObject var session: SessionStore
    @EnvironmentObject var theme: ThemeStore
    @EnvironmentObject var config: AppConfig
    @EnvironmentObject var projectStore: ProjectStore
    @State private var showingPermissions = false
    @State private var showingHelp = false
    /// Tracks the sidebar's actual rendered width.  Below
    /// `compactThreshold` we switch to icon-only labels so the rows
    /// never clip or overlap their text.
    @State private var sidebarWidth: CGFloat = 200
    private let compactThreshold: CGFloat = 160
    private var isCompact: Bool { sidebarWidth < compactThreshold }

    /// "Live" is visible when EITHER the local CaptionOrchestrator is
    /// recording or the LiveSessionMirror is mirroring a remote
    /// session (most commonly the Chrome extension capturing
    /// Meet/Teams web).
    private var liveActive: Bool {
        capture.isRunning || liveMirror.activeSession != nil
    }

    /// VS Code-style activity bar.  Three prominent primary
    /// destinations (Explorer / Search / Source Control) drive
    /// `shell.section` directly; every other section is reachable from
    /// the ⋯ More overflow control below the divider.  `shell.section`
    /// remains the single selection source — AppShell routing is
    /// unchanged.
    private static let primarySections: [ShellState.Section] =
        [.explorer, .search, .sourceControl, .sources]

    /// Sections offered in the ⋯ More overflow, in display order.  This
    /// is every non-primary, non-settings destination; `isVisible`
    /// filters out user-hidden ones at render time.  `.library` and
    /// `.live` are never hidden (the first is the landing fallback, the
    /// second is condition-driven).
    private static let moreSections: [ShellState.Section] =
        [.library, .live, .docGen, .review, .plans, .conflicts,
         .autoCode, .codeGraph, .regression, .issues, .gantt, .visual]

    /// True when the current selection lives in the ⋯ More overflow —
    /// used to highlight the More control as active.
    private var moreIsActive: Bool {
        Self.moreSections.contains(shell.section)
    }

    var body: some View {
        @Bindable var shell = shell
        ScrollView {
            VStack(alignment: .leading, spacing: 8) {
                // ── Primary destinations ─────────────────────
                ForEach(Self.primarySections, id: \.self) { section in
                    primaryButton(section)
                }

                Divider()
                    .padding(.horizontal, isCompact ? 6 : 10)
                    .padding(.vertical, 2)

                // ── ⋯ More overflow ──────────────────────────
                moreMenu
            }
            .padding(.horizontal, isCompact ? 4 : 8)
            .padding(.top, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .scrollIndicators(.never)
        // Measure available width via a transparent background so we
        // can react to width changes for compact (icon-only) mode.
        .background(
            GeometryReader { geo in
                Color.clear
                    .onAppear { sidebarWidth = geo.size.width }
                    .onChange(of: geo.size.width) { _, w in sidebarWidth = w }
            }
        )
        .safeAreaInset(edge: .top, spacing: 0) {
            VStack(spacing: 0) {
                brandHeader
                if !isCompact {
                    ProjectSwitcher()
                        .padding(.horizontal, 8)
                        .padding(.top, 4)
                        .padding(.bottom, 6)
                    Divider().padding(.bottom, 4)
                }
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) { footer }
        // Min lowered to 80 so the user can drag down to icon-only
        // mode for more content space.  Ideal/max unchanged.
        .navigationSplitViewColumnWidth(min: 60, ideal: 64, max: 260)
        // Global keyboard shortcuts.  ⌘1–5 nav, ⌘F → focus filter.
        .overlay(globalShortcuts)
    }

    /// Honours the user's visibility preference. `library`, `live`, and
    /// `settings` are never hidden by the user (the first is the fallback,
    /// the second is condition-driven, the third needs to stay reachable).
    private func isVisible(_ section: ShellState.Section) -> Bool {
        !config.hiddenSidebarSections.contains(section.rawValue)
    }

    /// A prominent primary activity-bar button.  Sets `shell.section`
    /// on tap and shows a tinted highlight while it's the active
    /// section.  Wide: large icon + label.  Compact: icon only with the
    /// label preserved as a tooltip.
    @ViewBuilder
    private func primaryButton(_ section: ShellState.Section) -> some View {
        let isActive = shell.section == section
        let tint = section.tint(theme.current)
        Button {
            shell.section = section
        } label: {
            Group {
                if isCompact {
                    HStack {
                        Spacer(minLength: 0)
                        Image(systemName: section.systemImage)
                            .font(.system(size: 18, weight: .medium))
                            .symbolRenderingMode(.hierarchical)
                            .frame(width: 26, height: 26)
                        Spacer(minLength: 0)
                    }
                } else {
                    HStack(spacing: 12) {
                        Image(systemName: section.systemImage)
                            .font(.system(size: 18, weight: .medium))
                            .symbolRenderingMode(.hierarchical)
                            .frame(width: 26)
                        Text(section.label)
                            .font(.body.weight(isActive ? .semibold : .regular))
                            .lineLimit(1)
                        Spacer(minLength: 0)
                    }
                }
            }
            .foregroundStyle(isActive ? tint : Color.primary)
            .padding(.vertical, 9)
            .padding(.horizontal, isCompact ? 4 : 10)
            .frame(maxWidth: .infinity, alignment: isCompact ? .center : .leading)
            .background(
                RoundedRectangle(cornerRadius: 8)
                    .fill(isActive ? tint.opacity(0.18) : Color.clear)
            )
            .contentShape(RoundedRectangle(cornerRadius: 8))
        }
        .buttonStyle(.plain)
        .help(section.label)
        .accessibilityLabel(section.label)
        .accessibilityAddTraits(isActive ? .isSelected : [])
    }

    /// The ⋯ More overflow.  Lists every visible non-primary section as
    /// a menu; selecting one drives `shell.section`.  Highlights itself
    /// when the active section lives in this overflow.  `.live` carries
    /// the recording dot when `liveActive`.
    @ViewBuilder
    private var moreMenu: some View {
        let isActive = moreIsActive
        let activeTint = isActive ? shell.section.tint(theme.current) : theme.current.accent
        Menu {
            ForEach(Self.moreSections, id: \.self) { section in
                if section == .live {
                    if liveActive { moreMenuItem(section) }
                } else if isVisible(section) {
                    moreMenuItem(section)
                }
            }
        } label: {
            Group {
                if isCompact {
                    HStack {
                        Spacer(minLength: 0)
                        ZStack(alignment: .topTrailing) {
                            Image(systemName: "ellipsis.circle")
                                .font(.system(size: 18, weight: .medium))
                                .symbolRenderingMode(.hierarchical)
                                .frame(width: 26, height: 26)
                            if liveActive {
                                Circle().fill(theme.current.danger)
                                    .frame(width: 7, height: 7)
                            }
                        }
                        Spacer(minLength: 0)
                    }
                } else {
                    HStack(spacing: 12) {
                        Image(systemName: "ellipsis.circle")
                            .font(.system(size: 18, weight: .medium))
                            .symbolRenderingMode(.hierarchical)
                            .frame(width: 26)
                        Text(isActive ? shell.section.label : "More")
                            .font(.body.weight(isActive ? .semibold : .regular))
                            .lineLimit(1)
                        Spacer(minLength: 0)
                        if liveActive {
                            Circle().fill(theme.current.danger)
                                .frame(width: 7, height: 7)
                        }
                    }
                }
            }
            .foregroundStyle(isActive ? activeTint : Color.primary)
            .padding(.vertical, 9)
            .padding(.horizontal, isCompact ? 4 : 10)
            .frame(maxWidth: .infinity, alignment: isCompact ? .center : .leading)
            .background(
                RoundedRectangle(cornerRadius: 8)
                    .fill(isActive ? activeTint.opacity(0.18) : Color.clear)
            )
            .contentShape(RoundedRectangle(cornerRadius: 8))
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .help(isActive ? shell.section.label : "More sections")
        .accessibilityLabel(isActive ? "More sections, \(shell.section.label) selected" : "More sections")
    }

    /// One row in the ⋯ More menu.  Pulls label + icon from the enum so
    /// the menu can never drift from the section metadata.  Appends a
    /// recording marker to `.live` while capturing.
    @ViewBuilder
    private func moreMenuItem(_ section: ShellState.Section) -> some View {
        Button {
            shell.section = section
        } label: {
            Label(section == .live && liveActive ? "\(section.label) ●" : section.label,
                  systemImage: section.systemImage)
        }
    }

    /// App identity at the very top of the sidebar.  The unified
    /// titlebar style hides the navigation title, so the brand mark
    /// lives inside the sidebar itself like Notes.app does.
    @ViewBuilder
    private var brandHeader: some View {
        HStack(spacing: 10) {
            ZStack {
                RoundedRectangle(cornerRadius: 7)
                    .fill(theme.current.accent.opacity(0.18))
                    .frame(width: 26, height: 26)
                Image(systemName: "waveform.and.mic")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(theme.current.accent)
            }
            if !isCompact {
                Text("LLM IDE")
                    .font(.headline)
                    .foregroundStyle(.primary)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, isCompact ? 6 : 14)
        .padding(.top, 8)
        .padding(.bottom, 6)
        .frame(maxWidth: .infinity)
        .help(isCompact ? "LLM IDE" : "")
    }

    @ViewBuilder
    private var footer: some View {
        VStack(spacing: 0) {
            Divider()
            if isCompact {
                // Stack vertically with just icons in compact mode so
                // none of the footer controls get pushed off-screen.
                VStack(spacing: 8) {
                    recordButton
                    Button { showingPermissions = true } label: {
                        Image(systemName: "lock.shield")
                            .font(.system(size: 14))
                    }
                    .buttonStyle(.borderless)
                    .help("Permissions")
                    .accessibilityLabel("Open permissions")
                    userMenu
                }
                .padding(.vertical, 10)
                .frame(maxWidth: .infinity)
            } else {
                HStack(spacing: 6) {
                    recordButton
                    Button { showingPermissions = true } label: {
                        Image(systemName: "lock.shield")
                            .font(.system(size: 14))
                    }
                    .buttonStyle(.borderless)
                    .help("Permissions")
                    .accessibilityLabel("Open permissions")
                    Spacer(minLength: 0)
                    userMenu
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
            }
        }
        .background(.bar)
        .sheet(isPresented: $showingPermissions) {
            PermissionsView { showingPermissions = false }
                .frame(minWidth: 560, idealWidth: 600, maxWidth: 700,
                       minHeight: 520, idealHeight: 640, maxHeight: 800)
                .environmentObject(theme)
        }
        .sheet(isPresented: $showingHelp) {
            HelpGuideView { showingHelp = false }
                .environmentObject(theme)
        }
    }

    @ViewBuilder
    private var recordButton: some View {
        if capture.isRunning {
            Button {
                Task { _ = await capture.stopAndIngest(api: api, meetingTitle: "") }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "stop.circle.fill")
                    if !isCompact { Text("Stop") }
                }
                .font(.callout.weight(.semibold))
                .foregroundStyle(.white)
                .padding(.horizontal, isCompact ? 8 : 10)
                .padding(.vertical, 5)
                .background(theme.current.danger, in: Capsule())
            }
            .buttonStyle(.plain)
            .help("Stop & Save")
            .accessibilityLabel("Stop recording and save")
        } else {
            Button {
                if AXCaptionReader.canRead {
                    capture.start()
                } else {
                    showingPermissions = true
                }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "record.circle")
                    if !isCompact { Text("Record") }
                }
                .font(.callout.weight(.semibold))
                .foregroundStyle(.white)
                .padding(.horizontal, isCompact ? 8 : 10)
                .padding(.vertical, 5)
                .background(theme.current.accent, in: Capsule())
            }
            .buttonStyle(.plain)
            .keyboardShortcut("n", modifiers: .command)
            .help("Start recording (⌘N)")
            .accessibilityLabel("Start recording")
        }
    }

    @ViewBuilder
    private var userMenu: some View {
        if let user = session.user {
            Menu {
                Text(user.displayName)
                Text(user.email).foregroundStyle(.secondary)
                Divider()
                Button {
                    shell.section = .settings
                } label: {
                    Label("Settings…", systemImage: "gearshape")
                }
                .keyboardShortcut(",", modifiers: .command)
                Button {
                    showingHelp = true
                } label: {
                    Label("Help & Guide", systemImage: "questionmark.circle")
                }
                .keyboardShortcut("/", modifiers: .command)
                Divider()
                Button("Sign out", role: .destructive) {
                    Task { @MainActor in session.clear() }
                }
            } label: {
                Image(systemName: "person.crop.circle")
                    .font(.system(size: 16))
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .frame(width: 28)
            .help(user.email)
            .accessibilityLabel("Account menu for \(user.displayName)")
        }
    }

    /// Invisible buttons that own the global keyboard shortcuts.
    /// Keeps the wiring out of the visible List so nothing visual
    /// shifts when a row's modifier changes.
    private var globalShortcuts: some View {
        @Bindable var shell = shell
        return VStack(spacing: 0) {
            ForEach(Array(ShellState.Section.allCases.enumerated()), id: \.element) { (idx, sec) in
                if idx < 9 {
                    Button("") { shell.section = sec }
                        .keyboardShortcut(KeyEquivalent(Character("\(idx + 1)")), modifiers: .command)
                        .frame(width: 0, height: 0)
                }
            }
            Button("") {
                shell.section = .library
                NotificationCenter.default.post(name: .focusLibraryFilter, object: nil)
            }
            .keyboardShortcut("f", modifiers: .command)
            .frame(width: 0, height: 0)
            // ⌘, — Settings, always reachable. Previously this was only
            // wired inside the user menu and so silently broke when the
            // user was signed out OR a future change hid the menu.
            Button("") { shell.section = .settings }
                .keyboardShortcut(",", modifiers: .command)
                .frame(width: 0, height: 0)
        }
        .opacity(0)
        .allowsHitTesting(false)
    }
}
