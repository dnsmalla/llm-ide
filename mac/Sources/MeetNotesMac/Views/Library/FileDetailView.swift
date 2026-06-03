import SwiftUI
import PDFKit
import WebKit
import QuickLookUI
import AppKit

// MARK: - Entry point

struct FileDetailView: View {
    let url: URL
    @State private var reloadToken = UUID()

    var body: some View {
        Group {
            switch fileKind {
            case .markdown:  MarkdownDetailView(url: url)
            case .pdf:       PDFDetailView(url: url)
            case .image:     ImageDetailView(url: url)
            case .code:      CodeDetailView(url: url)
            case .quicklook: QuickLookDetailView(url: url)
            }
        }
        .id(url) // force view rebuild when url changes
        .navigationTitle(url.lastPathComponent)
        .navigationSubtitle(subtitle)
        .toolbar {
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
    @EnvironmentObject private var theme: ThemeStore

    var body: some View {
        EditableTextDetailView(url: url) { content in
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

    var body: some View {
        if let image = NSImage(contentsOf: url) {
            GeometryReader { geo in
                ScrollView([.horizontal, .vertical]) {
                    Image(nsImage: image)
                        .resizable()
                        .scaledToFit()
                        .frame(maxWidth: geo.size.width, maxHeight: geo.size.height)
                        .padding(20)
                }
            }
        } else {
            ContentUnavailableView("Can't Load Image", systemImage: "photo.slash",
                                   description: Text("The file may be corrupt or in an unsupported format."))
        }
    }
}

// MARK: - Code / plain text  (WKWebView — same engine as MarkdownDetailView)

struct CodeDetailView: View {
    let url: URL
    @EnvironmentObject private var theme: ThemeStore

    var body: some View {
        EditableTextDetailView(url: url) { content in
            CodeWebView(code: content, language: url.pathExtension, isDark: theme.current.isDark)
        }
    }
}

// MARK: - Shared editable text view (code + markdown)

/// Edit-first detail view for text-based files. Defaults to a
/// monospaced editor; users toggle to the read-only renderer
/// (syntax-highlighted code, rendered markdown) via the toolbar.
/// Tracks dirty state and saves to disk via Cmd+S or the Save button.
struct EditableTextDetailView<Preview: View>: View {
    let url: URL
    let preview: (String) -> Preview

    @State private var content: String = ""
    @State private var savedContent: String = ""
    @State private var loadError: String?
    @State private var saveError: String?
    @State private var isPreview: Bool = false
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
                .foregroundStyle(.green)
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
                .stroke(Color.green.opacity(0.35), lineWidth: 1)
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
                Text(err).font(.caption).foregroundStyle(.red).lineLimit(1).truncationMode(.middle)
            }
            Spacer()
            Button { showRevertConfirm = true } label: {
                Label("Revert", systemImage: "arrow.uturn.backward")
                    .foregroundStyle(isDirty ? .red : .secondary)
            }
            .buttonStyle(.bordered)
            .tint(.red)
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
        TextEditor(text: $content)
            .font(.system(size: 13, design: .monospaced))
            .textEditorStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(Color(nsColor: .textBackgroundColor))
            .frame(maxWidth: .infinity, maxHeight: .infinity)
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

struct CodeWebView: NSViewRepresentable {
    let code: String
    let language: String
    let isDark: Bool

    func makeNSView(context: Context) -> WKWebView {
        let wv = WKWebView(frame: .zero, configuration: WKWebViewConfiguration())
        wv.setValue(false, forKey: "drawsBackground")
        wv.loadHTMLString(html(), baseURL: nil)
        return wv
    }

    func updateNSView(_ wv: WKWebView, context: Context) {
        wv.loadHTMLString(html(), baseURL: nil)
    }

    /// Map a file extension to the highlight.js language id. Hint only —
    /// hljs.highlightAuto() handles unknown extensions reasonably.
    private static let hljsLanguageMap: [String: String] = [
        "swift": "swift", "ts": "typescript", "tsx": "typescript",
        "js": "javascript", "mjs": "javascript", "cjs": "javascript", "jsx": "javascript",
        "py": "python", "rb": "ruby", "go": "go", "rs": "rust",
        "java": "java", "kt": "kotlin",
        "c": "c", "h": "c", "cpp": "cpp", "hpp": "cpp", "cc": "cpp",
        "m": "objectivec", "mm": "objectivec",
        "json": "json", "md": "markdown", "yml": "yaml", "yaml": "yaml",
        "sh": "bash", "bash": "bash", "zsh": "bash",
        "html": "xml", "css": "css", "scss": "scss",
        "sql": "sql", "toml": "ini", "ini": "ini", "xml": "xml",
        "env": "bash", "dockerfile": "dockerfile", "makefile": "makefile",
    ]

    private var hljsLanguage: String {
        Self.hljsLanguageMap[language.lowercased()] ?? ""
    }

    private func html() -> String {
        // VSCode-flavoured theme. atom-one-dark / atom-one-light are
        // the closest matches and are widely cached on CDNs.
        let themeCSS = isDark
            ? "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/atom-one-dark.min.css"
            : "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/atom-one-light.min.css"
        let hljsJS = "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"

        let bg     = isDark ? "#1e1e1e" : "#fafafa"
        let fg     = isDark ? "#abb2bf" : "#383a42"
        let gutBg  = isDark ? "#21252b" : "#f0f0f0"
        let gutFg  = isDark ? "#5c6370" : "#9d9d9d"
        let border = isDark ? "#181a1f" : "#e5e5e5"
        let hoverBg = isDark ? "#2c313a" : "#f0f0f0"

        // HTML-escape the body once; the <pre><code class="language-X">
        // wrapper lets highlight.js process it after DOMContentLoaded.
        let escaped = code
            .replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")

        let classAttr = hljsLanguage.isEmpty ? "" : " class=\"language-\(hljsLanguage)\""

        return """
        <!DOCTYPE html>
        <html>
        <head>
        <meta charset="utf-8">
        <link rel="stylesheet" href="\(themeCSS)">
        <style>
          * { margin:0; padding:0; box-sizing:border-box; }
          html, body { height:100%; background:\(bg); }
          body {
            font-family: 'SF Mono', 'Menlo', 'Monaco', 'Courier New', monospace;
            font-size: 12.5px;
            line-height: 1.6;
            color: \(fg);
          }
          /* Grid: [line-number] [code] — line numbers stay aligned even
             after hljs wraps tokens in nested spans. */
          .editor {
            display: grid;
            grid-template-columns: auto 1fr;
            min-width: 100%;
          }
          .ln-col, .code-col {
            white-space: pre;
            padding: 0;
            font: inherit;
          }
          .ln-col {
            position: sticky;
            left: 0;
            padding: 0 14px 0 10px;
            text-align: right;
            color: \(gutFg);
            background: \(gutBg);
            border-right: 1px solid \(border);
            user-select: none;
            -webkit-user-select: none;
            min-width: 56px;
          }
          .code-col { padding: 0 24px 0 14px; overflow-x: auto; }
          .ln, .row { display: block; }
          .row:hover, .ln:hover { background: \(hoverBg); }
          /* hljs adds .hljs to <code>; reset its own background so the
             page background shows through cleanly. */
          .code-col code, .code-col code.hljs { background: transparent !important; padding: 0; }
        </style>
        </head>
        <body>
        <div class="editor">
          <div class="ln-col" id="ln"></div>
          <div class="code-col"><pre><code\(classAttr) id="code">\(escaped)</code></pre></div>
        </div>
        <script src="\(hljsJS)"></script>
        <script>
          (function() {
            var code = document.getElementById('code');
            try {
              if (window.hljs) { window.hljs.highlightElement(code); }
            } catch (e) { /* leave plain text on failure */ }
            // Build the line-number column from the FINAL line count
            // (post-highlight html may still preserve line breaks).
            var text = code.textContent || '';
            var lines = text.split('\\n');
            // Trailing blank line from a final \\n: drop it so the
            // gutter doesn't show a phantom number.
            if (lines.length && lines[lines.length - 1] === '') lines.pop();
            var ln = document.getElementById('ln');
            var out = '';
            for (var i = 0; i < lines.length; i++) {
              out += '<span class="ln">' + (i + 1) + '</span>\\n';
            }
            ln.innerHTML = out || '<span class="ln">1</span>';
          })();
        </script>
        </body>
        </html>
        """
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
/// Both can fire when LibraryItemStore.pruneCodeItems() removes items
/// while a QuickLook preview is on screen: SwiftUI re-renders the
/// parent list, tears down the old QLPreviewBox (deactivating the
/// QLPreviewView), and fires updateNSView one final time during the
/// same layout transaction.
///
/// Defence layers:
///   - `dismantleNSView` clears the preview item before teardown
///   - `updateNSView` checks file existence + skips same-URL no-ops
///   - `AppShell.pruneCodeLibrary` defers mutation via
///     `DispatchQueue.main.async` so it lands after the current
///     SwiftUI render pass
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
        // pruneCodeItems() can delete the backing file while the
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
