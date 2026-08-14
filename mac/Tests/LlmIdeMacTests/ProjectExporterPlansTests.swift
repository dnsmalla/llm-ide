import XCTest
@testable import LlmIdeMacLib

/// Tests the plan-writing half of `ProjectExporter` (the network-free units):
/// `plansMarkdown(plan:)` and `writePlans(_:projectRoot:)`.
///
/// Plans land in the PROJECT tree at `<projectRoot>/llm-doc/plans/` — the
/// note-type directory convention (see `ProjectLayout.plansDir`).
///
/// `LlmIdeAPIClient` is `final`, so `export()` itself can't be exercised with a
/// fake client — instead these units are tested directly, which is where the
/// real logic lives. `export()` / `exportPlans()` are thin shells that fetch a
/// bundle and hand it to these units.
@MainActor
final class ProjectExporterPlansTests: XCTestCase {

    private let fm = FileManager.default

    // MARK: - plansMarkdown

    func testPlansMarkdownRendersTitleGoalAndStatusCheckboxes() {
        let exporter = ProjectExporter()
        let done = task(id: "t1", position: 0, title: "Write spec",
                        owner: "alice", estimateDays: 2, status: "done")
        let active = task(id: "t2", position: 1, title: "Build API",
                          owner: "bob", estimateDays: 5, status: "in_progress")
        let plan = plan(title: "Q3 Launch", goal: "Ship the mobile companion",
                        createdAt: "2026-08-14T10:00:00Z", tasks: [done, active])

        let md = exporter.plansMarkdown(plan: plan)

        XCTAssertTrue(md.contains("# Q3 Launch"), "plan title should be an H1")
        XCTAssertTrue(md.contains("Ship the mobile companion"), "goal body present")
        XCTAssertTrue(md.contains("- [x] Write spec"), "done task → checked box")
        XCTAssertTrue(md.contains("alice"), "owner rendered")
        XCTAssertTrue(md.contains("Estimate"), "estimate label rendered")
        XCTAssertTrue(md.contains("- [ ] Build API"), "in_progress → unchecked box")
    }

    func testPlansMarkdownMarksBlockedAndCancelledTasksDistinctly() {
        let exporter = ProjectExporter()
        let blocked = task(id: "t1", position: 0, title: "Unblock infra",
                           status: "blocked", risk: "external", riskReason: "vendor SLA")
        let cancelled = task(id: "t2", position: 1, title: "Old idea", status: "cancelled")
        let plan = plan(title: "P", goal: "G", createdAt: "2026-08-14T10:00:00Z",
                        tasks: [cancelled, blocked])

        let md = exporter.plansMarkdown(plan: plan)

        XCTAssertTrue(md.contains("Unblock infra ⚠️"), "blocked task flagged")
        XCTAssertTrue(md.contains("- [-] Old idea"), "cancelled task → struck box")
        XCTAssertTrue(md.contains("vendor SLA"), "risk reason rendered")
    }

    // MARK: - writePlans

    func testWritePlansCreatesOneFilePerPlanUnderLlmDocPlan() throws {
        let projectRoot = tmpDir()
        defer { try? fm.removeItem(at: projectRoot) }
        let exporter = ProjectExporter()
        let planA = plan(id: "plan-1111111111111111", title: "Plan A",
                         goal: "A", createdAt: "2026-08-14T10:00:00Z",
                         tasks: [task(id: "t", position: 0, title: "X", status: "done")])
        let planB = plan(id: "plan-2222222222222222", title: "Plan B",
                         goal: "B", createdAt: "2026-08-14T11:00:00Z", tasks: [])

        let written = try exporter.writePlans([planA, planB], projectRoot: projectRoot)

        XCTAssertEqual(written, 2)
        let plansDir = ProjectLayout(root: projectRoot).plansDir
        XCTAssertTrue(plansDir.path.hasSuffix("llm-doc/plans"), "canonical note-type location")
        let files = mdFiles(in: plansDir)
        XCTAssertEqual(files.count, 2)
        XCTAssertTrue(files.contains { $0.lastPathComponent.hasPrefix("2026-08-14-") },
                      "filename starts with the createdAt date prefix")
        XCTAssertTrue(files.contains { $0.lastPathComponent.hasSuffix("-11111111.md") },
                      "filename ends with the last 8 chars of the plan id")
    }

    func testWritePlansIsIdempotentOverwrite() throws {
        let projectRoot = tmpDir()
        defer { try? fm.removeItem(at: projectRoot) }
        let exporter = ProjectExporter()
        let p = plan(id: "plan-9999999999999999", title: "Solo",
                     goal: "S", createdAt: "2026-08-14T10:00:00Z", tasks: [])

        _ = try exporter.writePlans([p], projectRoot: projectRoot)
        _ = try exporter.writePlans([p], projectRoot: projectRoot)  // re-export

        XCTAssertEqual(mdFiles(in: ProjectLayout(root: projectRoot).plansDir).count, 1,
                       "re-export overwrites, does not duplicate")
    }

    func testWritePlansReplacesSupersededFileOnTitleRename() throws {
        let projectRoot = tmpDir()
        defer { try? fm.removeItem(at: projectRoot) }
        let exporter = ProjectExporter()
        // Same plan id, renamed title (plans ARE renamable via /kb/plan/save).
        let original = plan(id: "plan-3333333333333333", title: "Old Name",
                            goal: "G", createdAt: "2026-08-14T10:00:00Z", tasks: [])
        let renamed  = plan(id: "plan-3333333333333333", title: "New Name",
                            goal: "G", createdAt: "2026-08-14T10:00:00Z", tasks: [])

        _ = try exporter.writePlans([original], projectRoot: projectRoot)
        _ = try exporter.writePlans([renamed], projectRoot: projectRoot)

        let files = mdFiles(in: ProjectLayout(root: projectRoot).plansDir)
        XCTAssertEqual(files.count, 1, "renamed plan must replace, not duplicate")
        let content = try String(contentsOf: files[0], encoding: .utf8)
        XCTAssertTrue(content.contains("# New Name"), "surviving file holds the new title")
        XCTAssertFalse(content.contains("# Old Name"), "stale content must be gone")
    }

    func testWritePlansWithNoPlansReturnsZeroAndCreatesNoPlanDir() throws {
        let projectRoot = tmpDir()
        defer { try? fm.removeItem(at: projectRoot) }
        let exporter = ProjectExporter()

        let written = try exporter.writePlans([], projectRoot: projectRoot)

        XCTAssertEqual(written, 0)
        XCTAssertFalse(fm.fileExists(atPath: ProjectLayout(root: projectRoot).plansDir.path),
                       "no plan dir created for zero plans")
    }

    // MARK: - Fixtures & helpers

    private func plan(id: String = "plan-0000000000000000",
                      meetingId: String? = nil,
                      title: String,
                      goal: String,
                      language: String = "en",
                      createdAt: String,
                      tasks: [ProjectExportBundle.Task]) -> ProjectExportBundle.Plan {
        ProjectExportBundle.Plan(id: id, meetingId: meetingId, title: title, goal: goal,
                                 language: language, createdAt: createdAt, updatedAt: nil,
                                 tasks: tasks)
    }

    private func task(id: String,
                      position: Int,
                      milestone: String? = nil,
                      title: String,
                      description: String? = nil,
                      owner: String? = nil,
                      due: String? = nil,
                      estimateDays: Int? = nil,
                      dependsOn: [String] = [],
                      status: String,
                      risk: String? = nil,
                      riskReason: String? = nil) -> ProjectExportBundle.Task {
        ProjectExportBundle.Task(id: id, position: position, milestone: milestone,
                                 title: title, description: description, owner: owner,
                                 due: due, estimateDays: estimateDays, dependsOn: dependsOn,
                                 status: status, risk: risk, riskReason: riskReason)
    }

    private func tmpDir() -> URL {
        fm.temporaryDirectory
            .appendingPathComponent("plans-export-\(UUID().uuidString)", isDirectory: true)
    }

    private func mdFiles(in url: URL) -> [URL] {
        guard let names = try? fm.contentsOfDirectory(atPath: url.path) else { return [] }
        return names.filter { $0.hasSuffix(".md") }
            .map { url.appendingPathComponent($0) }
    }
}
