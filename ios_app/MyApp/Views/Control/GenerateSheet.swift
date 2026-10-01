import SwiftUI
import SharedProtocol

/// Doc Gen / Visual from the phone. Pick a template or command, optionally add
/// a prompt and text files, and the Mac generates the document and SAVES it
/// under `llm-doc/generated/`. Visual is the same generator as Doc Gen and
/// returns Markdown text — the sheet says so rather than imply a picture.
struct GenerateSheet: View {
    @State var surface: String
    @EnvironmentObject var connection: ConnectionService
    @EnvironmentObject var store: GenerationStore
    @Environment(\.dismiss) private var dismiss

    @State private var templateId: String?
    @State private var commandId: String?
    @State private var prompt = ""
    @State private var files: [ChatFileText] = []
    @State private var showFilePicker = false
    @State private var openSaved = false

    private var isConnected: Bool { connection.connectionStatus == .connected }
    private var templates: [GenerationChoice] { store.options?.templates.filter { $0.surface == surface } ?? [] }
    private var commands: [GenerationChoice] { store.options?.commands.filter { $0.surface == surface } ?? [] }
    private var canGenerate: Bool {
        isConnected && !store.isRunning && !files.isEmpty && (templateId != nil || commandId != nil)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("Type", selection: $surface) {
                        Text("Doc Gen").tag("doc")
                        Text("Visual").tag("visual")
                    }
                    .pickerStyle(.segmented)
                } footer: {
                    Text(surface == "visual"
                         ? "Visual uses the Visual templates but produces a Markdown document from text sources — it doesn't draw images or diagrams."
                         : "Generates a Markdown document from a template or command and your sources.")
                }

                if let options = store.options, !options.available {
                    Section { Text("Open a project on the Mac to generate documents.")
                        .foregroundColor(DesignSystem.Colors.textSecondary) }
                } else if let error = store.optionsError, store.options == nil {
                    Section { Text(error).font(DesignSystem.Typography.footnoteFont)
                        .foregroundColor(DesignSystem.Colors.danger) }
                } else {
                    Section("Template") {
                        Picker("Template", selection: $templateId) {
                            Text("None").tag(String?.none)
                            ForEach(templates) { Text($0.name).tag(Optional($0.id)) }
                        }
                    }
                    Section("Command") {
                        Picker("Command", selection: $commandId) {
                            Text("None").tag(String?.none)
                            ForEach(commands) { Text($0.name).tag(Optional($0.id)) }
                        }
                    }
                    Section("Prompt (optional)") {
                        TextField("Anything to emphasise…", text: $prompt, axis: .vertical)
                            .lineLimit(1...5)
                    }
                    Section {
                        ForEach(Array(files.enumerated()), id: \.offset) { idx, file in
                            Label(file.name, systemImage: "doc.text")
                                .swipeActions { Button(role: .destructive) { files.remove(at: idx) } label: { Label("Remove", systemImage: "trash") } }
                        }
                        Button { showFilePicker = true } label: { Label("Add text file…", systemImage: "plus.circle") }
                    } header: {
                        Text("Sources")
                    } footer: {
                        Text("Text, Markdown or PDF. At least one source and a template or command are required.")
                    }
                    Section {
                        if store.isRunning {
                            HStack {
                                ProgressView()
                                Text("Generating on your Mac…").foregroundColor(DesignSystem.Colors.textSecondary)
                                Spacer()
                                Button("Stop", role: .destructive) { store.cancelRun() }
                            }
                        } else {
                            Button {
                                haptic(.medium)
                                store.run(surface: surface,
                                          template: templates.first { $0.id == templateId },
                                          command: commands.first { $0.id == commandId },
                                          prompt: prompt, sources: files)
                            } label: {
                                Text("Generate").font(DesignSystem.Typography.bodyFont.weight(.semibold))
                                    .frame(maxWidth: .infinity)
                            }
                            .disabled(!canGenerate)
                        }
                        if let error = store.runError {
                            Label(error, systemImage: "exclamationmark.triangle.fill")
                                .font(DesignSystem.Typography.footnoteFont)
                                .foregroundColor(DesignSystem.Colors.danger)
                        }
                    } footer: {
                        Text("Saved on your Mac in \(store.options?.saveFolder ?? "llm-doc/generated").")
                    }
                    if let result = store.result { resultSection(result) }
                }
            }
            .scrollContentBackground(.hidden)
            .background(DesignSystem.Colors.background.ignoresSafeArea())
            .navigationTitle("Generate")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarLeading) { Button("Done") { dismiss() } } }
            .navigationDestination(isPresented: $openSaved) {
                if let path = store.result?.savedPath { LlmDocFileView(path: path) }
            }
            .fileImporter(isPresented: $showFilePicker, allowedContentTypes: [.pdf, .plainText, .text]) { result in
                switch result {
                case .success(let url):
                    if let extracted = FileTextExtractor.extract(from: url) {
                        files.append(ChatFileText(name: extracted.name, text: extracted.text))
                    } else {
                        connection.errorMessage = "Couldn't read text from that file."
                    }
                case .failure(let err):
                    connection.errorMessage = err.localizedDescription
                }
            }
            .onChange(of: surface) { _ in templateId = nil; commandId = nil }
            .task { if store.options == nil { store.refreshOptions() } }
            .onChange(of: connection.connectionStatus) { status in
                if status == .connected { store.refreshOptions() }
            }
        }
    }

    @ViewBuilder
    private func resultSection(_ result: GenerationResult) -> some View {
        Section("Result") {
            if let path = result.savedPath {
                Label("Saved: llm-doc/\(path)", systemImage: "checkmark.circle.fill")
                    .foregroundColor(DesignSystem.Colors.success)
                    .font(DesignSystem.Typography.footnoteFont)
                Button { openSaved = true } label: { Label("Open the saved document", systemImage: "doc.richtext") }
            } else if let error = result.error {
                Label(error, systemImage: "exclamationmark.triangle.fill")
                    .font(DesignSystem.Typography.footnoteFont)
                    .foregroundColor(DesignSystem.Colors.danger)
            }
            if let notice = result.notice {
                Text(notice).font(DesignSystem.Typography.footnoteFont)
                    .foregroundColor(DesignSystem.Colors.textTertiary)
            }
            if let markdown = result.markdown {
                ShareLink(item: markdown) { Label("Share Markdown", systemImage: "square.and.arrow.up") }
                DisclosureGroup("Preview") { MarkdownDocumentView(text: markdown).padding(.top, 4) }
            }
        }
    }
}
