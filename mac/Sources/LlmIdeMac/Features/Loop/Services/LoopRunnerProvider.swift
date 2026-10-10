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
    /// Where lane runs are registered so the Loop page can see and stop them.
    private weak var laneRegistry: LoopRunService?
    /// Passed to every runner this provider builds. Wired by `FeatureCatalog` when CodeGraph is compiled in.
    var graphRescanner: GraphRescanning?

    init(api: LlmIdeAPIClient, config: AppConfig, activity: ActivityStore?,
         laneRegistry: LoopRunService? = nil) {
        self.api = api
        self.config = config
        self.activity = activity
        self.laneRegistry = laneRegistry
    }

    func makeRunner(trigger: LoopRunTrigger, regressionVerifyTimeout: TimeInterval) -> LoopRunning {
        // Tier routing, resolved per replay call so a Settings change reaches
        // this runner: nil (unset/unusable) keeps the server's default model.
        let prompter = CodeAssistPrompter(api: api, agent: config.activeCLI,
                                          routeResolver: LoopReplayTierRoute.resolve)
        let judge = CodeAssistJudge(api: api)
        let repairer = AgentFaultRepairer(api: api, routeResolver: LoopAgentTierRoute.resolve)
        let regressionRunner = RegressionRunner(prompter: prompter, judge: judge,
                                                verifier: ShellFaultVerifier(), repairer: repairer,
                                                verifyTimeout: regressionVerifyTimeout, config: config)
        // Mirrors runRegressionSweep: without this, the inner Regression
        // stage's per-fault activity reporting is silently dropped.
        regressionRunner.activity = activity
        let runner = LoopEngineRunner(
            stageRepairer: AgentLoopStageRepairer(api: api, routeResolver: LoopAgentTierRoute.resolve),
            regressionSweep: RegressionRunnerSweepAdapter(runner: regressionRunner),
            skillExecutor: AgentLoopSkillExecutor(api: api, routeResolver: LoopAgentTierRoute.resolve),
            trigger: trigger,
            repoRegistrar: APILoopRepoRegistrar(api: api),
            defaultShellTimeout: TimeInterval(LoopEngineDefaults.stageTimeouts().shellSeconds),
            defaultAgentTimeout: TimeInterval(LoopEngineDefaults.stageTimeouts().agentSeconds),
            checksCommandAvailability: true,
            changeShipper: LoopShipCoordinator(config: config),
            graphRescanner: graphRescanner
        )
        laneRegistry?.attachLaneRunner(runner, trigger: trigger)
        return runner
    }
}

/// The Loop's tier route for its AGENT steps (skill stages, stage repairs,
/// fault repairs → POST /kb/loop/agent-run) — the bulk of a Loop's cost. Those
/// run on the Agent SDK, so only Claude or a custom provider with an
/// Anthropic-compatible URL qualifies (`requiresAgentEngine`); anything else
/// resolves to nil and the step keeps its default. Read at each call, so a
/// Settings change reaches runners that outlive it (LoopRunService caches them).
enum LoopAgentTierRoute {
    static let resolve: @Sendable () -> TierRoute? = {
        TierRouting.resolve(feature: .loop, requiresAgentEngine: true)
    }
}

/// The Loop's tier route for its regression REPLAY (/code-assist, any
/// provider the server can run). Read at each call, like `LoopAgentTierRoute`.
enum LoopReplayTierRoute {
    static let resolve: @Sendable () -> TierRoute? = {
        TierRouting.resolve(feature: .loop)
    }
}
