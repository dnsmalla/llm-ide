import SwiftUI

/// One row in the "Steps to generate" checklist. Text and completion state
/// are supplied by the caller — Doc Gen and Visual describe different
/// mechanics (see `DocGenEditorPanel` vs `VisualCenterPanel`) even though the
/// checklist chrome itself (numbering, checkmark, strike-through) is shared.
/// Numbering is positional (index + 1 in `GenerationEditorPanel.steps`),
/// matching the original Doc Gen checklist.
struct GenerationChecklistStep {
    let title: String
    let detail: String
    let done: Bool
}

/// The centre-panel body shared between Doc Gen and Visual: toolbar, setup
/// view (selected-sources card + steps checklist), generating view
/// (progress row + shimmer skeleton), done view, and error view.
///
/// Extracted verbatim from Doc Gen's original `DocGenEditorPanel` — every
/// body below is unchanged from that file. The only things that moved from
/// hardcoded strings to parameters are the "no sources selected" hint and
/// the steps-checklist text, because that copy differs per tab (Doc Gen's
/// Sources tabs are Code / LLM Doc / Data; Visual's are Data / Code, and its
/// mechanics — name previews, checkbox selects, "Use chat" relaxes the
/// template/command requirement — are different). `toolbarAccessory` is an
/// optional trailing control appended after the toolbar's `Spacer()`; Doc
/// Gen renders none (see the `ToolbarAccessory == EmptyView` convenience
/// initializer below, so its toolbar is byte-for-byte what it was before
/// this file existed), while Visual uses it for its "View Image" control —
/// see `VisualCenterPanel`.
///
/// Lives under `Views/Shared` because `Views/DocGen` and `Views/Visual` both
/// render it and they are peers: whichever one owned this body, the other
/// would have to import across a sibling feature directory. Same reason
/// `GenerationViewModel`/`GenerationSetupSection`/`GenerationSourceTree`/
/// `GenerationPromptBar` live here.
///
/// NOT for a build-exclusion reason — the two directories are excluded
/// together when `doc_gen` is compiled out (`mac/Package.swift`), so either
/// could host this file and it would be present in exactly the builds that
/// have a consumer. An earlier version of this comment said `Views/Visual`
/// "is never excluded", which stopped being true when Visual was put behind
/// the `doc_gen` flag; the replacement then over-corrected and claimed
/// neither directory *could* own it. Both were wrong, and either would
/// mislead someone deciding where a new shared view belongs.
struct GenerationEditorPanel<ToolbarAccessory: View>: View {
    @ObservedObject var vm: GenerationViewModel
    let api: LlmIdeAPIClient
    /// Copy for the "No sources selected" hint inside the sources card.
    let sourcesEmptyHint: String
    /// The three-item "Steps to generate" checklist, in display order.
    let steps: [GenerationChecklistStep]
    let toolbarAccessory: () -> ToolbarAccessory

    @EnvironmentObject private var theme: ThemeStore

    /// Rendered preview vs raw markdown. Defaults to the preview, matching the
    /// Library's convention for the same content type — see
    /// `EditableTextDetailView`: "Code/markdown open in the rendered/highlighted
    /// Preview by default."
    @State private var isPreview = true

    init(vm: GenerationViewModel,
         api: LlmIdeAPIClient,
         sourcesEmptyHint: String,
         steps: [GenerationChecklistStep],
         @ViewBuilder toolbarAccessory: @escaping () -> ToolbarAccessory) {
        self.vm = vm
        self.api = api
        self.sourcesEmptyHint = sourcesEmptyHint
        self.steps = steps
        self.toolbarAccessory = toolbarAccessory
    }

    var body: some View {
        VStack(spacing: 0) {
            toolbar
            Divider()
            content
        }
        .background(Color(nsColor: .controlBackgroundColor))
    }

    // MARK: - Toolbar

    private var toolbar: some View {
        HStack(spacing: 10) {
            // Current template badge (read-only, set from Sources panel)
            if let template = vm.selectedTemplate {
                HStack(spacing: 6) {
                    Image(systemName: "doc.text.fill")
                        .font(.system(size: 11))
                        .foregroundStyle(theme.current.accent)
                    Text(template.name)
                        .font(.callout.weight(.medium))
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                    Text("·")
                        .foregroundStyle(.quaternary)
                    Text("\(template.sections.count) sections")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 5)
                .background(theme.current.accent.opacity(0.07), in: RoundedRectangle(cornerRadius: 7))
                .overlay(
                    RoundedRectangle(cornerRadius: 7)
                        .strokeBorder(theme.current.accent.opacity(0.2), lineWidth: 1)
                )
            } else if vm.selectedCommand == nil {
                // Only shown when NEITHER a template nor a command is picked
                // yet — a command alone satisfies step 1 (see GenerationTemplateSection),
                // so this must not render alongside the command badge below.
                HStack(spacing: 6) {
                    Image(systemName: "arrow.left")
                        .font(.system(size: 10))
                        .foregroundStyle(.tertiary)
                    Text("Choose a template or command from the left panel")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                }
            }

            if let command = vm.selectedCommand {
                HStack(spacing: 5) {
                    Image(systemName: "text.badge.checkmark")
                        .font(.system(size: 10))
                        .foregroundStyle(.secondary)
                    Text(command.name)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 6))
            }

            Spacer()

            if case .done = vm.generationState {
                Picker("", selection: $isPreview) {
                    Text("Preview").tag(true)
                    Text("Raw").tag(false)
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .frame(width: 150)
                .help("Preview renders the markdown; Raw shows the exact text that gets saved.")
            }

            toolbarAccessory()
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 9)
        .background(Color(nsColor: .windowBackgroundColor))
    }

    // MARK: - Content switcher

    @ViewBuilder
    private var content: some View {
        switch vm.generationState {
        case .idle:           setupView
        case .generating:     generatingView
        case .done(let text, let skipped): doneView(text: text, skipped: skipped)
        case .error(let msg): errorView(message: msg)
        }
    }

    // MARK: - Setup view

    private var setupView: some View {
        ScrollView {
            VStack(spacing: 16) {
                sourceSummaryCard
                stepsCard
            }
            .padding(20)
        }
    }

    // Sources summary
    private var sourceSummaryCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 6) {
                Image(systemName: "tray.and.arrow.down.fill")
                    .font(.system(size: 13))
                    .foregroundStyle(theme.current.accent.opacity(0.7))
                Text("Selected Sources")
                    .font(.callout.weight(.semibold))
                Spacer()
                if !vm.selectedSources.isEmpty {
                    Text("\(vm.selectedSources.count)")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(.white)
                        .frame(width: 20, height: 20)
                        .background(theme.current.accent, in: Circle())
                }
            }

            if vm.selectedSources.isEmpty {
                HStack(spacing: 10) {
                    Image(systemName: "tray")
                        .font(.system(size: 22))
                        .foregroundStyle(Color.secondary.opacity(0.3))
                    VStack(alignment: .leading, spacing: 3) {
                        Text("No sources selected")
                            .font(.callout.weight(.medium))
                            .foregroundStyle(.secondary)
                        Text(sourcesEmptyHint)
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                    }
                }
                .padding(14)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.secondary.opacity(0.05), in: RoundedRectangle(cornerRadius: 10))
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(vm.selectedSources.enumerated()), id: \.element) { idx, source in
                        HStack(spacing: 10) {
                            Image(systemName: sourceIcon(source))
                                .font(.system(size: 11))
                                .foregroundStyle(sourceColor(source))
                                .frame(width: 16)
                            Text(source.displayName)
                                .font(.callout)
                                .lineLimit(1)
                            Spacer()
                            Button {
                                vm.selectedSources.remove(source)
                            } label: {
                                Image(systemName: "xmark")
                                    .font(.system(size: 9, weight: .bold))
                                    .foregroundStyle(.tertiary)
                                    .frame(width: 18, height: 18)
                                    .background(Color.secondary.opacity(0.1), in: Circle())
                            }
                            .buttonStyle(.plain)
                        }
                        .padding(.vertical, 8)
                        .padding(.horizontal, 12)
                        .background(
                            idx % 2 == 0 ? Color.secondary.opacity(0.03) : Color.clear
                        )
                    }
                }
                .clipShape(RoundedRectangle(cornerRadius: 8))
                .overlay(
                    RoundedRectangle(cornerRadius: 8)
                        .strokeBorder(Color.secondary.opacity(0.1), lineWidth: 1)
                )
            }
        }
        .padding(16)
        .background(Color(nsColor: .windowBackgroundColor), in: RoundedRectangle(cornerRadius: 12))
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .strokeBorder(Color.secondary.opacity(0.1), lineWidth: 1)
        )
    }

    // Steps checklist
    private var stepsCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Steps to generate")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.tertiary)

            VStack(spacing: 6) {
                ForEach(Array(steps.enumerated()), id: \.offset) { idx, step in
                    stepRow(number: "\(idx + 1)", title: step.title, detail: step.detail, done: step.done)
                }
            }
        }
    }

    private func stepRow(number: String, title: String, detail: String, done: Bool) -> some View {
        HStack(alignment: .top, spacing: 12) {
            ZStack {
                Circle()
                    .fill(done ? theme.current.success.opacity(0.15) : theme.current.accent.opacity(0.1))
                    .frame(width: 24, height: 24)
                if done {
                    Image(systemName: "checkmark")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(theme.current.success)
                } else {
                    Text(number)
                        .font(.system(size: 11, weight: .bold, design: .rounded))
                        .foregroundStyle(theme.current.accent)
                }
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.callout.weight(.medium))
                    .foregroundStyle(done ? Color.secondary : .primary)
                    .strikethrough(done, color: .secondary)
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
            Spacer()
        }
        .padding(12)
        .background(
            done ? theme.current.success.opacity(0.04) : Color(nsColor: .windowBackgroundColor),
            in: RoundedRectangle(cornerRadius: 10)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 10)
                .strokeBorder(
                    done ? theme.current.success.opacity(0.18) : Color.secondary.opacity(0.08),
                    lineWidth: 1)
        )
        .animation(.easeInOut(duration: 0.2), value: done)
    }

    // MARK: - Generating view

    /// Pulled out of the `Text` interpolation below as a plain, explicitly
    /// typed `String` — a chained `??` over two different optional types
    /// inside a string interpolation is a known SwiftUI type-checker
    /// blowup ("unable to type-check this expression in reasonable time").
    /// `swift build` passing on one toolchain/cache doesn't clear it; giving
    /// the type-checker an already-resolved `String` avoids the risk
    /// entirely instead of relying on staying under whatever the current
    /// limit happens to be.
    private var generatingTitle: String {
        vm.selectedTemplate?.name ?? vm.selectedCommand?.name ?? "document"
    }

    private var generatingView: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                HStack(spacing: 10) {
                    ProgressView().controlSize(.small)
                    Text("Generating \"\(generatingTitle)\" with Claude…")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
                .padding(14)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(theme.current.accent.opacity(0.06), in: RoundedRectangle(cornerRadius: 10))

                if let template = vm.selectedTemplate {
                    ForEach(Array(template.sections.enumerated()), id: \.offset) { idx, section in
                        VStack(alignment: .leading, spacing: 8) {
                            HStack(spacing: 5) {
                                Text("##")
                                    .font(.system(.callout, design: .monospaced))
                                    .foregroundStyle(theme.current.accent.opacity(0.4))
                                Text(section)
                                    .font(.system(.callout, design: .monospaced).weight(.semibold))
                            }
                            VStack(alignment: .leading, spacing: 5) {
                                ForEach(0..<3, id: \.self) { line in
                                    RoundedRectangle(cornerRadius: 3)
                                        .fill(Color.secondary.opacity(0.1))
                                        .frame(width: line == 2 ? 100 : .infinity, height: 9)
                                        .shimmer(delay: Double(idx) * 0.1 + Double(line) * 0.04)
                                }
                            }
                        }
                        .padding(14)
                        .background(Color(nsColor: .windowBackgroundColor), in: RoundedRectangle(cornerRadius: 10))
                        .overlay(
                            RoundedRectangle(cornerRadius: 10)
                                .strokeBorder(Color.secondary.opacity(0.08), lineWidth: 1)
                        )
                    }
                }
            }
            .padding(20)
        }
    }

    // MARK: - Done view

    private func doneView(text: String, skipped: [String] = []) -> some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: "checkmark.circle.fill").foregroundStyle(theme.current.success)
                Text(vm.isSaved
                     ? "Saved — press Start another to generate a new document"
                     : "Document ready — press Edit in the right panel to revise it with a prompt")
                    .font(.caption).foregroundStyle(.secondary)
                Spacer()
                HStack(spacing: 4) {
                    Image(systemName: "lock")
                        .font(.caption2)
                    Text("Read-only")
                        .font(.caption2)
                }
                .foregroundStyle(.tertiary)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .background(theme.current.success.opacity(0.06))

            if !skipped.isEmpty {
                HStack(spacing: 6) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.caption2)
                        .foregroundStyle(theme.current.warning)
                    Text("\(skipped.count) source\(skipped.count == 1 ? "" : "s") could not be read and were skipped: \(skipped.joined(separator: ", "))")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Spacer()
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 6)
                .background(theme.current.warning.opacity(0.08))
            }

            Divider()

            // Always read-only: manual typing is removed entirely. Revising
            // the document is prompt-driven — see the Edit button in
            // `GenerationPromptBar`, which sends the current text back through
            // `/generate-doc` with the user's instruction as the prompt.
            //
            // This used to be `TextEditor(...).disabled(true)`, which is why a
            // long document could not be read: `.disabled` puts `isEnabled`
            // false into the environment, and that stops the editor's scroll
            // view responding as well as its text accepting input. Read-only was
            // the right intent; disabling the whole control was the wrong means.
            Group {
                if isPreview {
                    // A WKWebView, so it scrolls natively and renders fenced
                    // code through the bundled highlight.js. Same renderer the
                    // Library uses for a .md file.
                    // Mermaid ON here specifically: a generated architecture
                    // doc is exactly where a ```mermaid dependency graph shows
                    // up, this panel scrolls itself (so the async render does
                    // not disturb a measured height), and the fence-gating in
                    // MarkdownRenderer keeps the 3.4 MB bundle out of documents
                    // that have no diagram.
                    MarkdownWebView(markdown: vm.editedContent,
                                    isDark: theme.current.isDark,
                                    enableMermaid: true)
                } else {
                    ScrollView {
                        Text(vm.editedContent)
                            .font(.system(.callout, design: .monospaced))
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(14)
                    }
                    .background(Color(nsColor: .textBackgroundColor))
                }
            }
            .onAppear { if vm.editedContent.isEmpty { vm.editedContent = text } }
            .onChange(of: text) { _, new in vm.editedContent = new }
        }
    }

    // MARK: - Error view

    private func errorView(message: String) -> some View {
        VStack(spacing: 20) {
            ZStack {
                Circle()
                    .fill(theme.current.danger.opacity(0.1))
                    .frame(width: 64, height: 64)
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.system(size: 24))
                    .foregroundStyle(theme.current.danger.opacity(0.7))
            }
            VStack(spacing: 6) {
                Text("Generation Failed").font(.headline)
                Text(message)
                    .font(.callout).foregroundStyle(.secondary)
                    .multilineTextAlignment(.center).frame(maxWidth: 340)
            }
            Button("Try Again") { vm.resetToIdle() }
                .buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - Helpers

    private func sourceIcon(_ source: DocGenSource) -> String {
        switch source {
        case .meeting: return "calendar"
        case .file(let url, _):
            switch url.pathExtension.lowercased() {
            case "md", "txt": return "doc.text"
            case "pdf":       return "doc.richtext"
            case "csv", "xlsx", "xls": return "tablecells"
            case "json":      return "curlybraces"
            default:          return "doc"
            }
        }
    }

    private func sourceColor(_ source: DocGenSource) -> Color {
        switch source {
        case .meeting: return .orange
        case .file:    return .blue
        }
    }
}

/// Convenience initializer for callers with no trailing toolbar control
/// (Doc Gen) — its toolbar renders exactly as it did before this file
/// existed: `Spacer()` followed by nothing.
extension GenerationEditorPanel where ToolbarAccessory == EmptyView {
    init(vm: GenerationViewModel,
         api: LlmIdeAPIClient,
         sourcesEmptyHint: String,
         steps: [GenerationChecklistStep]) {
        self.init(vm: vm, api: api, sourcesEmptyHint: sourcesEmptyHint, steps: steps,
                  toolbarAccessory: { EmptyView() })
    }
}

// MARK: - Shimmer

private struct ShimmerModifier: ViewModifier {
    var delay: Double = 0
    @State private var phase: CGFloat = -1
    func body(content: Content) -> some View {
        content.overlay(
            GeometryReader { geo in
                LinearGradient(colors: [.clear, .white.opacity(0.4), .clear],
                               startPoint: .leading, endPoint: .trailing)
                    .frame(width: geo.size.width * 2)
                    .offset(x: phase * geo.size.width)
                    .animation(.linear(duration: 1.4).repeatForever(autoreverses: false).delay(delay),
                               value: phase)
                    .onAppear { phase = 1 }
            }
            .clipped()
        )
    }
}

private extension View {
    func shimmer(delay: Double = 0) -> some View { modifier(ShimmerModifier(delay: delay)) }
}
