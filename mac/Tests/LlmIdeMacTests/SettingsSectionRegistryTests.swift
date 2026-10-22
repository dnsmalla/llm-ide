import SwiftUI
import XCTest
@testable import LlmIdeMacLib

/// `SettingsSectionRegistry` contract: per-slot ordering, idempotent
/// re-registration, and empty slots. Uses a fresh instance per test — never
/// `.shared`, which the app's boot path also fills.
@MainActor
final class SettingsSectionRegistryTests: XCTestCase {
    private func ids(_ registry: SettingsSectionRegistry,
                     _ slot: SettingsSectionSlot) -> [String] {
        registry.sections(for: slot).map(\.id)
    }

    func testEmptySlotReturnsNoSections() {
        let registry = SettingsSectionRegistry()
        for slot in SettingsSectionSlot.allCases {
            XCTAssertEqual(registry.sections(for: slot).count, 0)
        }
    }

    func testSectionsSortByOrderThenRegistrationOrder() {
        let registry = SettingsSectionRegistry()
        registry.register(slot: .graph, id: "late", order: 10) { AnyView(EmptyView()) }
        registry.register(slot: .graph, id: "first", order: 0) { AnyView(EmptyView()) }
        registry.register(slot: .graph, id: "second", order: 0) { AnyView(EmptyView()) }
        // Another slot must not leak into this one.
        registry.register(slot: .connections, id: "connections") { AnyView(EmptyView()) }

        XCTAssertEqual(ids(registry, .graph), ["first", "second", "late"])
        XCTAssertEqual(ids(registry, .connections), ["connections"])
    }

    func testReRegisterReplacesWithoutDuplicatingOrMoving() {
        let registry = SettingsSectionRegistry()
        var builtByReplacement = false
        registry.register(slot: .sourceControl, id: "a") { AnyView(EmptyView()) }
        registry.register(slot: .sourceControl, id: "b") { AnyView(EmptyView()) }
        registry.register(slot: .sourceControl, id: "a") {
            builtByReplacement = true
            return AnyView(EmptyView())
        }

        let sections = registry.sections(for: .sourceControl)
        // Still one "a", still ahead of "b" (first-registration sequence kept).
        XCTAssertEqual(sections.map(\.id), ["a", "b"])
        _ = sections[0].make()
        XCTAssertTrue(builtByReplacement, "re-registration must replace the builder")
    }

    func testReRegisterWithNewOrderResorts() {
        let registry = SettingsSectionRegistry()
        registry.register(slot: .mobileControl, id: "a", order: 0) { AnyView(EmptyView()) }
        registry.register(slot: .mobileControl, id: "b", order: 1) { AnyView(EmptyView()) }
        registry.register(slot: .mobileControl, id: "a", order: 2) { AnyView(EmptyView()) }
        XCTAssertEqual(ids(registry, .mobileControl), ["b", "a"])
    }

    func testUnregisterRemovesOnlyThatSection() {
        let registry = SettingsSectionRegistry()
        registry.register(slot: .loopDefaults, id: "a") { AnyView(EmptyView()) }
        registry.register(slot: .loopDefaults, id: "b") { AnyView(EmptyView()) }
        registry.unregister(slot: .loopDefaults, id: "a")
        registry.unregister(slot: .graph, id: "missing")   // no-op
        XCTAssertEqual(ids(registry, .loopDefaults), ["b"])
    }
}
