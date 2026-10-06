import Foundation

/// The update paths that replace a plugin from where it was installed — a git
/// URL, a marketplace entry, or a file the user picked. Stateless: the update
/// center owns sequencing, guards and results, and calls in here.
enum PluginSourceReinstaller {
    /// Clone the recorded git URL / ref again and replace the plugin with it.
    /// The new git record (or, if it cannot be sent, a zip one) replaces the
    /// old, so the record always describes what is installed.
    static func git(name: String, source: PluginInstallSource?,
                    api: LlmIdeAPIClient) async -> PluginUpdateStep {
        guard let url = source?.url else { return incompleteRecord(name) }
        do {
            let response = try await api.installPluginFromGit(
                url: url, ref: source?.ref, replace: true, fallbackFileName: "\(name).zip")
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
            let staged = try await PluginMarketplace.fetch(url: url, ref: source.ref)
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
                fallbackFileName: "\(name).zip")
            return reinstalled(name: name, response)
        } catch {
            return failed(name, error)
        }
    }

    /// Replace `name` with a zip the user picked. Installs WITHOUT replace
    /// first: the file may hold a different plugin, and a blind replace would
    /// overwrite that other plugin instead. Only a 409 naming `name` itself
    /// confirms the file is the same plugin.
    static func replaceFromFile(name: String, zipURL: URL, api: LlmIdeAPIClient) async -> PluginUpdateStep {
        let source = PluginInstallSource.zip(fileName: zipURL.lastPathComponent)
        do {
            let fresh = try await api.installPlugin(zipURL: zipURL, replace: false, source: source)
            return .done(message: "That file holds \(fresh.plugin.name), not \(name). It was installed as a "
                            + "new plugin; \(name) is unchanged.",
                         succeeded: true, trustReset: false, stopsBatch: false)
        } catch let APIError.http(409, _, message, _) where message.contains("'\(name)'") {
            do {
                let response = try await api.installPlugin(zipURL: zipURL, replace: true, source: source)
                let trustReset = response.plugin.trustReset == true
                return .done(message: PluginUpdatePresentation.replacedMessage(
                                name: name, version: response.plugin.version, trustReset: trustReset),
                             succeeded: true, trustReset: trustReset, stopsBatch: false)
            } catch {
                return failed(name, error)
            }
        } catch APIError.http(409, _, _, _) {
            return .done(message: "That file holds a different plugin that is already installed. "
                            + "Nothing was replaced.",
                         succeeded: false, trustReset: false, stopsBatch: false)
        } catch {
            return failed(name, error)
        }
    }

    private static func reinstalled(name: String, _ response: PluginInstallResponse) -> PluginUpdateStep {
        let trustReset = response.plugin.trustReset == true
        return .done(message: PluginUpdatePresentation.reinstalledMessage(
                        name: name, installedName: response.plugin.name,
                        version: response.plugin.version, trustReset: trustReset),
                     succeeded: true, trustReset: trustReset, stopsBatch: false)
    }

    private static func incompleteRecord(_ name: String) -> PluginUpdateStep {
        .done(message: "Could not update \(name): the install record is incomplete.",
              succeeded: false, trustReset: false, stopsBatch: false)
    }

    private static func failed(_ name: String, _ error: Error) -> PluginUpdateStep {
        .done(message: "Could not update \(name): \(error.localizedDescription)",
              succeeded: false, trustReset: false, stopsBatch: false)
    }
}
