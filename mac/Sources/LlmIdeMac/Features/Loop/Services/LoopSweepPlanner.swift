import Foundation

/// Loop's implementation of the Core `LoopSweepPlanning` seam. Holds the
/// loop-selection logic `AutoCodeUpdateService+PipelineTasks` used to run
/// inline, unchanged, so the scheduler no longer names `LoopEngineConfigStore`,
/// `LoopDefinition`, `LoopStage` or `LoopRunNotifier`.
///
/// Stateless: every input arrives as a parameter, so tests can build one
/// without a runner provider and exercise the planning guards on their own.
@MainActor
final class LoopSweepPlanner: LoopSweepPlanning {

    func planSweep(projectRoot: URL, projectId: String, gitRoot: URL, defaults: UserDefaults,
                   onlyStageId: String?, onlyLoopId: String?) -> LoopSweepPlan {
        // `LoopEngineConfigStore.loops` is the shared entry point (see its doc
        // comment): it creates this project's default loops, migrates a
        // pre-split project into them, re-pins each loop's own stages, and
        // persists the result only when that is safe.
        let store = LoopEngineConfigStore.loops(projectRoot: projectRoot, projectId: projectId,
                                                gitRoot: gitRoot, defaults: defaults)
        let targets: [LoopDefinition]
        if let onlyStageId {
            // "Run just this stage" searches EVERY loop, not only the Primary
            // one. The target is force-enabled, every other stage in ITS loop
            // is disabled for this run only, and nothing is written back.
            guard var owner = store.loopContaining(stageId: onlyStageId),
                  let soloed = LoopStage.soloing(owner.config.stages, id: onlyStageId) else {
                return .unknownStage
            }
            owner.config.stages = soloed
            targets = [owner]
        } else if let onlyLoopId {
            // One named loop — `runsOnSchedule` is deliberately NOT consulted:
            // the user asked for THIS loop by hand.
            guard let loop = store.loops.first(where: { $0.id == onlyLoopId }),
                  loop.config.stages.contains(where: \.enabled) else {
                return .unknownLoop
            }
            targets = [loop]
        } else {
            targets = store.scheduledLoops
        }
        guard !targets.isEmpty else { return .parked(hasLoops: !store.loops.isEmpty) }

        // Only the scheduled sweep re-reads: a loop the user named by hand
        // (single loop / single stage) runs as asked whatever its schedule
        // flag, so its recheck always passes the planned definition through.
        let rereadsBeforeRun = onlyStageId == nil && onlyLoopId == nil
        return .run(targets.map {
            Self.target(for: $0, rereads: rereadsBeforeRun, projectRoot: projectRoot,
                        projectId: projectId, gitRoot: gitRoot, defaults: defaults)
        })
    }

    func notifySweepFinished(title: String, body: String) {
        LoopRunNotifier.notify(title: title, body: body)
    }

    private static func target(for loop: LoopDefinition, rereads: Bool, projectRoot: URL,
                               projectId: String, gitRoot: URL,
                               defaults: UserDefaults) -> LoopSweepTarget {
        LoopSweepTarget(
            id: loop.id,
            name: loop.name,
            stageCount: loop.config.stages.count,
            enabledStageCount: loop.config.stages.filter(\.enabled).count,
            recheck: {
                guard rereads else {
                    return LoopSweepRecheck(
                        target: target(for: loop, rereads: false, projectRoot: projectRoot,
                                       projectId: projectId, gitRoot: gitRoot, defaults: defaults),
                        skipReason: nil)
                }
                let recheck = LoopEngineConfigStore.sweepRecheck(
                    loop, projectRoot: projectRoot, projectId: projectId,
                    gitRoot: gitRoot, defaults: defaults)
                guard let fresh = recheck.loop else {
                    return LoopSweepRecheck(target: nil, skipReason: recheck.skipReason)
                }
                // The fresh definition is already the one to run; its own
                // recheck is never called, so `rereads: false` only avoids a
                // pointless second disk read if it ever were.
                return LoopSweepRecheck(
                    target: target(for: fresh, rereads: false, projectRoot: projectRoot,
                                   projectId: projectId, gitRoot: gitRoot, defaults: defaults),
                    skipReason: nil)
            },
            run: { runner in
                await runner.run(config: loop.config, faultsRoot: projectRoot,
                                 gitRoot: gitRoot, projectId: projectId,
                                 loopId: loop.id, loopName: loop.name,
                                 goal: loop.goal, acceptanceCriteria: loop.acceptanceCriteria,
                                 scopeGlobs: loop.scopeGlobs)
            })
    }
}
