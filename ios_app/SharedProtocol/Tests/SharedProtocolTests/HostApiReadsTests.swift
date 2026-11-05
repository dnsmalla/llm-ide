import Testing
import Foundation
import SharedProtocol

@Suite("HostApiReadGate + HostApiReadMapping")
struct HostApiReadMappingTests {
    @Test("the gate is on only for v1 with read granted; never optimistic, never on v2")
    func gate() {
        #expect(HostApiReadGate.isOn(apiVersion: 1, capabilities: ["host", "chat", "read"]))
        #expect(!HostApiReadGate.isOn(apiVersion: 1, capabilities: ["host", "chat"]))
        #expect(!HostApiReadGate.isOn(apiVersion: 1, capabilities: nil))
        #expect(!HostApiReadGate.isOn(apiVersion: 2, capabilities: ["read", "usage"]))
        #expect(!HostApiReadGate.isOn(apiVersion: 2, capabilities: nil))
    }

    typealias Model = HostApiUsageGetResultProvidersItemModelsItem

    @Test("one provider: label wins, capped and uncapped detail, ms → s reset, no permission mode")
    func oneProvider() {
        let r = HostApiUsageGetResult(providers: [.init(activeModel: "claude-sonnet", models: [
            Model(label: "Sonnet", limit: 100, model: "claude-sonnet", pct: 42, resetAt: 1_700_000_000_000,
                  state: "ok", unit: "runs", used: 42, window: "daily"),
            Model(limit: 0, model: "claude-haiku", resetAt: 0, state: "ok", unit: "tokens", used: 900, window: "monthly"),
        ], provider: "claude", status: "ok")])
        let s = HostApiReadMapping.usageState(r)
        #expect(s.provider == "claude")
        #expect(s.status == "ok")
        #expect(s.activeModel == "claude-sonnet")
        #expect(s.permissionMode == "")
        #expect(s.subscription.isEmpty && s.subscriptionNote == nil && s.error == nil && s.statusReason == nil)
        #expect(s.models == [
            UsageMeter(name: "Sonnet", pct: 42, state: "ok", detail: "42 of 100 runs · Daily", resetsAt: 1_700_000_000),
            UsageMeter(name: "claude-haiku", pct: nil, state: "ok", detail: "900 tokens · Monthly, no cap", resetsAt: nil),
        ])
    }

    @Test("several providers: names are prefixed, the first non-ok status wins, empty stays empty")
    func severalProviders() {
        let m = Model(limit: 10, model: "m", resetAt: 0, state: "exhausted", unit: "runs", used: 10, window: "daily")
        let r = HostApiUsageGetResult(providers: [
            .init(models: [m], provider: "claude", status: "ok"),
            .init(models: [m], provider: "openai", status: "paused"),
        ])
        let s = HostApiReadMapping.usageState(r)
        #expect(s.provider == "claude, openai")
        #expect(s.status == "paused")
        #expect(s.models.map(\.name) == ["claude · m", "openai · m"])
        let empty = HostApiReadMapping.usageState(HostApiUsageGetResult(providers: []))
        #expect(empty.provider == nil && empty.status == nil && empty.models.isEmpty)
    }
}
