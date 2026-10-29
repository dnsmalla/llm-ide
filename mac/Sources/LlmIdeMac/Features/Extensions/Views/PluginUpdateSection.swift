import SwiftUI

/// The "Updates" block of the plugin detail pane: what the check reported, the
/// update / re-fetch / replace-from-file buttons, and the last result. Split
/// out of `PluginDetailView`; behaviour is unchanged. Update state lives in
/// `PluginUpdateCenter` (app-lifetime), so a result survives leaving the pane.
struct PluginUpdateSection: View {
    @EnvironmentObject private var theme: ThemeStore
    let plugin: PluginInfo
    let pluginName: String
    let api: LlmIdeAPIClient
    let oneClick: Bool
    let expectSupported: Bool
    /// Runs a (forced) update check; owned by the detail pane.
    let onCheck: () async -> Void

    private var updateCenter: PluginUpdateCenter { .shared }
    private var updateEntry: PluginUpdateEntry? { updateCenter.entry(for: pluginName) }
    private var checkingUpdates: Bool { updateCenter.checking }
    private var updatePending: Bool { updateCenter.inFlight.contains(pluginName) }
    private var updateResult: PluginUpdateCenter.Result? { updateCenter.results[pluginName] }

    /// How a plugin updates (see `PluginUpdatePresentation.action`).
    static func action(for plugin: PluginInfo, entry: PluginUpdateEntry?, oneClick: Bool,
                       expectSupported: Bool) -> PluginUpdatePresentation.UpdateAction {
        PluginUpdatePresentation.action(for: plugin, entry: entry, oneClick: oneClick,
                                        expectSupported: expectSupported)
    }

    /// A git / marketplace / file install gets the block (only on a server that
    /// honours `?expect=`, which `action` already folds in); an imported vendor
    /// plugin only on a v60+ server (the one-click route), as before.
    static func shows(action: PluginUpdatePresentation.UpdateAction, oneClick: Bool) -> Bool {
        switch action {
        case .gitReinstall, .marketplaceReinstall, .replaceFromFile: return true
        case .claudeOneClick, .reimportClaude, .reimportCodex: return oneClick
        case .none: return false
        }
    }

    private var action: PluginUpdatePresentation.UpdateAction {
        Self.action(for: plugin, entry: updateEntry, oneClick: oneClick, expectSupported: expectSupported)
    }

    private var isSourceInstall: Bool {
        action == .gitReinstall || action == .marketplaceReinstall
    }

    /// The version the user knows the copy as: the import stamp, else the
    /// check's view of Claude's install, else the normalized manifest version
    /// (which reads "0.0.0" for a sha-versioned plugin).
    private var shownVersion: String {
        [plugin.sourceVersion, updateEntry?.importedVersion, updateEntry?.claudeVersion]
            .compactMap { $0 }.first { !$0.isEmpty } ?? plugin.version
    }

    var body: some View {
        if Self.shows(action: action, oneClick: oneClick) {
            VStack(alignment: .leading, spacing: 6) {
                Text("Updates").font(.headline)
                if action == .replaceFromFile {
                    Text("Installed from a file — choose a newer .zip to replace it.")
                        .font(.callout).foregroundStyle(.secondary)
                } else if checkingUpdates {
                    HStack(spacing: 6) {
                        ProgressView().controlSize(.small)
                        Text("Checking for updates…").font(.callout).foregroundStyle(.secondary)
                    }
                } else if let updateEntry {
                    Label(availabilityText(updateEntry), systemImage: "arrow.triangle.2.circlepath")
                        .font(.callout)
                        .foregroundStyle(theme.current.warning)
                } else {
                    Text("No update reported for v\(shownVersion).")
                        .font(.callout).foregroundStyle(.secondary)
                }
                HStack(spacing: 8) {
                    updateButtons
                }
                if let updateResult, !updateResult.message.isEmpty {
                    Text(updateResult.message)
                        .font(.caption)
                        .foregroundStyle(updateResult.failed ? theme.current.danger : .secondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                }
            }
        }
    }

    private func availabilityText(_ entry: PluginUpdateEntry) -> String {
        if isSourceInstall, let kind = plugin.installSource?.kind {
            return PluginUpdatePresentation.sourceAvailabilityText(kind: kind, latest: entry.latest)
        }
        return PluginUpdatePresentation.availabilityText(entry)
    }

    @ViewBuilder
    private var updateButtons: some View {
        if updatePending {
            ProgressView().controlSize(.small)
            Text("Updating…").font(.callout).foregroundStyle(.secondary)
        } else if action == .replaceFromFile {
            Button("Replace from file…") { replaceFromFile() }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .disabled(updateCenter.isUpdating)
        } else {
            // A Claude import can always be re-fetched (its one-click route);
            // a source or Codex install only updates when a check reports one.
            if (plugin.origin == "claude" && !isSourceInstall) || updateEntry != nil {
                updateButton
            }
        }
        if action != .replaceFromFile {
            Button("Check for updates") { Task { await onCheck() } }
                .buttonStyle(.bordered)
                .controlSize(.small)
                // A forced check runs `claude plugin marketplace update`; not during any update.
                .disabled(checkingUpdates || updateCenter.isUpdating)
        }
    }

    @ViewBuilder
    private var updateButton: some View {
        let button = Button(PluginUpdatePresentation.buttonTitle(tier: updateEntry?.tier)) {
            updateCenter.startUpdate(name: pluginName, api: api, oneClick: oneClick, origin: .detail)
        }
        .buttonStyle(.bordered)
        .controlSize(.small)
        .disabled(checkingUpdates || updateCenter.isUpdating)
        // Same emphasis as the import sheet's "Update": tinted only when an
        // update is actually reported, plain for a speculative re-fetch.
        if updateEntry != nil {
            button.tint(theme.current.warning)
        } else {
            button
        }
    }

    /// Pick the newer .zip here; the center runs the replace, so its result
    /// survives a section switch.
    private func replaceFromFile() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.zip]
        panel.allowsMultipleSelection = false
        panel.message = "Choose the new .zip for \(plugin.title)"
        panel.prompt = "Replace"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        updateCenter.startReplaceFromFile(name: pluginName, zipURL: url, api: api, oneClick: oneClick)
    }
}
