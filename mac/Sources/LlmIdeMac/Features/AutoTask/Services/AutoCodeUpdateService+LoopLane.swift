import Foundation

/// Exposes the loop lane to `MobileLoopBridge` (Features/Loop) through a
/// Core/Contracts protocol, so the bridge drives phone-started loops without
/// naming this AutoTask-owned service. `cancelLoopLane()` already satisfies
/// its requirement as declared on the service.
extension AutoCodeUpdateService: LoopLaneControlling {
    func runSingleLoopFromPhone(loopId: String) -> Bool {
        runSingleLoop(loopId: loopId, trigger: .phone)
    }

    func runSingleLoopStageFromPhone(stageId: String) -> Bool {
        runSingleLoopStage(stageId: stageId, trigger: .phone)
    }

    var loopLaneLogTexts: [String] {
        logStore.lines(for: .loopEngineering).map(\.text)
    }
}
