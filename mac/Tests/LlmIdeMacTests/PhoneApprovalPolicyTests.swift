import XCTest
@testable import LlmIdeMacLib

/// The Swift tier table must agree with schema/bus/registry.json, the single source of truth.
final class PhoneApprovalPolicyTests: XCTestCase {
    private func registryTiers() throws -> [String: PhoneApprovalTier] {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<4 { url.deleteLastPathComponent() }   // mac/Tests/LlmIdeMacTests/<file> -> repo root
        let data = try Data(contentsOf: url.appendingPathComponent("schema/bus/registry.json"))
        let root = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        let kinds = try XCTUnwrap(root["kinds"] as? [String: [String: Any]])
        var out: [String: PhoneApprovalTier] = [:]
        for (name, def) in kinds {
            if let clients = def["clients"] as? [String], !clients.contains("ios-native") { continue }   // desktop-only: no phone row
            switch def["tier"] as? String {
            case "T0": out[name] = .t0
            case "T1": out[name] = .t1
            case "T2": out[name] = .t2
            default: XCTFail("registry kind \(name) has an unknown tier \(String(describing: def["tier"]))")
            }
        }
        return out
    }

    func testEveryMirroredRowIsAtLeastAsStrictAsTheRegistry() throws {
        let reg = try registryTiers()
        for (key, entry) in PhoneApprovalPolicy.table {
            guard let kind = entry.registryKind else { continue }
            let regTier = try XCTUnwrap(reg[kind], "\(key) names registry kind \(kind), which does not exist")
            XCTAssertGreaterThanOrEqual(entry.tier, regTier, "\(key) is weaker than registry \(kind)")
            XCTAssertEqual(entry.tier, regTier, "\(key) differs from registry \(kind)")
        }
    }

    func testEveryRiskyRegistryKindIsMirrored() throws {
        let reg = try registryTiers()
        let mirrored = Set(PhoneApprovalPolicy.table.values.compactMap(\.registryKind))
        for (kind, tier) in reg where tier.needsDesktopApproval {
            XCTAssertTrue(mirrored.contains(kind), "registry kind \(kind) (\(tier)) has no phone approval row")
        }
    }

    /// The registry marks custom.run desktop-only (`clients: ["desktop-ui"]`); the phone must therefore refuse custom
    /// tasks outright and have no approval row that could start one.
    func testCustomRunIsDesktopOnlyInTheRegistryAndRefusedOnThePhone() throws {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<4 { url.deleteLastPathComponent() }
        let data = try Data(contentsOf: url.appendingPathComponent("schema/bus/registry.json"))
        let root = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        let kinds = try XCTUnwrap(root["kinds"] as? [String: [String: Any]])
        XCTAssertEqual(kinds["custom.run"]?["clients"] as? [String], ["desktop-ui"])
        XCTAssertFalse(PhoneApprovalPolicy.phoneMayRunCustomTasks)
        XCTAssertFalse(PhoneApprovalPolicy.table.values.contains { $0.registryKind == "custom.run" }, "no phone row may start custom.run")
    }

    func testImplementAndShipAreT2() {
        XCTAssertEqual(PhoneApprovalPolicy.tier(forKey: "implementIssues"), .t2)
        XCTAssertEqual(PhoneApprovalPolicy.tier(forKey: "reviewMerge"), .t2)
        XCTAssertEqual(PhoneApprovalPolicy.tier(forKey: "no-such-key"), .t2, "unknown fails closed")
        for key in ["sourceUpdate", "sourcesToIssue", "updateIssues", "loopEngineering", "generateDoc",
                    PhoneApprovalPolicy.loopStart, PhoneApprovalPolicy.loopStartStage, PhoneApprovalPolicy.generationRun] {
            XCTAssertTrue(PhoneApprovalPolicy.tier(forKey: key).needsDesktopApproval, key)
        }
    }
}
