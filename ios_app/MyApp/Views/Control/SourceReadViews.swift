import SwiftUI
import PDFKit
import SharedProtocol

/// History tab, desktop off: the way into Box documents and GitLab code at the source (read-only, live).
struct SourceRootSection: View {
    @EnvironmentObject var sources: SourceReadStore
    var body: some View {
        Section("At the source") {
            if sources.signedIn.isEmpty {
                Text("Sign in to GitLab or Box in Settings to read code and documents here, live and read-only.")
                    .font(.footnote).foregroundColor(.secondary)
            }
            if sources.signedIn.contains(.gitlab) { NavigationLink("GitLab code") { SourceBrowserView(provider: .gitlab, dir: nil) } }
            if sources.signedIn.contains(.box) { NavigationLink("Box documents") { SourceBrowserView(provider: .box, dir: nil) } }
        }
    }
}

struct SourceBrowserView: View {
    @EnvironmentObject var sources: SourceReadStore
    let provider: SourceProvider
    let dir: SourceEntry?
    @State private var entries: [SourceEntry] = []
    @State private var next: String?
    @State private var loading = false
    @State private var error: String?
    @State private var query = ""
    @State private var results: [SourceEntry]?

    private var shown: [SourceEntry] { results ?? entries }
    private var searchPrompt: String {
        provider == .gitlab ? (dir == nil ? "Search projects" : "Search code in this project") : (dir == nil ? "Search Box files" : "Search files in this folder")
    }

    var body: some View {
        List {
            if let error { Label(error, systemImage: "exclamationmark.triangle.fill").foregroundColor(DesignSystem.Colors.danger) }
            ForEach(shown) { e in row(e) }
            if loading { ProgressView().accessibilityLabel("Loading") }
            else if shown.isEmpty && error == nil { Text(results == nil ? "Nothing here." : "No results.").foregroundColor(.secondary) }
            if results == nil, next != nil { Button("More") { Task { await load(more: true) } }.disabled(loading) }
        }
        .navigationTitle(dir?.name ?? (provider == .gitlab ? "Projects" : "All files"))
        .searchable(text: $query, prompt: searchPrompt)
        .onSubmit(of: .search) { Task { await search() } }
        .onChange(of: query) { if $0.isEmpty { results = nil } }
        .refreshable { await load(more: false) }
        .task { if entries.isEmpty { await load(more: false) } }
    }

    @ViewBuilder private func row(_ e: SourceEntry) -> some View {
        if e.kind == .file {
            NavigationLink { SourceFileView(provider: provider, entry: e) } label: { label(e) }
        } else {
            NavigationLink { SourceBrowserView(provider: provider, dir: e) } label: { label(e) }
        }
    }
    private func label(_ e: SourceEntry) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Label(e.name, systemImage: e.kind == .file ? "doc.text" : e.kind == .project ? "shippingbox" : "folder")
            if results != nil, e.path != e.name { Text(e.path).font(.caption).foregroundColor(.secondary) }
            if let d = e.detail { Text(d).font(.caption.monospaced()).foregroundColor(.secondary).lineLimit(3) }
        }
        .accessibilityElement(children: .combine)
        .accessibilityHint(e.kind == .file ? "Opens read-only" : e.kind == .project ? "Opens this project" : "Opens this folder")
    }
    private func load(more: Bool) async {
        loading = true; error = nil
        defer { loading = false }
        do {
            let page = try await sources.client(provider).list(dir, cursor: more ? next : nil)
            entries = more ? entries + page.entries : page.entries
            next = page.next
        } catch { self.error = SourceReadStore.message(error) }
    }
    private func search() async {
        loading = true; error = nil
        defer { loading = false }
        do { results = try await sources.client(provider).search(query, within: dir).entries } catch { self.error = SourceReadStore.message(error) }
    }
}

struct SourceFileView: View {
    @EnvironmentObject var sources: SourceReadStore
    let provider: SourceProvider
    let entry: SourceEntry
    @State private var opened: SourceOpened?
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: DesignSystem.Spacing.sm) {
            if let error { Label(error, systemImage: "exclamationmark.triangle.fill").foregroundColor(DesignSystem.Colors.danger).padding(.horizontal) }
            if let o = opened {
                Text("\(o.entry.path) · \(o.language) · read-only").font(.footnote).foregroundColor(.secondary).padding(.horizontal)
                if o.truncated { Text("Only the first part is shown: the file is larger than this app shows.").font(.footnote).padding(.horizontal) }
                if let r = o.reason { Text(SourceReadStore.reasonText(r)).padding(.horizontal) }
                if o.kind == .extracted { Text("Text extracted by Box. Layout and images are not shown.").font(.footnote).foregroundColor(.secondary).padding(.horizontal) }
                if let t = o.text { SourceTextView(text: t, label: "Contents of \(o.entry.name)") }
                else if o.kind == .pdf, let d = o.data { SourcePDFView(data: d, label: "PDF \(o.entry.name)") }
                Spacer(minLength: 0)
            } else if error == nil { ProgressView("Opening…").frame(maxWidth: .infinity) }
        }
        .navigationTitle(entry.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                if let u = opened?.webURL, u.scheme == "https" { Link(provider == .gitlab ? "Open on GitLab" : "Open in Box", destination: u) }
            }
        }
        .task {
            guard opened == nil else { return }
            do { opened = try await sources.client(provider).open(entry) } catch { self.error = SourceReadStore.message(error) }
        }
    }
}

/// Read-only, selectable text; no link or data detection; scales with Dynamic Type.
struct SourceTextView: UIViewRepresentable {
    let text: String
    let label: String
    func makeUIView(context: Context) -> UITextView {
        let v = UITextView()
        v.isEditable = false; v.isSelectable = true; v.dataDetectorTypes = []
        v.font = UIFontMetrics(forTextStyle: .body).scaledFont(for: .monospacedSystemFont(ofSize: 13, weight: .regular))
        v.adjustsFontForContentSizeCategory = true
        v.backgroundColor = .clear
        v.textContainerInset = UIEdgeInsets(top: 8, left: 8, bottom: 8, right: 8)
        v.accessibilityLabel = label
        v.text = text
        return v
    }
    func updateUIView(_ v: UITextView, context: Context) { if v.text != text { v.text = text } }
}

/// PDFKit runs no PDF JavaScript; link taps are swallowed so a document cannot navigate anywhere.
struct SourcePDFView: UIViewRepresentable {
    let data: Data
    let label: String
    final class Coordinator: NSObject, PDFViewDelegate { func pdfViewWillClick(onLink sender: PDFView, with url: URL) {} }
    func makeCoordinator() -> Coordinator { Coordinator() }
    func makeUIView(context: Context) -> PDFView {
        let v = PDFView()
        v.autoScales = true
        v.delegate = context.coordinator
        v.document = PDFDocument(data: data)
        v.accessibilityLabel = label
        return v
    }
    func updateUIView(_ v: PDFView, context: Context) {}
}

/// Settings → Box and GitLab: the user's own app IDs, sign in, sign out, forget.
struct SourceReadSettingsCard: View {
    @EnvironmentObject var sources: SourceReadStore
    @State private var gitlabId = ""
    @State private var boxId = ""
    @State private var boxSecret = ""

    var body: some View {
        VStack(alignment: .leading, spacing: DesignSystem.Spacing.sm) {
            Text("BOX AND GITLAB")
                .font(DesignSystem.Typography.footnoteFont.weight(.semibold))
                .foregroundColor(DesignSystem.Colors.textTertiary)
                .padding(.leading, DesignSystem.Spacing.xs)
            VStack(alignment: .leading, spacing: DesignSystem.Spacing.sm) {
                Text("Read code and documents live at the source, read-only. Nothing is copied through sync.")
                    .font(DesignSystem.Typography.footnoteFont)
                rows(.gitlab)
                Divider()
                rows(.box)
                if let e = sources.lastError {
                    Text(e).font(DesignSystem.Typography.footnoteFont).foregroundColor(DesignSystem.Colors.textSecondary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(DesignSystem.Spacing.md)
            .background(DesignSystem.Colors.surface)
            .cornerRadius(DesignSystem.Layout.cornerRadiusL)
        }
    }

    @ViewBuilder private func rows(_ p: SourceProvider) -> some View {
        let name = p == .gitlab ? "GitLab" : "Box"
        if sources.configs[p] == nil {
            Text(p == .gitlab
                 ? "On gitlab.com add an application (Preferences → Applications): Confidential off, scopes read_api and read_repository, redirect URI \(SourceOAuth.redirectURI(.gitlab))."
                 : "Create a Box Custom App with User Authentication (OAuth 2.0), only “Read all files and folders”, redirect URI \(SourceOAuth.redirectURI(.box)). The secret is kept in this iPhone's Keychain.")
                .font(.footnote).foregroundColor(.secondary)
            if p == .gitlab {
                TextField("GitLab application ID", text: $gitlabId).autocapitalization(.none).autocorrectionDisabled().textFieldStyle(.roundedBorder)
            } else {
                TextField("Box client ID", text: $boxId).autocapitalization(.none).autocorrectionDisabled().textFieldStyle(.roundedBorder)
                SecureField("Box client secret", text: $boxSecret).textFieldStyle(.roundedBorder)
            }
            Button("Save \(name) app") { save(p) }
        } else if sources.signedIn.contains(p) {
            Text("\(name): signed in.")
            Button("Sign out of \(name)") { Task { await sources.signOut(p) } }
        } else {
            Button(sources.busy ? "Signing in…" : "Sign in to \(name)") { Task { await sources.signIn(p) } }.disabled(sources.busy)
            Button("Forget \(name) app", role: .destructive) { Task { await sources.forget(p) } }
        }
    }

    private func save(_ p: SourceProvider) {
        let trim = { (s: String) in s.trimmingCharacters(in: .whitespacesAndNewlines) }
        let c = p == .gitlab ? SourceAppConfig(clientId: trim(gitlabId)) : SourceAppConfig(clientId: trim(boxId), clientSecret: trim(boxSecret))
        boxSecret = ""
        if sources.configure(p, c) { gitlabId = ""; boxId = "" }
    }
}
