import XCTest
import SharedProtocol
@testable import LlmIdeMacLib

final class MobileUsageBridgeTests: XCTestCase {
    private func stat(_ model: String, used: Double, limit: Int, pct: Double?, state: String = "ok",
                      enabled: Bool = true, kind: String = "daily") -> LlmIdeAPIClient.UsageModelStat {
        .init(model: model, label: nil, enabled: enabled, custom: nil, priority: 0, unit: "runs",
              windowKind: kind, limit: limit, thresholdPct: 80, used: used, pct: pct, state: state,
              quota: false, resetAt: "2026-10-02T10:00:00.000Z", tokens: nil)
    }

    func testModelMeterShowsCapOrNoCap() {
        let capped = MobileUsageBridge.meter(for: stat("opus", used: 42, limit: 100, pct: 42))
        XCTAssertEqual(capped.pct, 42)
        XCTAssertTrue(capped.detail.contains("42 of 100 runs"))
        XCTAssertNotNil(capped.resetsAt, "fractional-second ISO resetAt must parse")
        let uncapped = MobileUsageBridge.meter(for: stat("haiku", used: 7, limit: 0, pct: nil, kind: "monthly"))
        XCTAssertNil(uncapped.pct)
        XCTAssertTrue(uncapped.detail.contains("no cap") && uncapped.detail.contains("Monthly"))
    }

    func testDisabledModelsAreHiddenAndTheListIsCapped() {
        let models = (0..<30).map { stat("m\($0)", used: 1, limit: 10, pct: 10, enabled: $0 != 0) }
        let state = MobileUsageBridge.state(
            provider: "anthropic",
            summary: .init(active: .init(provider: "anthropic", model: "m1", status: "ok", resetAt: nil,
                                         reason: nil, used: nil, limit: nil, pct: nil, unit: nil, engaged: nil),
                           models: models),
            subscription: nil, subscriptionNote: "No login", permissionMode: "review", error: nil)
        XCTAssertEqual(state.models.count, MobileUsageBridge.maxModels)
        XCTAssertFalse(state.models.contains { $0.name == "m0" })
        XCTAssertEqual(state.subscriptionNote, "No login")
    }

    func testSubscriptionWindowsAndOverageNeverCarryAToken() throws {
        let usage = ClaudeSubscriptionUsageClient.Usage(
            mode: "enterprise",
            fiveHour: .init(pct: 91, resetsAt: Date(timeIntervalSince1970: 100)),
            sevenDay: .init(pct: nil, resetsAt: nil),
            extra: .init(usedCents: 1250, limitCents: 5000, pct: 25))
        let meters = MobileUsageBridge.meters(for: usage)
        XCTAssertEqual(meters.map(\.name), ["Session (5h)", "Overage credits"])   // weekly has no data
        XCTAssertEqual(meters[0].state, "warning")
        XCTAssertEqual(meters[1].detail, "$12.50 of $50.00")
        let json = String(data: try JSONEncoder().encode(
            MobileUsageBridge.state(provider: "anthropic", summary: nil, subscription: usage,
                                    subscriptionNote: nil, permissionMode: "auto", error: nil)), encoding: .utf8)!
        XCTAssertTrue(json.contains("\"permissionMode\":\"auto\""))
        XCTAssertFalse(json.lowercased().contains("token"))
    }

    func testPermissionModeIsOneOfTheMacChipValuesAndDefaultsToAsk() {
        let key = EditAcceptanceMode.defaultsKey
        let previous = UserDefaults.standard.object(forKey: key)
        defer { if let previous { UserDefaults.standard.set(previous, forKey: key) } else { UserDefaults.standard.removeObject(forKey: key) } }
        UserDefaults.standard.removeObject(forKey: key)
        XCTAssertEqual(MobileUsageBridge.currentPermissionMode(), "review")
        UserDefaults.standard.set("auto", forKey: key)
        XCTAssertEqual(MobileUsageBridge.currentPermissionMode(), "auto")
        UserDefaults.standard.set("garbage", forKey: key)
        XCTAssertEqual(MobileUsageBridge.currentPermissionMode(), "review")
    }
}
