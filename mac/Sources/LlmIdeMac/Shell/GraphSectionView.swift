import SwiftUI

/// The two pages the Graph section can show. Persisted as a raw value under
/// `storageKey`; an unknown or missing value reads as `default` (System).
enum GraphSectionPage: String, CaseIterable {
    case system
    case code

    static let storageKey = "graphSectionPage"
    static let `default`: GraphSectionPage = .system

    static func resolve(_ raw: String) -> GraphSectionPage {
        GraphSectionPage(rawValue: raw) ?? .default
    }

    var label: String {
        switch self {
        case .system: return "System"
        case .code:   return "Code graph"
        }
    }
}

/// The Graph section (`ShellSection.codeGraph`), the Home landing. Its default
/// page is the visual System view; the segmented toggle switches to the code
/// graph. Lives in Shell because it names both features; neither feature
/// names the other.
///
/// Only the selected page is mounted. Switching pages tears the other one
/// down, so the System page's WKWebView stops its change feed while the code
/// graph is showing, and switching back reloads it.
struct GraphSectionView: View {
    let api: LlmIdeAPIClient
    /// Shows a section the System page asked for (`open` message). AppShell wires it.
    let onOpen: (ShellSection) -> Void

    @AppStorage(GraphSectionPage.storageKey) private var pageRaw = GraphSectionPage.default.rawValue

    private var page: GraphSectionPage { GraphSectionPage.resolve(pageRaw) }

    var body: some View {
        VStack(spacing: 0) {
            SectionChromeBar(toggles: [], leading: {
                GraphPageTabs(selection: Binding(
                    get: { page },
                    set: { pageRaw = $0.rawValue }))
            }, trailing: { EmptyView() })

            Group {
                switch page {
                case .system:
                    SystemView(api: api, onOpen: onOpen)
                case .code:
                    FeatureCatalog.graphMainPane()
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}

/// Segmented "System | Code graph" switch, styled like `PanelSectionTabs`.
private struct GraphPageTabs: View {
    @Binding var selection: GraphSectionPage
    @EnvironmentObject private var theme: ThemeStore

    var body: some View {
        HStack(spacing: 4) {
            ForEach(GraphSectionPage.allCases, id: \.self) { tab($0) }
        }
    }

    private func tab(_ page: GraphSectionPage) -> some View {
        let isActive = selection == page
        let tint = ShellSection.codeGraph.tint(theme.current)
        return Button { selection = page } label: {
            Text(page.label)
                .font(.system(size: 12, weight: isActive ? .semibold : .regular))
                .foregroundStyle(isActive ? tint : Color.primary.opacity(0.7))
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .background(RoundedRectangle(cornerRadius: 6)
                    .fill(isActive ? tint.opacity(0.16) : Color.clear))
                .contentShape(RoundedRectangle(cornerRadius: 6))
        }
        .buttonStyle(.plain)
        .help(page.label)
        .accessibilityLabel(page.label)
        .accessibilityAddTraits(isActive ? .isSelected : [])
    }
}
