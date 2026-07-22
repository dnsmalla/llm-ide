import SwiftUI

struct DocGenEditorPanel: View {
    @ObservedObject var vm: DocGenViewModel
    let api: LlmIdeAPIClient

    @EnvironmentObject private var theme: ThemeStore
    @EnvironmentObject private var projectStore: ProjectStore
    @State private var editableContent: String = ""

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
            } else {
                HStack(spacing: 6) {
                    Image(systemName: "arrow.left")
                        .font(.system(size: 10))
                        .foregroundStyle(.tertiary)
                    Text("Choose a template from the left panel")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                }
            }

            Spacer()

            toolbarActions
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 9)
        .background(Color(nsColor: .windowBackgroundColor))
    }

    // MARK: - Toolbar action buttons

    @ViewBuilder
    private var toolbarActions: some View {
        switch vm.generationState {
        case .idle, .error:
            Button { vm.generate(api: api) } label: {
                HStack(spacing: 6) {
                    Image(systemName: "sparkles")
                        .font(.system(size: 11, weight: .semibold))
                    Text("Generate")
                        .font(.callout.weight(.semibold))
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 7)
                .background(
                    RoundedRectangle(cornerRadius: 8)
                        .fill(vm.canGenerate ? theme.current.accent : Color.secondary.opacity(0.18))
                )
                .foregroundStyle(vm.canGenerate ? .white : Color.secondary.opacity(0.5))
            }
            .buttonStyle(.plain)
            .disabled(!vm.canGenerate)
            .animation(.easeInOut(duration: 0.15), value: vm.canGenerate)

        case .generating:
            Button { vm.cancelGeneration() } label: {
                HStack(spacing: 6) {
                    Image(systemName: "stop.fill").font(.system(size: 10))
                    Text("Cancel").font(.callout.weight(.medium))
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 7)
                .background(Color.secondary.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))
            }
            .buttonStyle(.plain)

        case .done(let content, _):
            HStack(spacing: 8) {
                Button { vm.generate(api: api) } label: {
                    HStack(spacing: 5) {
                        Image(systemName: "arrow.clockwise").font(.system(size: 11))
                        Text("Regenerate").font(.callout)
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                    .background(Color.secondary.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))
                }
                .buttonStyle(.plain)

                Button {
                    let root = projectStore.activeProject
                        .map { URL(fileURLWithPath: $0.localPath) }
                    let exportText = editableContent.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                        ? content
                        : editableContent
                    vm.exportMarkdown(content: exportText, api: api, projectRoot: root)
                } label: {
                    HStack(spacing: 5) {
                        Image(systemName: "arrow.down.circle.fill").font(.system(size: 12))
                        Text("Export .md").font(.callout.weight(.semibold))
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 7)
                    .background(theme.current.accent, in: RoundedRectangle(cornerRadius: 8))
                    .foregroundStyle(.white)
                }
                .buttonStyle(.plain)
            }
        }
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
                if vm.canGenerate { generateCTAButton }
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
                        Text("Check files from Notes or Data in the left panel.")
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
                stepRow(
                    number: "1",
                    title: "Choose a template",
                    detail: "Select from the Template section on the left",
                    done: vm.selectedTemplate != nil)
                stepRow(
                    number: "2",
                    title: "Select sources",
                    detail: "Check files from Notes or Data on the left",
                    done: !vm.selectedSources.isEmpty)
                stepRow(
                    number: "3",
                    title: "Generate",
                    detail: "Claude will produce a structured document",
                    done: false)
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

    private var generateCTAButton: some View {
        Button { vm.generate(api: api) } label: {
            HStack(spacing: 8) {
                Image(systemName: "sparkles")
                    .font(.system(size: 14, weight: .semibold))
                Text("Generate Document")
                    .font(.callout.weight(.semibold))
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 13)
            .background(theme.current.accent, in: RoundedRectangle(cornerRadius: 10))
            .foregroundStyle(.white)
        }
        .buttonStyle(.plain)
        .transition(.opacity.combined(with: .move(edge: .bottom)))
    }

    // MARK: - Generating view

    private var generatingView: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                HStack(spacing: 10) {
                    ProgressView().controlSize(.small)
                    if let t = vm.selectedTemplate {
                        Text("Generating \"\(t.name)\" with Claude…")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                    }
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
                Text("Document ready — edit below, then export as Markdown (.md)")
                    .font(.caption).foregroundStyle(.secondary)
                Spacer()
                HStack(spacing: 4) {
                    Image(systemName: "pencil").font(.caption2)
                    Text("Editable").font(.caption2)
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

            TextEditor(text: Binding(
                get: { editableContent.isEmpty && !text.isEmpty ? text : editableContent },
                set: { editableContent = $0 }
            ))
            .font(.system(.callout, design: .monospaced))
            .scrollContentBackground(.hidden)
            .background(Color(nsColor: .textBackgroundColor))
            .onAppear { editableContent = text }
            .onChange(of: text) { _, new in editableContent = new }
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
