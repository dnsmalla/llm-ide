import Testing
@testable import LlmIdeMacLib

/// The Run button's disabled state and its tooltip come from one function, so a
/// dead button always says why — the seeded "Main Loop" has no stages and used
/// to look broken with no hint.
@Suite("Loop run availability")
struct LoopRunAvailabilityTests {
    private func reason(isRunning: Bool = false, isWaitingInQueue: Bool = false,
                        isStartPending: Bool = false, laneRunLabel: String? = nil,
                        isSettingUpEnvironment: Bool = false,
                        hasEnabledStage: Bool = true, hasGitRoot: Bool = true) -> String? {
        LoopRunAvailability.disabledReason(
            isRunning: isRunning, isWaitingInQueue: isWaitingInQueue, isStartPending: isStartPending,
            laneRunLabel: laneRunLabel, isSettingUpEnvironment: isSettingUpEnvironment,
            hasEnabledStage: hasEnabledStage, hasGitRoot: hasGitRoot)
    }

    @Test("a runnable loop has no reason")
    func runnable() {
        #expect(reason() == nil)
    }

    @Test("a loop with no enabled stage says so")
    func noStage() throws {
        let text = try #require(reason(hasEnabledStage: false))
        #expect(text.contains("No enabled stage"))
    }

    @Test("no git working tree says so")
    func noGit() throws {
        let text = try #require(reason(hasGitRoot: false))
        #expect(text.contains("git working tree"))
    }

    @Test("every blocking condition yields a reason, never a silent disable")
    func everyBlockerHasAReason() {
        #expect(reason(isRunning: true) != nil)
        #expect(reason(isWaitingInQueue: true) != nil)
        #expect(reason(isStartPending: true) != nil)
        #expect(reason(laneRunLabel: "Phone run") != nil)
        #expect(reason(isSettingUpEnvironment: true) != nil)
    }

    @Test("a phone/schedule run keeps its own wording")
    func laneRunWording() {
        #expect(reason(laneRunLabel: "Scheduled run") == "Scheduled run — stop it before running from here.")
    }

    @Test("the order of reasons is fixed: lane, running, queued, environment, stage, git")
    func fullOrder() throws {
        func text(_ run: Bool, _ queued: Bool, _ env: Bool, _ stage: Bool, _ git: Bool, lane: String? = nil) -> String {
            reason(isRunning: run, isWaitingInQueue: queued, laneRunLabel: lane,
                   isSettingUpEnvironment: env, hasEnabledStage: stage, hasGitRoot: git) ?? ""
        }
        #expect(text(true, true, true, false, false, lane: "Phone run").hasPrefix("Phone run"))
        #expect(text(true, true, true, false, false).contains("already running"))
        #expect(text(false, true, true, false, false).contains("queued"))
        #expect(text(false, false, true, false, false).contains("environment"))
        #expect(text(false, false, false, false, false).contains("No enabled stage"))
        #expect(text(false, false, false, true, false).contains("git working tree"))
    }

    @Test("the most actionable reason wins when several apply")
    func precedence() throws {
        let text = try #require(reason(isRunning: true, hasEnabledStage: false, hasGitRoot: false))
        #expect(text.contains("already running"))
    }
}
