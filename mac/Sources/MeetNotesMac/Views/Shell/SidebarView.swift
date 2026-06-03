import SwiftUI

struct SidebarView: View {
    let api: MeetNotesAPIClient
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

    var body: some View {
        @Bindable var shell = shell
        // Keep `List` as the *direct* sidebar content so the system
        // sidebar insets (which inset section headers and row icons)
        // are applied.  Wrapping the List in a VStack strips that
        // styling and causes the "TINGS"/"ONS" clipping seen earlier.
        List(selection: $shell.section) {
            // ── Notes (blue family) ──────────────────────
            Section(isCompact ? "" : "Notes") {
                sidebarRow(section: .library)
                if liveActive {
                    sidebarRow(section: .live, trailing: AnyView(
                        Circle().fill(theme.current.danger).frame(width: 7, height: 7)))
                }
                if isVisible(.docGen) { sidebarRow(section: .docGen) }
            }
            // ── Code (green family) ──────────────────────
            let codeSections: [ShellState.Section] =
                [.review, .plans, .conflicts, .autoCode, .codeGraph, .regression]
            let visibleCode = codeSections.filter(isVisible)
            if !visibleCode.isEmpty {
                Section(isCompact ? "" : "Code") {
                    ForEach(visibleCode, id: \.self) { sidebarRow(section: $0) }
                }
            }
            // ── Data (purple family) ─────────────────────
            let dataSections: [ShellState.Section] = [.issues, .gantt]
            let visibleData = dataSections.filter(isVisible)
            if !visibleData.isEmpty {
                Section(isCompact ? "" : "Data") {
                    ForEach(visibleData, id: \.self) { sidebarRow(section: $0) }
                }
            }
            // Settings reached via the profile menu in the footer.
        }
        .listStyle(.sidebar)
        // Measure available width via a transparent background — keeps
        // the List's native sidebar styling intact while letting us
        // react to width changes for compact mode.
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

    /// Sidebar row that adapts to compact mode.  Wide: icon + label
    /// (+ optional trailing accessory).  Compact: icon only with the
    /// label moved to a tooltip so it's still discoverable.
    /// Honours the user's visibility preference. `library`, `live`, and
    /// `settings` are never hidden by the user (the first is the fallback,
    /// the second is condition-driven, the third needs to stay reachable).
    private func isVisible(_ section: ShellState.Section) -> Bool {
        !config.hiddenSidebarSections.contains(section.rawValue)
    }

    /// Convenience wrapper — pulls label + system image from the enum
    /// so call sites stay short and metadata has a single home.
    @ViewBuilder
    private func sidebarRow(section: ShellState.Section,
                            trailing: AnyView? = nil) -> some View {
        sidebarRow(label: section.label,
                   systemImage: section.systemImage,
                   section: section,
                   trailing: trailing)
    }

    @ViewBuilder
    private func sidebarRow(label: String, systemImage: String,
                            section: ShellState.Section,
                            trailing: AnyView? = nil) -> some View {
        let tint = section.tint(theme.current)
        if isCompact {
            HStack {
                Spacer(minLength: 0)
                Image(systemName: systemImage)
                    .font(.system(size: 16))
                    .symbolRenderingMode(.hierarchical)
                    .foregroundStyle(tint)
                    .frame(width: 22, height: 22)
                Spacer(minLength: 0)
                if let trailing = trailing { trailing }
            }
            .tag(section)
            .help(label)
            .accessibilityLabel(label)
        } else {
            HStack {
                Label {
                    Text(label)
                } icon: {
                    Image(systemName: systemImage)
                        .symbolRenderingMode(.hierarchical)
                        .foregroundStyle(tint)
                }
                if let trailing = trailing {
                    Spacer()
                    trailing
                }
            }
            .tag(section)
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
                Text("Meet Notes")
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
        .help(isCompact ? "Meet Notes" : "")
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
