import Foundation

/// Finds a bundled web page (`<subdirectory>/index.html` under `Resources/`)
/// in every place the app's resources can live.
///
/// The same lookup `MonacoHost.indexURL()` uses, generalised to any
/// subdirectory: a plain `Bundle.main.url(...)` finds it in the shipped app
/// (`Scripts/build.sh` rsyncs `Resources/` into `Contents/Resources/`), but
/// not under `swift test`, where `Bundle.main` is the xctest runner and the
/// SwiftPM resource bundle (`LlmIdeMac_LlmIdeMacLib.bundle`) sits beside the
/// test bundle. That bundle is opened by URL: `Bundle(url:)` returns nil
/// rather than trapping. Never reference `Bundle.module` here.
enum BundledWebResources {
    static func indexURL(subdirectory: String) -> URL? {
        if let url = Bundle.main.url(forResource: "index", withExtension: "html", subdirectory: subdirectory) {
            return url
        }
        let bundleName = "LlmIdeMac_LlmIdeMacLib.bundle"
        let owning = Bundle(for: BundledWebResourcesLocator.self)
        var roots: [URL] = []
        for base in [owning.bundleURL, Bundle.main.bundleURL] {
            roots.append(base)
            roots.append(base.deletingLastPathComponent())
        }
        if let r = owning.resourceURL { roots.append(r) }
        if let r = Bundle.main.resourceURL { roots.append(r) }
        for root in roots {
            guard let bundle = Bundle(url: root.appendingPathComponent(bundleName)) else { continue }
            if let url = bundle.url(forResource: "index", withExtension: "html", subdirectory: subdirectory) {
                return url
            }
        }
        return nil
    }
}

private final class BundledWebResourcesLocator {}
