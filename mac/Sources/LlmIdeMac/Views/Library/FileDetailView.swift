import SwiftUI
import PDFKit
import WebKit
import QuickLookUI
import AppKit

// MARK: - Entry point

struct FileDetailView: View {
    let url: URL
    /// When set (Library detail pane), shows a close control that clears the
    /// selection so the file list can use the full detail column again.
    var onClose: (() -> Void)? = nil
    /// 1-based line to reveal once the editor has loaded (e.g. a search
    /// result's line-jump, P4). `nil` for the common "just open the file"
    /// case. Ignored by kinds that have no text editor (`.pdf`/`.image`/
    /// `.quicklook`).
    var initialLine: Int? = nil

    var body: some View {
        Group {
            switch fileKind {
            case .markdown:  MarkdownDetailView(url: url, initialLine: initialLine)
            case .pdf:       PDFDetailView(url: url)
            case .image:     ImageDetailView(url: url)
            case .code:      CodeDetailView(url: url, initialLine: initialLine)
            case .quicklook: QuickLookDetailView(url: url)
            }
        }
        .id(url) // force view rebuild when url changes
        .navigationTitle(url.lastPathComponent)
        .navigationSubtitle(subtitle)
        .toolbar { toolbarContent }
        .onExitCommand { onClose?() }
    }

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        if let onClose {
            ToolbarItem(placement: .cancellationAction) {
                Button(action: onClose) {
                    Label("Close", systemImage: "xmark")
                }
                .help("Close file (Esc)")
                .keyboardShortcut(.escape, modifiers: [])
            }
        }
        ToolbarItem(placement: .primaryAction) {
            Button(action: { NSWorkspace.shared.open(url) }) {
                Label("Open in App", systemImage: "arrow.up.right.square")
            }
            .help("Open in default app")
        }
        ToolbarItem(placement: .primaryAction) {
            Button(action: { NSWorkspace.shared.activateFileViewerSelecting([url]) }) {
                Label("Reveal", systemImage: "folder")
            }
            .help("Reveal in Finder")
        }
    }

    private enum FileKind { case markdown, pdf, image, code, quicklook }

    private var fileKind: FileKind {
        switch url.pathExtension.lowercased() {
        case "md", "markdown":
            return .markdown
        case "pdf":
            return .pdf
        case "png", "jpg", "jpeg", "gif", "tiff", "bmp", "webp", "heic", "svg":
            return .image
        case "swift", "py", "js", "ts", "jsx", "tsx", "html", "css",
             "json", "yaml", "yml", "toml", "sh", "bash", "zsh", "rb", "go",
             "rs", "kt", "java", "cpp", "c", "h", "m", "mm",
             "txt", "log", "csv", "tsv", "xml", "ini", "env", "gitignore",
             "makefile", "dockerfile":
            return .code
        default:
            return .quicklook
        }
    }

    private var subtitle: String {
        let ext = url.pathExtension.uppercased()
        if let attrs = try? FileManager.default.attributesOfItem(atPath: url.path),
           let bytes = attrs[.size] as? Int {
            let size = ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)
            return "\(ext) · \(size)"
        }
        return ext
    }
}

// MARK: - Markdown (WKWebView with inline JS renderer)

struct MarkdownDetailView: View {
    let url: URL
    var initialLine: Int? = nil
    @EnvironmentObject private var theme: ThemeStore

    var body: some View {
        EditableTextDetailView(url: url, startInPreview: true, language: "markdown",
                               initialLine: initialLine) { content in
            MarkdownWebView(markdown: content, isDark: theme.current.isDark)
        }
    }
}

struct MarkdownWebView: NSViewRepresentable {
    let markdown: String
    let isDark: Bool

    func makeNSView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        let webView = WKWebView(frame: .zero, configuration: config)
        webView.setValue(false, forKey: "drawsBackground")
        load(into: webView)
        return webView
    }

    func updateNSView(_ nsView: WKWebView, context: Context) {
        load(into: nsView)
    }

    private func load(into webView: WKWebView) {
        webView.loadHTMLString(buildHTML(), baseURL: nil)
    }

    private func buildHTML() -> String {
        MarkdownRenderer.html(for: markdown, isDark: isDark)
    }
}

// MARK: - PDF

struct PDFDetailView: NSViewRepresentable {
    let url: URL

    func makeNSView(context: Context) -> PDFView {
        let v = PDFView()
        v.document = PDFDocument(url: url)
        v.autoScales = true
        v.displayMode = .singlePageContinuous
        v.displayDirection = .vertical
        return v
    }

    func updateNSView(_ nsView: PDFView, context: Context) {
        if nsView.document?.documentURL != url {
            nsView.document = PDFDocument(url: url)
        }
    }
}

// MARK: - Image

struct ImageDetailView: View {
    let url: URL
    @State private var image: NSImage?
    @State private var failed = false

    var body: some View {
        Group {
            if let image {
                GeometryReader { geo in
                    ScrollView([.horizontal, .vertical]) {
                        Image(nsImage: image)
                            .resizable()
                            .scaledToFit()
                            .frame(maxWidth: geo.size.width, maxHeight: geo.size.height)
                            .padding(20)
                    }
                }
            } else if failed {
                ContentUnavailableView("Can't Load Image", systemImage: "photo.slash",
                                       description: Text("The file may be corrupt or in an unsupported format."))
            } else {
                ProgressView()
            }
        }
        // Decode off the main thread (was NSImage(contentsOf:) in the body getter,
        // re-running each render and blocking the UI — bad on iCloud/Dropbox folders).
        .task(id: url) {
            failed = false
            image = nil
            let loaded = await Task.detached(priority: .userInitiated) { NSImage(contentsOf: url) }.value
            if loaded == nil { failed = true } else { image = loaded }
        }
    }
}

// MARK: - Code / plain text (Monaco-backed)

struct CodeDetailView: View {
    let url: URL
    var initialLine: Int? = nil
    @EnvironmentObject private var theme: ThemeStore
    @EnvironmentObject private var config: AppConfig
    @EnvironmentObject private var projectStore: ProjectStore

    @State private var changedLines: [Int: GitGutter.Mark] = [:]
    @State private var gitTruthStore = GitTruthStore()

    var body: some View {
        EditableTextDetailView(
            url: url,
            onSaved: { await refreshGutter() },
            startInPreview: true,   // open code highlighted (read-only); Edit is one toggle away
            language: MonacoLanguageMap.id(for: url.pathExtension),
            decorations: changedLines,
            initialLine: initialLine
        ) { content in
            MonacoEditorView(
                content: .constant(content),
                language: MonacoLanguageMap.id(for: url.pathExtension),
                decorations: changedLines,
                readOnly: true
            )
        }
        .task(id: url) { await refreshGutter() }
    }

    /// Compute git change markers for `url`'s containing repo via
    /// `GitTruthStore` (design §7's data flow: `refresh` populates
    /// `byPath` so `lineMarks` can tell an untracked/new file — which has
    /// no HEAD blob to diff — from a normally-diffable one). No-op (empty
    /// map) when the file isn't inside a git repo — never blocks the editor.
    @MainActor
    private func refreshGutter() async {
        let preferred = WorkspaceRoot.gitWorkingTree(config: config, projectStore: projectStore)
        guard let repo = Self.containingRepo(of: url, preferred: preferred) else {
            changedLines = [:]
            return
        }
        let relPath = Self.relativePath(of: url, inside: repo)
        await gitTruthStore.refresh(root: repo)
        changedLines = await gitTruthStore.lineMarks(root: repo, path: relPath)
    }

    /// Resolve the git repo that contains `url`: prefer `preferred` when the
    /// file lives inside it, else walk up parent directories looking for `.git`.
    private static func containingRepo(of url: URL, preferred: URL?) -> URL? {
        let filePath = url.standardizedFileURL.path
        if let preferred {
            let root = preferred.standardizedFileURL.path
            if filePath == root || filePath.hasPrefix(root + "/") { return preferred }
        }
        var dir = url.standardizedFileURL.deletingLastPathComponent()
        let fm = FileManager.default
        while true {
            let gitPath = dir.appendingPathComponent(".git").path
            if fm.fileExists(atPath: gitPath) { return dir }
            let parent = dir.deletingLastPathComponent()
            if parent.path == dir.path { return nil }  // reached filesystem root
            dir = parent
        }
    }

    /// Path of `url` relative to `repo` (falls back to last path component).
    private static func relativePath(of url: URL, inside repo: URL) -> String {
        let root = repo.standardizedFileURL.path
        let file = url.standardizedFileURL.path
        if file.hasPrefix(root + "/") {
            return String(file.dropFirst(root.count + 1))
        }
        return url.lastPathComponent
    }
}

// MARK: - Shared editable text view (code + markdown)

/// Edit-first detail view for text-based files. Defaults to a
/// monospaced editor; users toggle to the read-only renderer
/// (syntax-highlighted code, rendered markdown) via the toolbar.
/// Tracks dirty state and saves to disk via Cmd+S or the Save button.
struct EditableTextDetailView<Preview: View, Accessory: View>: View {
    let url: URL
    var onSaved: (() async -> Void)? = nil
    /// Monaco language id for the editor (Task 1's `MonacoLanguageMap`, or a
    /// literal like `"markdown"`). Callers own this decision — the shared
    /// editor doesn't infer a language from `url` itself.
    var language: String = "plaintext"
    /// Git gutter marks for the editor, keyed by line number. Empty for
    /// content types (markdown) that don't track a git gutter.
    var decorations: [Int: GitGutter.Mark] = [:]
    /// Optional Monaco line-jump target for `MonacoRevealRequest`
    /// (design's line-jump API — P4's search results are the first real
    /// caller). `nil` for the common "just open the file" case.
    var initialLine: Int? = nil
    /// Optional toolbar accessory rendered just left of Revert/Save.
    let accessory: () -> Accessory
    let preview: (String) -> Preview

    init(url: URL,
         onSaved: (() async -> Void)? = nil,
         startInPreview: Bool = false,
         language: String = "plaintext",
         decorations: [Int: GitGutter.Mark] = [:],
         initialLine: Int? = nil,
         @ViewBuilder accessory: @escaping () -> Accessory,
         @ViewBuilder preview: @escaping (String) -> Preview) {
        self.url = url
        self.onSaved = onSaved
        self.language = language
        self.decorations = decorations
        self.initialLine = initialLine
        self.accessory = accessory
        self.preview = preview
        // Code/markdown open in the rendered/highlighted Preview by default
        // (the VS Code "view" experience); Edit is one toggle away.
        _isPreview = State(initialValue: startInPreview)
    }

    @State private var content: String = ""
    @State private var savedContent: String = ""
    @State private var revealRequest: MonacoRevealRequest?
    @State private var loadError: String?
    @State private var saveError: String?
    @State private var isPreview: Bool
    @State private var saving: Bool = false
    @State private var showSavedToast: Bool = false
    @State private var showRevertConfirm: Bool = false

    @EnvironmentObject private var theme: ThemeStore

    private var isDirty: Bool { content != savedContent }

    var body: some View {
        ZStack(alignment: .top) {
            VStack(spacing: 0) {
                toolbar
                Divider()
                if let err = loadError {
                    ContentUnavailableView("Can't Read File", systemImage: "doc.slash",
                                           description: Text(err))
                } else if isPreview {
                    preview(content)
                } else {
                    editor
                }
            }
            if showSavedToast {
                savedToast
                    .transition(.move(edge: .top).combined(with: .opacity))
                    .padding(.top, 8)
                    .zIndex(1)
            }
        }
        .task(id: url) { await load() }
        .confirmationDialog(
            "Discard unsaved changes?",
            isPresented: $showRevertConfirm,
            titleVisibility: .visible
        ) {
            Button("Discard Changes", role: .destructive) {
                Task { await revert() }
            }
            Button("Cancel", role: .cancel) { }
        } message: {
            Text("Your edits to \(url.lastPathComponent) will be lost. This can't be undone.")
        }
    }

    private var savedToast: some View {
        HStack(spacing: 8) {
            Image(systemName: "checkmark.circle.fill")
                .foregroundStyle(theme.current.success)
            Text("Saved \(url.lastPathComponent)")
                .font(.system(size: 12, weight: .medium))
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .background(
            RoundedRectangle(cornerRadius: 8)
                .fill(.regularMaterial)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .stroke(theme.current.success.opacity(0.35), lineWidth: 1)
        )
        .shadow(color: .black.opacity(0.15), radius: 8, y: 2)
    }

    private var toolbar: some View {
        HStack(spacing: 10) {
            // Mode toggle
            Picker("", selection: $isPreview) {
                Text("Edit").tag(false)
                Text("Preview").tag(true)
            }
            .pickerStyle(.segmented)
            .frame(width: 140)
            // Dirty / clean indicator
            if isDirty {
                HStack(spacing: 4) {
                    Circle().fill(theme.current.accent).frame(width: 6, height: 6)
                    Text("Unsaved changes").font(.caption).foregroundStyle(.secondary)
                }
            } else if !content.isEmpty {
                Text("Saved").font(.caption).foregroundStyle(.secondary)
            }
            if let err = saveError {
                Text(err).font(.caption).foregroundStyle(theme.current.danger).lineLimit(1).truncationMode(.middle)
            }
            Spacer()
            accessory()
            Button { showRevertConfirm = true } label: {
                Label("Revert", systemImage: "arrow.uturn.backward")
                    .foregroundStyle(isDirty ? theme.current.danger : .secondary)
            }
            .buttonStyle(.bordered)
            .tint(theme.current.danger)
            .disabled(!isDirty || saving)
            .help("Discard unsaved changes")

            Button {
                Task { await saveWithToast() }
            } label: {
                Label(saving ? "Saving…" : "Save", systemImage: "square.and.arrow.down")
            }
            .buttonStyle(.borderedProminent)
            .tint(.accentColor)
            .controlSize(.regular)
            .keyboardShortcut("s", modifiers: .command)
            .disabled(!isDirty || saving || loadError != nil)
            .help("Save (⌘S)")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
    }

    private var editor: some View {
        MonacoEditorView(
            content: $content,
            language: language,
            decorations: decorations,
            revealRequest: revealRequest,
            onRequestSave: { Task { await saveWithToast() } }
        )
        .onChange(of: content) { _, _ in
            // Clear stale save-errors when the user resumes editing.
            saveError = nil
        }
    }

    @MainActor
    private func load() async {
        loadError = nil
        saveError = nil
        do {
            // Read off the main actor so a large file doesn't stall the editor.
            let fileURL = url
            let raw = try await Task.detached(priority: .userInitiated) {
                try String(contentsOf: fileURL, encoding: .utf8)
            }.value
            content = raw
            savedContent = raw
            if let initialLine {
                revealRequest = MonacoRevealRequest(line: initialLine)
            }
        } catch {
            loadError = "The file could not be decoded as text. (\(error.localizedDescription))"
            content = ""
            savedContent = ""
        }
    }

    @MainActor
    private func save() async {
        guard isDirty else { return }
        saving = true
        defer { saving = false }
        saveError = nil
        do {
            try content.write(to: url, atomically: true, encoding: .utf8)
            savedContent = content
            await onSaved?()
        } catch {
            saveError = "Save failed: \(error.localizedDescription)"
        }
    }

    @MainActor
    private func revert() async {
        content = savedContent
        saveError = nil
    }

    /// Wrapper around save() that flashes a toast on success so the
    /// user gets a clear "yes, it persisted" confirmation, distinct
    /// from the inline "Saved" status text.
    @MainActor
    private func saveWithToast() async {
        let wasDirty = isDirty
        await save()
        if wasDirty && saveError == nil {
            withAnimation(.easeOut(duration: 0.2)) { showSavedToast = true }
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            withAnimation(.easeIn(duration: 0.25)) { showSavedToast = false }
        }
    }
}

extension EditableTextDetailView where Accessory == EmptyView {
    /// Convenience init for callers that don't need a toolbar accessory.
    init(url: URL,
         onSaved: (() async -> Void)? = nil,
         startInPreview: Bool = false,
         language: String = "plaintext",
         decorations: [Int: GitGutter.Mark] = [:],
         initialLine: Int? = nil,
         @ViewBuilder preview: @escaping (String) -> Preview) {
        self.init(url: url, onSaved: onSaved, startInPreview: startInPreview,
                  language: language, decorations: decorations, initialLine: initialLine,
                  accessory: { EmptyView() }, preview: preview)
    }
}

// MARK: - QuickLook (office, pptx, docx, etc.)

/// Office formats like .docx / .pptx / .xlsx often produce only a
/// thumbnail-style icon from QLPreviewView — macOS's bundled QuickLook
/// plugin doesn't render their body in-place. Pair the preview with a
/// useful fallback UI (file icon + name + size + "Open" CTA) so the
/// user always has a clear next step.
struct QuickLookDetailView: View {
    let url: URL
    @EnvironmentObject private var theme: ThemeStore

    var body: some View {
        VStack(spacing: 0) {
            QLPreviewBox(url: url)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            Divider()
            fileMetaBar
        }
    }

    private var fileMetaBar: some View {
        HStack(spacing: 12) {
            Image(nsImage: NSWorkspace.shared.icon(forFile: url.path))
                .resizable()
                .frame(width: 28, height: 28)
            VStack(alignment: .leading, spacing: 2) {
                Text(url.lastPathComponent)
                    .font(.system(size: 13, weight: .medium))
                    .lineLimit(1)
                    .truncationMode(.middle)
                Text(metaLine)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 12)
            Button {
                NSWorkspace.shared.open(url)
            } label: {
                Label("Open", systemImage: "arrow.up.right.square")
            }
            .controlSize(.large)
            .buttonStyle(.borderedProminent)
            .help("Open with the default app for this file type")
            Button {
                NSWorkspace.shared.activateFileViewerSelecting([url])
            } label: {
                Label("Reveal", systemImage: "folder")
            }
            .controlSize(.large)
            .help("Reveal in Finder")
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(theme.current.surface)
    }

    private var metaLine: String {
        let ext = url.pathExtension.uppercased()
        let size: String
        if let attrs = try? FileManager.default.attributesOfItem(atPath: url.path),
           let bytes = attrs[.size] as? Int {
            size = ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)
        } else {
            size = "—"
        }
        return "\(ext) · \(size) · Preview limited — click Open to view the full document."
    }
}

/// Wraps QLPreviewView for SwiftUI embedding.
///
/// QLPreviewView has two internal assertions that trigger SIGABRT:
///   1. `item == nil` — setting a nil preview item
///   2. `internalState != QLPreviewDeactivatedInternalState` — calling
///      setPreviewItem while the view is being torn down by its host
///
/// Both can fire when a `rescan()` (e.g. after `remove(id:)` or a folder
/// un-link) drops items while a QuickLook preview is on screen: SwiftUI
/// re-renders the parent list, tears down the old QLPreviewBox (deactivating
/// the QLPreviewView), and fires updateNSView one final time during the
/// same layout transaction.
///
/// Defence layers:
///   - `dismantleNSView` clears the preview item before teardown
///   - `updateNSView` checks file existence + skips same-URL no-ops
private struct QLPreviewBox: NSViewRepresentable {
    let url: URL

    func makeNSView(context: Context) -> QLPreviewView {
        let v = QLPreviewView(frame: .zero, style: .normal) ?? QLPreviewView()
        v.previewItem = url as QLPreviewItem
        v.autostarts = true
        return v
    }

    func updateNSView(_ nsView: QLPreviewView, context: Context) {
        // Guard 1: skip if the file no longer exists on disk.
        // A delete (remove(id:)) can remove the backing file while the
        // preview is on screen.
        guard FileManager.default.fileExists(atPath: url.path) else { return }

        // Guard 2: skip if the URL hasn't changed.
        guard (nsView.previewItem as? URL) != url else { return }

        // Guard 3: skip if QLPreviewView has been deactivated
        // internally. When SwiftUI tears down the view hierarchy
        // (e.g. .id(url) changed → destroy + recreate), the
        // QLPreviewView enters a deactivated state. Calling
        // setPreviewItem in that state triggers the _QLRaiseAssert
        // assertion. Check via window attachment as a proxy — a
        // deactivated view is always detached from the window.
        guard nsView.window != nil else { return }

        nsView.previewItem = url as QLPreviewItem
    }

    /// Called by SwiftUI just before the NSView is removed from the
    /// view hierarchy. Nil out the preview item so QLPreviewView
    /// transitions to its deactivated state cleanly — without this,
    /// a final updateNSView call during teardown can race against
    /// the deactivation and trigger the assertion.
    static func dismantleNSView(_ nsView: QLPreviewView, coordinator: ()) {
        nsView.previewItem = nil
    }
}
