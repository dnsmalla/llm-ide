import SwiftUI

/// Shown above a rendered markdown preview whose document contains a
/// ```mermaid fence while the optional mermaid component is not installed.
///
/// The preview itself still renders — the fences show as code blocks — so the
/// banner is an offer, not an error. It never downloads by itself: the app is
/// local-first and must work offline, so the 3.4 MB fetch happens only when
/// the user clicks Install. Once installed it disappears, and every open
/// `MarkdownWebView` reloads (it observes the same `MermaidRuntime`).
///
/// Renders nothing for a document with no fence, so call sites can place it
/// unconditionally.
struct MermaidInstallBanner: View {
    let markdown: String
    /// Space around the banner. Applied INSIDE the conditional so a document
    /// without a fence costs no layout space at all.
    var outerPadding = EdgeInsets(top: 8, leading: 8, bottom: 8, trailing: 8)
    @ObservedObject private var runtime = MermaidRuntime.shared

    var body: some View {
        if MarkdownRenderer.needsMermaid(markdown), !runtime.isInstalled {
            HStack(alignment: .center, spacing: 8) {
                Image(systemName: "chart.xyaxis.line")
                    .foregroundStyle(.blue)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(headline)
                        .font(.callout)
                        .fixedSize(horizontal: false, vertical: true)
                    if case .failed(let message) = runtime.state {
                        Text(message)
                            .font(.caption)
                            .foregroundStyle(.red)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                MermaidInstallControl(runtime: runtime)
            }
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.blue.opacity(0.08))
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .padding(outerPadding)
        }
    }

    private var headline: String {
        "This document has diagrams. Diagram support isn't installed "
            + "(\(MermaidInstallControl.sizeLabel), one-time download)."
    }
}

/// The Install button / progress indicator, shared by the banner and the
/// Settings card so the two can never disagree about what a click does.
struct MermaidInstallControl: View {
    @ObservedObject var runtime: MermaidRuntime

    static var sizeLabel: String {
        ByteCountFormatter.string(fromByteCount: Int64(Mermaid.byteCount), countStyle: .file)
    }

    var body: some View {
        switch runtime.state {
        case .downloading(let fraction):
            ProgressView(value: fraction)
                .frame(width: 90)
                .help("Downloading mermaid \(Mermaid.version)…")
        case .installed:
            EmptyView()
        case .notInstalled, .failed:
            Button {
                Task { await runtime.install() }
            } label: {
                Text(isRetry ? "Retry" : "Install")
            }
            .controlSize(.small)
            .help("Download mermaid \(Mermaid.version) from cdn.jsdelivr.net and verify its checksum")
        }
    }

    private var isRetry: Bool {
        if case .failed = runtime.state { return true }
        return false
    }
}
