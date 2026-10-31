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
            if key != PhoneApprovalPolicy.customWrite {   // the one deliberate escalation
                XCTAssertEqual(entry.tier, regTier, "\(key) differs from registry \(kind)")
            }
        }
    }

    func testEveryRiskyRegistryKindIsMirrored() throws {
        let reg = try registryTiers()
        let mirrored = Set(PhoneApprovalPolicy.table.values.compactMap(\.registryKind))
        for (kind, tier) in reg where tier.needsDesktopApproval {
            XCTAssertTrue(mirrored.contains(kind), "registry kind \(kind) (\(tier)) has no phone approval row")
        }
    }

    func testImplementAndShipAreT2AndCustomWritersAreT2() {
        XCTAssertEqual(PhoneApprovalPolicy.tier(forKey: "implementIssues"), .t2)
        XCTAssertEqual(PhoneApprovalPolicy.tier(forKey: "reviewMerge"), .t2)
        XCTAssertEqual(PhoneApprovalPolicy.tier(forKey: PhoneApprovalPolicy.customKey(writes: true)), .t2)
        XCTAssertEqual(PhoneApprovalPolicy.tier(forKey: PhoneApprovalPolicy.customKey(writes: nil)), .t2, "unknown defaults to T2")
        XCTAssertEqual(PhoneApprovalPolicy.tier(forKey: PhoneApprovalPolicy.customKey(writes: false)), .t1)
        XCTAssertEqual(PhoneApprovalPolicy.tier(forKey: "no-such-key"), .t2, "unknown fails closed")
        for key in ["sourceUpdate", "sourcesToIssue", "updateIssues", "loopEngineering", "generateDoc",
                    PhoneApprovalPolicy.loopStart, PhoneApprovalPolicy.loopStartStage, PhoneApprovalPolicy.generationRun] {
            XCTAssertTrue(PhoneApprovalPolicy.tier(forKey: key).needsDesktopApproval, key)
        }
    }
}
