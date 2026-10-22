import Foundation

/// The slice of AutoTask's scheduler the phone's Loop controls drive.
///
/// A phone-started loop runs on `AutoCodeUpdateService`'s loop lane — the one
/// path that already wires every dependency a run needs and journals it like a
/// scheduled run. `MobileLoopBridge` lives in Features/Loop, so it reaches that
/// lane through this protocol instead of naming the AutoTask-owned service or
/// its `AutoTaskRunTrigger`/`AutoTask` types.
@MainActor
protocol LoopLaneControlling: AnyObject {
    /// Start ONE loop on the loop lane for a phone request, journalled with the
    /// `.phone` trigger. False when a loop-lane run is already scheduled or in
    /// flight (the scheduler declined).
    func runSingleLoopFromPhone(loopId: String) -> Bool
    /// Start ONE stage of the Primary loop for a phone request. Same contract
    /// as `runSingleLoopFromPhone`.
    func runSingleLoopStageFromPhone(stageId: String) -> Bool
    /// Cancel the loop lane only — unrelated Auto Task runs and the scheduler
    /// timer are left alone.
    func cancelLoopLane()
    /// The loop lane's live log buffer, raw (unredacted) text, oldest first —
    /// the same buffer the Mac Auto Tasks page shows for Loop Engineering.
    var loopLaneLogTexts: [String] { get }
}
