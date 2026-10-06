import Foundation

/// The update paths that replace a plugin from where it was installed — a git
/// URL, a marketplace entry, or a file the user picked. Stateless: the update
/// center owns sequencing, guards and results, and calls in here.
///
/// Every path sends `expectName: name`, so the server refuses (409
/// NAME_MISMATCH, nothing installed) a package that now names another plugin —
/// an update can never overwrite a different plugin.
enum PluginSourceReinstaller {
    /// Clone the recorded git URL / ref again and replace the plugin with it.
    /// The new git record (or, if it cannot be sent, a zip one) replaces the
    /// old, so the record always describes what is installed.
    static func git(name: String, source: PluginInstallSource?,
                    api: LlmIdeAPIClient) async -> PluginUpdateStep {
        guard let url = source?.url else { return incompleteRecord(name) }
        do {
            let response = try await api.installPluginFromGit(
                url: url, ref: source?.ref, replace: true, fallbackFileName: "\(name).zip", expectName: name)
            return reinstalled(name: name, response)
        } catch {
            return failed(name, error)
        }
    }

    /// Fetch the recorded marketplace again, find the plugin's entry and
    /// replace the plugin with it.
    static func marketplace(name: String, source: PluginInstallSource?,
                            api: LlmIdeAPIClient) async -> PluginUpdateStep {
        guard let source, let url = source.url else { return incompleteRecord(name) }
        do {
            let staged = try await PluginMarketplace.fetch(
                url: url, ref: source.ref, timeoutSec: PluginSourceUpdateChecker.networkTimeout)
            defer { staged.cleanup() }
            let entryName = source.entry ?? name
            guard let entry = staged.entries.first(where: { $0.name == entryName }) else {
                return .done(message: "Could not update \(name): not in the marketplace any more.",
                             succeeded: false, trustReset: false, stopsBatch: false)
            }
            let zipURL = try await PluginMarketplace.package(entry, from: staged)
            defer { try? FileManager.default.removeItem(at: zipURL) }
            let response = try await api.installPlugin(
                zipURL: zipURL, replace: true, source: try? staged.source(for: entry),
                fallbackFileName: "\(name).zip", expectName: name)
            return reinstalled(name: name, response)
        } catch {
            return failed(name, error)
        }
    }

    /// Replace `name` with a zip the user picked, in one upload. A file that
    /// holds another plugin is refused by the server; nothing is installed.
    static func replaceFromFile(name: String, zipURL: URL, api: LlmIdeAPIClient) async -> PluginUpdateStep {
        do {
            let response = try await api.installPlugin(
                zipURL: zipURL, replace: true, source: .zip(fileName: zipURL.lastPathComponent),
                fallbackFileName: "\(name).zip", expectName: name)
            let trustReset = response.plugin.trustReset == true
            return .done(message: PluginUpdatePresentation.replacedMessage(
                            name: name, version: response.plugin.version, trustReset: trustReset),
                         succeeded: true, trustReset: trustReset, stopsBatch: false)
        } catch {
            return failed(name, error)
        }
    }

    private static func reinstalled(name: String, _ response: PluginInstallResponse) -> PluginUpdateStep {
        let trustReset = response.plugin.trustReset == true
        return .done(message: PluginUpdatePresentation.reinstalledMessage(
                        name: name, version: response.plugin.version, trustReset: trustReset),
                     succeeded: true, trustReset: trustReset, stopsBatch: false)
    }

    private static func incompleteRecord(_ name: String) -> PluginUpdateStep {
        .done(message: "Could not update \(name): the install record is incomplete.",
              succeeded: false, trustReset: false, stopsBatch: false)
    }

    private static func failed(_ name: String, _ error: Error) -> PluginUpdateStep {
        .done(message: PluginUpdatePresentation.updateFailureMessage(name: name, error: error),
              succeeded: false, trustReset: false, stopsBatch: false)
    }
}
