import Foundation

/// How a Loop Engineering run was started. Recorded on every journal entry
/// because the three triggers carry very different risk: a `.manual` run has a
/// human watching the log live, while an `.autoTask` run repairs code
/// unattended on a cron. Any later analysis of "which runs went wrong" is
/// meaningless without being able to separate them.
///
/// Lives in Core/Contracts (not Features/Loop, where it used to sit alongside
/// `LoopRunRecord`) because AutoTask's scheduler must be able to pass this
/// value into `LoopRunnerProviding.makeRunner(trigger:)` without naming any
/// other Loop-owned journal type.
enum LoopRunTrigger: String, Codable {
    /// `LoopEngineView`'s Run button.
    case manual
    /// Historical: the Code Assistant chat header used to carry a "Run Loop"
    /// button. That button is gone, so nothing writes this any more — the case
    /// stays because journal records written by earlier builds carry it, and
    /// removing it would fail their decode.
    case chat
    /// `AutoCodeUpdateService`'s scheduled Loop Engineering sweep.
    case autoTask
    /// Started from the iPhone (`loop_start` / `loop_start_stage`). Runs
    /// through the same Auto Task machinery as a scheduled sweep, which is
    /// why these were previously journalled as `.autoTask` — but the risk
    /// profile is the opposite of unattended: someone asked for it and is
    /// watching a log tail on their phone. A history that cannot tell the
    /// two apart cannot answer "which runs went wrong while nobody looked".
    case phone
}
