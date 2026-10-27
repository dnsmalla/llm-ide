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

    /// Asks the Graph section to show `page` the next time it is shown, or now
    /// when it is already mounted (the view reads the same key through AppStorage).
    /// Call it before navigating to `ShellSection.codeGraph` for a code-graph
    /// intent, so the link lands on the code graph and not on the System page.
    static func request(_ page: GraphSectionPage, defaults: UserDefaults = .standard) {
        defaults.set(page.rawValue, forKey: storageKey)
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
                Picker("Graph page", selection: Binding(
                    get: { page },
                    set: { pageRaw = $0.rawValue })) {
                    ForEach(GraphSectionPage.allCases, id: \.self) { option in
                        Text(option.label).tag(option)
                    }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .fixedSize()
                .accessibilityLabel("Graph page")
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
