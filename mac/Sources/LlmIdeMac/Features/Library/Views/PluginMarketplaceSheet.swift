import SwiftUI

/// Browse a Claude-format plugin **marketplace** — a Git repo listing several
/// plugins — and install any of them.
///
/// Two steps: paste the repo URL, then pick from what its
/// `.claude-plugin/marketplace.json` offers. The clone happens on this side
/// (`PluginMarketplace`), so the server keeps fetching no URLs of its own; each
/// install still goes through the ordinary zip endpoint and its validation.
struct PluginMarketplaceSheet: View {
    let api: LlmIdeAPIClient
    let onDismiss: () -> Void
    /// Called after at least one plugin installed, so the Library reloads.
    let onInstalled: () -> Void

    @State private var url = ""
    @State private var ref = ""
    @State private var staged: PluginMarketplace.Staged?
    @State private var loading = false
    @State private var installing: String?
    @State private var installed: Set<String> = []
    /// Entries already present on the server (from the plugin list, or learned
    /// from a 409): their button says "Update" and installs with replace.
    @State private var alreadyInstalled: Set<String> = []
    @State private var message: String?
    @State private var search = ""
    @FocusState private var urlFocused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(staged == nil ? "Add plugin marketplace" : "\(staged!.marketplaceName)")
                .font(.headline)

            if let staged {
                browse(staged)
            } else {
                entry
            }

            if let message {
                Text(message)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            HStack {
                if staged != nil {
                    Button("Choose another…") { reset() }
                }
                Spacer()
                Button(installed.isEmpty ? "Cancel" : "Done", role: installed.isEmpty ? .cancel : nil) {
                    finish()
                }
                if staged == nil {
                    Button("Browse") { Task { await load() } }
                        .buttonStyle(.borderedProminent)
                        .disabled(!isValidURL || loading)
                        .keyboardShortcut(.defaultAction)
                }
            }
        }
        .padding(20)
        .frame(width: 520, height: staged == nil ? 260 : 480)
        .onAppear { urlFocused = true }
        .onDisappear { staged?.cleanup() }
    }

    // MARK: - Step 1: the repo

    @ViewBuilder
    private var entry: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("A marketplace is a public repo with a .claude-plugin/marketplace.json listing its plugins. It is cloned locally — nothing is fetched by the server.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            VStack(alignment: .leading, spacing: 4) {
                Text("Git URL").font(.callout)
                TextField("https://github.com/owner/marketplace", text: $url)
                    .textFieldStyle(.roundedBorder)
                    .focused($urlFocused)
                    .onSubmit { if isValidURL { Task { await load() } } }
            }
            VStack(alignment: .leading, spacing: 4) {
                Text("Branch or tag (optional)").font(.callout)
                TextField("main", text: $ref)
                    .textFieldStyle(.roundedBorder)
            }
            if loading { ProgressView().controlSize(.small) }
        }
    }

    // MARK: - Step 2: what it offers

    @ViewBuilder
    private func browse(_ staged: PluginMarketplace.Staged) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            TextField("Filter", text: $search)
                .textFieldStyle(.roundedBorder)
            List {
                ForEach(filtered(staged.entries)) { entry in
                    HStack(alignment: .top, spacing: 10) {
                        VStack(alignment: .leading, spacing: 2) {
                            HStack(spacing: 6) {
                                Text(entry.name).font(.body.weight(.medium))
                                if let version = entry.version {
                                    Text("v\(version)").font(.caption).foregroundStyle(.secondary)
                                }
                            }
                            if !entry.description.isEmpty {
                                Text(entry.description)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(2)
                            }
                        }
                        Spacer()
                        if installed.contains(entry.name) {
                            Label("Installed", systemImage: "checkmark.circle.fill")
                                .labelStyle(.iconOnly)
                                .foregroundStyle(.green)
                        } else if installing == entry.name {
                            ProgressView().controlSize(.small)
                        } else if alreadyInstalled.contains(entry.name) {
                            Button("Update") { Task { await install(entry, from: staged, replace: true) } }
                                .disabled(installing != nil)
                                .help("Replace the installed copy with this marketplace's version")
                        } else {
                            Button("Install") { Task { await install(entry, from: staged, replace: false) } }
                                .disabled(installing != nil)
                        }
                    }
                    .padding(.vertical, 2)
                }
            }
            .listStyle(.inset)
            if !staged.skipped.isEmpty {
                // Named rather than hidden: a marketplace whose plugins live in
                // other repos would otherwise look half-empty for no reason.
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(staged.skipped, id: \.self) { note in
                        Text("Not installable here — \(note)")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
    }

    private func filtered(_ entries: [PluginMarketplace.Entry]) -> [PluginMarketplace.Entry] {
        let needle = search.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !needle.isEmpty else { return entries }
        return entries.filter {
            $0.name.lowercased().contains(needle) || $0.description.lowercased().contains(needle)
        }
    }

    private var isValidURL: Bool {
        let trimmed = url.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.count >= 8 && (trimmed.contains("://") || trimmed.hasPrefix("git@"))
    }

    // MARK: - Actions

    private func load() async {
        loading = true
        message = nil
        defer { loading = false }
        do {
            staged = try await PluginMarketplace.fetch(url: url, ref: ref.isEmpty ? nil : ref)
        } catch {
            message = error.localizedDescription
            return
        }
        // Best effort: a failed list only means the first click on an installed
        // entry comes back 409 and flips it to "Update" then.
        if let list = try? await api.listPlugins() {
            alreadyInstalled = Set(list.plugins.map(\.name))
        }
    }

    /// Install (or, with `replace`, update) one entry from the staged clone —
    /// no re-clone. A 409 does not fail: it marks the entry installed so its
    /// button turns into "Update", which is the user's confirmation to replace.
    private func install(_ entry: PluginMarketplace.Entry, from staged: PluginMarketplace.Staged,
                         replace: Bool) async {
        installing = entry.name
        defer { installing = nil }
        var zipURL: URL?
        defer { if let zipURL { try? FileManager.default.removeItem(at: zipURL) } }
        do {
            let packaged = try await PluginMarketplace.package(entry, from: staged)
            zipURL = packaged
            // Unrecordable provenance (e.g. a plugin at the repo root) is not an
            // install failure — install without a record.
            let source = try? staged.source(for: entry)
            let response = try await api.installPlugin(zipURL: packaged, replace: replace, source: source,
                                                       fallbackFileName: "\(entry.name).zip")
            installed.insert(entry.name)
            var text = response.plugin.replaced
                ? "Updated \(response.plugin.name) to v\(response.plugin.version)."
                : "Installed \(response.plugin.name). Enable it in the Plugins list to use it."
            if response.plugin.trustReset == true {
                text += " Its trust was reset — review and trust it again in the Plugins list."
            }
            message = text
        } catch let APIError.http(status, _, serverMessage, _)
                    where !replace && (status == 409 || serverMessage.contains("already installed")) {
            alreadyInstalled.insert(entry.name)
            message = "\(entry.name) is already installed. Choose Update to replace it with this version."
        } catch {
            message = "Could not install \(entry.name): \(error.localizedDescription)"
        }
    }

    private func reset() {
        staged?.cleanup()
        staged = nil
        search = ""
        message = nil
    }

    private func finish() {
        staged?.cleanup()
        staged = nil
        if !installed.isEmpty { onInstalled() }
        onDismiss()
    }
}
