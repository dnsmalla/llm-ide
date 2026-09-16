import Foundation

/// The concrete `LoopRunnerProviding` Loop registers with `FeatureCatalog` at
/// boot. Builds the exact collaborator graph
/// `AutoCodeUpdateService+PipelineTasks` used to assemble inline —
/// `CodeAssistPrompter`/`CodeAssistJudge`/`AgentFaultRepairer` feed a
/// `RegressionRunner`, wrapped by `RegressionRunnerSweepAdapter` — so moving
/// construction here changes no behavior, only who holds the types.
@MainActor
final class LoopRunnerProvider: LoopRunnerProviding {
    private let api: LlmIdeAPIClient
    private let config: AppConfig
    private weak var activity: ActivityStore?

    init(api: LlmIdeAPIClient, config: AppConfig, activity: ActivityStore?) {
        self.api = api
        self.config = config
        self.activity = activity
    }

    func makeRunner(trigger: LoopRunTrigger, regressionVerifyTimeout: TimeInterval) -> LoopRunning {
        let prompter = CodeAssistPrompter(api: api, agent: config.activeCLI)
        let judge = CodeAssistJudge(api: api)
        let repairer = AgentFaultRepairer(api: api)
        let regressionRunner = RegressionRunner(prompter: prompter, judge: judge,
                                                verifier: ShellFaultVerifier(), repairer: repairer,
                                                verifyTimeout: regressionVerifyTimeout, config: config)
        // Mirrors runRegressionSweep: without this, the inner Regression
        // stage's per-fault activity reporting is silently dropped.
        regressionRunner.activity = activity
        return LoopEngineRunner(
            stageRepairer: AgentLoopStageRepairer(api: api),
            regressionSweep: RegressionRunnerSweepAdapter(runner: regressionRunner),
            skillExecutor: AgentLoopSkillExecutor(api: api),
            trigger: trigger
        )
    }
}
