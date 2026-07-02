import Testing
import Foundation
@testable import LlmIdeMac

@MainActor
struct GanttViewModelTests {
    static func issue(number: Int, dueDate: String? = nil,
                      milestoneDue: String? = nil, milestoneStart: String? = nil,
                      createdAt: String = "2026-06-01T00:00:00Z") -> RepoIssue {
        let ms: RepoMilestone? = (milestoneDue != nil || milestoneStart != nil)
            ? RepoMilestone(id: "m", title: "M", state: "active",
                            dueDate: milestoneDue, startDate: milestoneStart, description: nil)
            : nil
        return RepoIssue(id: "i\(number)", number: number, title: "T", body: nil,
                         state: "opened", labels: [], milestone: ms, assignees: [], author: .ghost,
                         createdAt: createdAt, updatedAt: createdAt, closedAt: nil, webUrl: "",
                         commentCount: 0, dueDate: dueDate, weight: nil)
    }

    // GitLab path: native dueDate drives the bar end; start backs off ~7 days.
    @Test func nativeDatesEndAtDueDate() {
        let vm = GanttViewModel()
        vm.applyIssues([Self.issue(number: 1, dueDate: "2026-07-10")], schedules: [:])
        let i = vm.issues[0]
        let end = vm.endDate(for: i)!
        let fmt = DateFormatter(); fmt.dateFormat = "yyyy-MM-dd"; fmt.timeZone = TimeZone(identifier: "UTC")
        #expect(fmt.string(from: end) == "2026-07-10")
        #expect(vm.hasUsefulDates(i))
    }

    // GitHub overlay path: no native dueDate, but an overlay schedule supplies it.
    @Test func overlayScheduleSuppliesDatesWhenNativeMissing() {
        let vm = GanttViewModel()
        let sched = LlmIdeAPIClient.IssueSchedule(provider: "github", repo: "o/r", issueNumber: 2,
                                  startDate: "2026-07-01", dueDate: "2026-07-08",
                                  estimateDays: nil, dependsOn: [], updatedAt: nil)
        vm.applyIssues([Self.issue(number: 2, dueDate: nil)], schedules: [2: sched])
        let i = vm.issues[0]
        #expect(vm.hasUsefulDates(i))
        let fmt = DateFormatter(); fmt.dateFormat = "yyyy-MM-dd"; fmt.timeZone = TimeZone(identifier: "UTC")
        #expect(fmt.string(from: vm.startDate(for: i)) == "2026-07-01")
        #expect(fmt.string(from: vm.endDate(for: i)!) == "2026-07-08")
    }

    // No native date and no overlay → not useful (hidden when hideBlankRows on).
    @Test func noDatesNoOverlayIsNotUseful() {
        let vm = GanttViewModel()
        vm.applyIssues([Self.issue(number: 3, dueDate: nil)], schedules: [:])
        #expect(!vm.hasUsefulDates(vm.issues[0]))
    }

    // An overlay with a present-but-unparseable date string (and no other date)
    // must NOT crash on a force-unwrap — it falls through to "not useful".
    @Test func malformedOverlayDateDoesNotCrash() {
        let vm = GanttViewModel()
        let bad = LlmIdeAPIClient.IssueSchedule(provider: "github", repo: "o/r",
                                                issueNumber: 4, startDate: "not-a-date")
        vm.applyIssues([Self.issue(number: 4, dueDate: nil)], schedules: [4: bad])
        #expect(!vm.hasUsefulDates(vm.issues[0]))   // must return, not trap
    }
}
