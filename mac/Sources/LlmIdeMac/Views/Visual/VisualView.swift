import SwiftUI
import ImageIO

// MARK: - VisualView
//
// Three-panel "Visual" section:
//   1. Library file tree (Data + Code) — the same FileTreePanel the
//      Review pages drive, so anything imported into the library
//      (presentation assets, datasets, repo folders) shows up here.
//   2. Image viewer — renders the selected image with a thumbnail
//      strip of its sibling images for quick flipping.
//   3. Chat — the shared CodeAssistantPanel, with the selected file
//      auto-attached so the user can ask about what they're viewing.

struct VisualView: View {
    let api: LlmIdeAPIClient

    @EnvironmentObject private var theme: ThemeStore
    @State private var treeSelectedURL: URL?
    @State private var treeVisible = true
    @State private var assistantVisible = true

    /// Persists the chat panel width across launches — same
    /// GeometryReader write-back workaround ReviewView uses, because
    /// HSplitView has no width binding.
    @AppStorage("MEETNOTES_VISUAL_CHAT_PANEL_WIDTH") private var chatPanelWidth: Double = 260

    var body: some View {
        VStack(spacing: 0) {
            SectionChromeBar(toggles: [
                SectionToggle(icon: "sidebar.left", isOn: treeVisible,
                              helpOn: "Hide library tree", helpOff: "Show library tree") {
                    withAnimation(.easeInOut(duration: 0.2)) { treeVisible.toggle() }
                }
            ]) {
                Button {
                    withAnimation(.easeInOut(duration: 0.2)) { assistantVisible.toggle() }
                } label: {
                    Image(systemName: "sidebar.right").symbolVariant(assistantVisible ? .fill : .none)
                }
                .buttonStyle(.borderless)
                .help(assistantVisible ? "Hide chat" : "Show chat")
            }
            Divider()
            // Fixed-width tree column outside HSplitView (HSplitView doesn't
            // reliably cap a leading child's width); HSplitView drives only
            // the image ↔ chat split.
            HStack(spacing: 0) {
            if treeVisible {
                FileTreePanel(title: "LIBRARY",
                              categories: [.data, .code],
                              selectedURL: $treeSelectedURL)
                    .frame(width: 240)
                    .transition(.move(edge: .leading))
                Divider()
            }

            HSplitView {
            ImageShowPanel(selectedURL: $treeSelectedURL)
                .frame(minWidth: 300, idealWidth: 520, maxWidth: .infinity)

            if assistantVisible {
                CodeAssistantPanel(api: api,
                                   initialURL: treeSelectedURL,
                                   showFileAttachButtons: true,
                                   showModelPicker: true)
                    .frame(minWidth: 160,
                           idealWidth: CGFloat(chatPanelWidth),
                           maxWidth: .infinity)
                    .background(
                        GeometryReader { geo in
                            Color.clear
                                .onChange(of: geo.size.width) { _, w in
                                    let clamped = max(160, Double(w))
                                    if abs(clamped - chatPanelWidth) > 1 {
                                        chatPanelWidth = clamped
                                    }
                                }
                        }
                    )
                    .transition(.move(edge: .trailing))
            }
            }
        }
        }
    }
}

// MARK: - ImageShowPanel

/// Middle panel: shows the selected library image at fit-to-panel
/// size with a sibling-image thumbnail strip underneath. Non-image
/// selections fall back to a hint so the user knows what this panel
/// is for without losing their tree selection.
struct ImageShowPanel: View {
    @Binding var selectedURL: URL?

    @EnvironmentObject private var theme: ThemeStore
    @State private var image: NSImage?
    @State private var siblings: [URL] = []
    /// Downsampled thumbnails keyed by file URL, decoded off the main
    /// thread. Rendering NSImage(contentsOf:) directly in the strip
    /// would synchronously decode every full-size sibling on every
    /// render pass.
    @State private var thumbnails: [URL: NSImage] = [:]
    @State private var thumbnailDir: URL?
    @State private var thumbnailTask: Task<Void, Never>?

    /// Formats NSImage can decode well enough to display.
    static let imageExtensions: Set<String> = [
        "png", "jpg", "jpeg", "gif", "heic", "heif", "webp",
        "bmp", "tiff", "tif", "svg", "ico", "icns",
    ]

    static func isImage(_ url: URL) -> Bool {
        imageExtensions.contains(url.pathExtension.lowercased())
    }

    private var selectionIsImage: Bool {
        selectedURL.map(Self.isImage) ?? false
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            content
            if !siblings.isEmpty {
                Divider()
                thumbnailStrip
            }
        }
        .background(theme.current.body)
        .onAppear { load(selectedURL) }
        .onChange(of: selectedURL) { _, url in load(url) }
    }

    // MARK: Header

    private var header: some View {
        HStack(spacing: 8) {
            SectionLabel("IMAGE")
            if let url = selectedURL, selectionIsImage {
                Text(url.lastPathComponent)
                    .font(Typography.filename)
                    .foregroundStyle(theme.current.textMuted)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            Spacer()
            if let url = selectedURL, selectionIsImage {
                if let image {
                    Text(pixelSize(of: image))
                        .font(Typography.fileMeta)
                        .foregroundStyle(theme.current.textMuted)
                }
                Button {
                    NSWorkspace.shared.activateFileViewerSelecting([url])
                } label: {
                    Image(systemName: "folder")
                        .font(.system(size: 11))
                }
                .buttonStyle(.borderless)
                .help("Reveal in Finder")
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(.bar)
    }

    // MARK: Content

    @ViewBuilder
    private var content: some View {
        if let image {
            GeometryReader { geo in
                Image(nsImage: image)
                    .resizable()
                    .scaledToFit()
                    .frame(width: geo.size.width, height: geo.size.height)
            }
            .padding(12)
        } else if let url = selectedURL, selectionIsImage {
            EmptyStateView(icon: "exclamationmark.triangle",
                           title: "Couldn't load image",
                           message: url.lastPathComponent)
        } else if selectedURL != nil {
            EmptyStateView(icon: "photo",
                           title: "Not an image",
                           message: "Select an image file (PNG, JPG, SVG, …) in the library tree to preview it here.")
        } else {
            EmptyStateView(icon: "photo.on.rectangle.angled",
                           title: "Select an image to view",
                           message: "Add image folders to the **Data** section of the library tree, then pick a file to preview it.")
        }
    }

    // MARK: Thumbnail strip

    private var thumbnailStrip: some View {
        ScrollViewReader { proxy in
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(siblings, id: \.absoluteString) { url in
                        thumbnail(for: url)
                            .id(url.absoluteString)
                    }
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
            }
            .frame(height: 64)
            .background(theme.current.surface)
            .onAppear {
                if let sel = selectedURL { proxy.scrollTo(sel.absoluteString) }
            }
            .onChange(of: selectedURL) { _, sel in
                if let sel { proxy.scrollTo(sel.absoluteString) }
            }
        }
    }

    @ViewBuilder
    private func thumbnail(for url: URL) -> some View {
        let isSelected = url == selectedURL
        Button {
            selectedURL = url
        } label: {
            Group {
                if let thumb = thumbnails[url] {
                    Image(nsImage: thumb)
                        .resizable()
                        .scaledToFill()
                } else {
                    Image(systemName: "photo")
                        .foregroundStyle(theme.current.textMuted)
                }
            }
            .frame(width: 64, height: 44)
            .clipShape(RoundedRectangle(cornerRadius: 5))
            .overlay(
                RoundedRectangle(cornerRadius: 5)
                    .stroke(isSelected ? theme.current.accent : .clear, lineWidth: 2)
            )
        }
        .buttonStyle(.plain)
        .help(url.lastPathComponent)
    }

    // MARK: Loading

    private func load(_ url: URL?) {
        guard let url, Self.isImage(url) else {
            image = nil
            siblings = []
            thumbnails = [:]
            thumbnailDir = nil
            thumbnailTask?.cancel()
            return
        }
        image = NSImage(contentsOf: url)
        siblings = siblingImages(of: url)
        buildThumbnails(for: siblings, dir: url.deletingLastPathComponent())
    }

    /// Decode strip thumbnails off the main thread, downsampled to
    /// strip size via ImageIO so a folder of full-resolution renders
    /// doesn't pin a CPU core or balloon memory. The cache survives
    /// flipping between images in the same folder and resets when the
    /// user moves to a different folder.
    private func buildThumbnails(for urls: [URL], dir: URL) {
        if dir != thumbnailDir {
            thumbnails = [:]
            thumbnailDir = dir
        }
        let missing = urls.filter { thumbnails[$0] == nil }
        guard !missing.isEmpty else { return }
        thumbnailTask?.cancel()
        thumbnailTask = Task.detached(priority: .utility) {
            for url in missing {
                if Task.isCancelled { return }
                guard let thumb = Self.downsampledImage(at: url, maxPixel: 128) else { continue }
                await MainActor.run { thumbnails[url] = thumb }
            }
        }
    }

    nonisolated private static func downsampledImage(at url: URL, maxPixel: Int) -> NSImage? {
        let options = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixel,
        ] as CFDictionary
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
              let cg = CGImageSourceCreateThumbnailAtIndex(source, 0, options) else { return nil }
        return NSImage(cgImage: cg, size: NSSize(width: cg.width, height: cg.height))
    }

    /// All displayable images in the same directory, alpha-sorted —
    /// powers the thumbnail strip so a folder of renders/screenshots
    /// can be flipped through without going back to the tree.
    private func siblingImages(of url: URL) -> [URL] {
        let dir = url.deletingLastPathComponent()
        let contents = (try? FileManager.default.contentsOfDirectory(
            at: dir,
            includingPropertiesForKeys: nil,
            options: [.skipsHiddenFiles])) ?? []
        let images = contents
            .filter(Self.isImage)
            .sorted { $0.lastPathComponent.localizedCaseInsensitiveCompare($1.lastPathComponent) == .orderedAscending }
        // A strip with only the selected image adds noise, not value.
        return images.count > 1 ? images : []
    }

    private func pixelSize(of image: NSImage) -> String {
        guard let rep = image.representations.first else { return "" }
        return "\(rep.pixelsWide)×\(rep.pixelsHigh)"
    }
}
