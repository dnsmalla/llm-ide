import SwiftUI
import SharedProtocol

/// Everything tied to the Mac's active project, one tab: a status header and a
/// segmented switch between Explorer, Auto Tasks and Loop. The three screens
/// are the same views the old sheets showed, hosted inline; the stack here
/// supplies their nav bar (title + actions).
struct ProjectView: View {
    let deviceName: String
    @EnvironmentObject var autoTaskStore: AutoTaskStore
    @EnvironmentObject var loopStore: LoopStore
    @EnvironmentObject var connection: ConnectionService

    enum Section: String, CaseIterable, Identifiable {
        case explorer = "Explorer"
        case autoTasks = "Auto Tasks"
        case loop = "Loop"
        case docs = "Docs"
        case files = "Files"
        case git = "Git"
        case issues = "Issues"
        case selfHeal = "Self-Heal"
        var id: String { rawValue }

        /// The `MobileProtocol.Capability` this segment needs from the Mac.
        var capability: String {
            switch self {
            case .explorer:  return MobileProtocol.Capability.explorer
            case .autoTasks: return MobileProtocol.Capability.autoTasks
            case .loop:      return MobileProtocol.Capability.loop
            case .docs:      return MobileProtocol.Capability.llmDoc
            case .files:     return MobileProtocol.Capability.files
            case .git:       return MobileProtocol.Capability.sourceControl
            case .issues:    return MobileProtocol.Capability.issues
            case .selfHeal:  return MobileProtocol.Capability.selfHeal
            }
        }
    }
    @State private var section: Section = .explorer

    /// The segments this Mac actually serves. Explorer is chat, always there.
    private var visibleSections: [Section] {
        Section.allCases.filter { connection.supports($0.capability) }
    }
    @StateObject private var explorerDraft = ExplorerDraft()

    var body: some View {
        NavigationStack {
            Group {
                switch section {
                case .explorer:  ExplorerChatView(embedded: true, draft: explorerDraft)
                case .autoTasks: AutoTaskView(embedded: true)
                case .loop:      LoopView(embedded: true)
                case .docs:      LlmDocBrowserView()
                case .files:     ProjectFilesView()
                case .git:       SourceControlView()
                case .issues:    IssuesView()
                case .selfHeal:  SelfHealView()
                }
            }
            // The header's "running" rows read these snapshots, and Loop stops polling when its
            // segment goes away — so re-read them whenever the Project tab is shown.
            // A Mac that doesn't serve the open segment (older build, or a different Mac was
            // paired) must not leave the tab on a screen that can never load.
            .onChange(of: connection.macCapabilities) { _ in
                if !visibleSections.contains(section) { section = visibleSections.first ?? .explorer }
            }
            .onAppear {
                guard connection.connectionStatus == .connected else { return }
                loopStore.refreshAll()
                autoTaskStore.refreshAll()
            }
            .safeAreaInset(edge: .top, spacing: 0) {
                VStack(spacing: 0) {
                    ProjectHeader(deviceName: deviceName, section: $section)
                    SectionChips(sections: visibleSections, selection: $section)
                        .padding(.bottom, DesignSystem.Spacing.sm)
                    Divider()
                }
                .background(DesignSystem.Colors.background)
            }
        }
    }
}

private struct ProjectHeader: View {
    let deviceName: String
    @Binding var section: ProjectView.Section
    @EnvironmentObject var macStatusStore: MacStatusStore
    @EnvironmentObject var autoTaskStore: AutoTaskStore
    @EnvironmentObject var loopStore: LoopStore
    @EnvironmentObject var connection: ConnectionService
    @State private var showSwitcher = false

    private var canSwitch: Bool { connection.supports(MobileProtocol.Capability.projects) }

    var body: some View {
        VStack(alignment: .leading, spacing: DesignSystem.Spacing.xs) {
            HStack(spacing: DesignSystem.Spacing.sm) {
                Button { showSwitcher = true } label: {
                    HStack(spacing: 4) {
                        Text(projectName)
                            .font(DesignSystem.Typography.headlineFont.weight(.bold))
                            .foregroundColor(DesignSystem.Colors.textPrimary)
                            .lineLimit(1)
                        if canSwitch {
                            Image(systemName: "chevron.up.chevron.down")
                                .font(.caption2.weight(.semibold))
                                .foregroundColor(DesignSystem.Colors.textTertiary)
                        }
                    }
                }
                .buttonStyle(.plain)
                .disabled(!canSwitch)
                .accessibilityLabel(canSwitch ? "Project \(projectName). Switch project" : "Project \(projectName)")
                if let branch = macStatusStore.macStatus?.gitBranch, !branch.isEmpty {
                    Label(branch, systemImage: "arrow.triangle.branch")
                        .font(DesignSystem.Typography.captionFont)
                        .foregroundColor(DesignSystem.Colors.textSecondary)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
                statusDot("Backend", up: macStatusStore.macStatus?.backendUp == true)
                statusDot("Mobile", up: macStatusStore.macStatus?.mobileControlUp == true)
            }
            if autoTaskStore.autoTaskState?.isRunning == true {
                liveRow("Auto Task running", detail: autoTaskStore.autoTaskState?.currentStep, target: .autoTasks)
            }
            if loopStore.state?.running == true {
                liveRow("Loop running", detail: nil, target: .loop)
            }
        }
        .padding(.horizontal, DesignSystem.Spacing.md)
        .padding(.top, DesignSystem.Spacing.xs)
        .padding(.bottom, DesignSystem.Spacing.xs)
        .frame(maxWidth: .infinity, alignment: .leading)
        .sheet(isPresented: $showSwitcher) { ProjectSwitcherSheet() }
    }

    private var projectName: String {
        if let name = macStatusStore.macStatus?.projectName, !name.isEmpty { return name }
        return deviceName
    }

    private func statusDot(_ label: String, up: Bool) -> some View {
        HStack(spacing: 4) {
            Circle()
                .fill(up ? DesignSystem.Colors.success : DesignSystem.Colors.danger)
                .frame(width: 7, height: 7)
            Text(label)
                .font(DesignSystem.Typography.captionFont.weight(.medium))
                .foregroundColor(DesignSystem.Colors.textSecondary)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(label) \(up ? "up" : "down")")
    }

    private func liveRow(_ title: String, detail: String?, target: ProjectView.Section) -> some View {
        Button { if connection.supports(target.capability) { section = target } } label: {
            HStack(spacing: 6) {
                ProgressView().scaleEffect(0.7)
                Text(title).font(DesignSystem.Typography.captionFont.weight(.semibold))
                if let detail, !detail.isEmpty {
                    Text("· \(detail)").lineLimit(1)
                        .font(DesignSystem.Typography.captionFont)
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right").font(.caption2)
            }
            .foregroundColor(DesignSystem.Colors.primary)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(DesignSystem.Colors.primaryLight, in: RoundedRectangle(cornerRadius: DesignSystem.Layout.cornerRadiusS))
        }
        .buttonStyle(.plain)
    }
}

/// Scrollable section switcher. The Project tab outgrew a segmented control (it can't scroll and
/// truncates at 5+ items), so sections are capsules in a horizontal scroll that keeps the selected
/// one in view.
private struct SectionChips: View {
    let sections: [ProjectView.Section]
    @Binding var selection: ProjectView.Section

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: DesignSystem.Spacing.xs) {
                    ForEach(sections) { section in
                        Button { selection = section; haptic(.light) } label: {
                            Text(section.rawValue)
                                .font(DesignSystem.Typography.subheadlineFont.weight(.semibold))
                                .padding(.horizontal, 14).padding(.vertical, 7)
                                .foregroundColor(selection == section ? DesignSystem.Colors.onPrimary : DesignSystem.Colors.textSecondary)
                                .background(selection == section ? DesignSystem.Colors.primary : DesignSystem.Colors.surfaceSecondary,
                                            in: Capsule())
                        }
                        .buttonStyle(.plain)
                        .id(section)
                        .accessibilityAddTraits(selection == section ? .isSelected : [])
                    }
                }
                .padding(.horizontal, DesignSystem.Spacing.md)
            }
            .onChange(of: selection) { value in withAnimation { proxy.scrollTo(value, anchor: .center) } }
            // Coming back to the tab (or opening it on a later section) must show the selected chip,
            // not leave it scrolled out of view. After layout, so the anchor exists.
            .onAppear { DispatchQueue.main.async { proxy.scrollTo(selection, anchor: .center) } }
        }
    }
}
