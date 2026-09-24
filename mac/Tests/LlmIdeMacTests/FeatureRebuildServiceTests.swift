import XCTest
@testable import LlmIdeMacLib

@MainActor
final class FeatureRebuildServiceTests: XCTestCase {

    func testDesiredCSVIsSortedRawValuesOfActiveFeatures() {
        let csv = FeatureRebuildService.featureCSV(
            for: [.agentChat, .autoTasks, .fileExplorer])
        XCTAssertEqual(csv, "agent_chat,auto_tasks,file_explorer")
    }

    func testEligibilityRequiresSourceRootAndBundleTarget() {
        XCTAssertNil(FeatureRebuildService.detectSourceRoot(
            plistValue: nil, fileExists: { _ in true }))
        XCTAssertNil(FeatureRebuildService.detectSourceRoot(
            plistValue: "/nonexistent", fileExists: { _ in false }))
        let root = FeatureRebuildService.detectSourceRoot(
            plistValue: "/repo/mac", fileExists: { $0.hasSuffix("Package.swift") })
        XCTAssertEqual(root?.path, "/repo/mac")
        XCTAssertNil(FeatureRebuildService.detectInstallTarget(
            bundleURL: URL(fileURLWithPath: "/usr/bin")))      // not an .app
        XCTAssertEqual(FeatureRebuildService.detectInstallTarget(
            bundleURL: URL(fileURLWithPath: "/tmp/LlmIdeMac.app"))?.lastPathComponent,
            "LlmIdeMac.app")
    }

    func testDriftDetection() {
        XCTAssertTrue(FeatureRebuildService.hasDrift(
            compiled: Set(AppFeature.allCases),
            active: Set(AppFeature.allCases).subtracting([.terminal])))
        XCTAssertFalse(FeatureRebuildService.hasDrift(
            compiled: Set(AppFeature.allCases),
            active: Set(AppFeature.allCases)))
    }

    /// Pins `AppFeature.buildTimeExcludable` — the single source of truth
    /// `FeatureRebuildService.hasDrift` reads and that `mac/Package.swift`'s
    /// `includedFeatures` key list must mirror. A change here without a
    /// matching Package.swift update silently breaks drift detection.
    func testBuildTimeExcludableSetIsPinned() {
        let csv = AppFeature.buildTimeExcludable.map(\.rawValue).sorted().joined(separator: ",")
        XCTAssertEqual(csv, "auto_tasks,code_graph_3d,doc_gen,file_explorer,gantt_issues,mobile_sync,terminal")
    }

    /// sign.sh treats an empty `.sign-identity` as "none" and signs ad-hoc,
    /// so the rebuild warning must too.
    func testEmptySignIdentityFileIsNotAStableIdentity() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let scripts = root.appendingPathComponent("Scripts")
        try FileManager.default.createDirectory(at: scripts, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let file = scripts.appendingPathComponent(".sign-identity")
        try "  \n".write(to: file, atomically: true, encoding: .utf8)
        XCTAssertFalse(FeatureRebuildService.hasSignIdentity(environment: [:], sourceRoot: root))
        try "LLM-IDE Dev\n".write(to: file, atomically: true, encoding: .utf8)
        XCTAssertTrue(FeatureRebuildService.hasSignIdentity(environment: [:], sourceRoot: root))
        XCTAssertTrue(FeatureRebuildService.hasSignIdentity(environment: ["LLMIDE_SIGN_IDENTITY": "X"], sourceRoot: nil))
    }
}
