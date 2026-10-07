import Foundation
import Observation
import SharedProtocol

/// Serves the `selfheal_*` slice: lists the Mac's recorded incidents, shows a proposal's diff, and
/// ignores / retries / discards / applies. The phone names an INCIDENT id; the proposal (worktree,
/// branch, base commit) is always looked up on the Mac, never taken from the phone.
///
/// Apply patches the LLM-IDE SOURCE checkout (`proposal.mainRepo`) — never the user's active
/// project, never a commit — so it sits behind its own Phone access switch, re-checks the incident
/// status at apply time, and refuses while a loop holds that checkout.
@MainActor
final class MobileSelfHealBridge: MobileFeatureBridge {
    weak var manager: MobileControlManager?
    /// Injected by the shell (the loop guards live in a feature that may be compiled out).
    var busyReason: (() -> String?)?
    private var observing = false
    /// Incident ids with an apply/discard in progress. The incident stays `proposed` until the git work
    /// finishes, so without this a double-tap runs apply twice, or discard under a running apply.
    private var inFlight: Set<String> = []
    /// Patches sent to the phone for review, so apply uses exactly what the user saw.
    private var reviewed = ReviewedPatchCache()

    nonisolated static let maxIncidents = 50
    nonisolated static let maxMessage = 300
    nonisolated static let maxNote = 300
    nonisolated static let maxDiffChars = 100_000

    init(manager: MobileControlManager) { self.manager = manager }

    // MARK: - MobileFeatureBridge

    func handle(type: String, data: Data?) -> Bool {
        switch type {
        case MobileProtocol.Tag.selfHealList:
            push()
            return true
        case MobileProtocol.Tag.selfHealAction:
            guard let req = try? manager?.decoder.decode(SelfHealAction.self, from: data ?? Data()) else {
                push(error: "The Mac could not read this request.")
                return true
            }
            perform(req)
            return true
        case MobileProtocol.Tag.selfHealDiff:
            guard let req = try? manager?.decoder.decode(SelfHealDiffRequest.self, from: data ?? Data()) else {
                manager?.reply(SelfHealDiffResult(incidentId: "", diff: nil, error: "The Mac could not read this request."))
                return true
            }
            sendDiff(for: req.incidentId)
            return true
        default:
            return false
        }
    }

    func installPushObservers() {
        guard !observing else { return }
        observing = true
        observe()
    }
    func removePushObservers() {
        observing = false
        // A stopped server means the phone is gone; a later pairing must review afresh.
        reviewed = ReviewedPatchCache()
    }

    private func observe() {
        guard observing else { return }
        withObservationTracking {
            _ = IncidentStore.shared.incidents
        } onChange: { [weak self] in
            Task { @MainActor [weak self] in
                guard let self, self.observing else { return }
                self.push()
                self.observe()
            }
        }
    }

    // MARK: - Actions

    enum Decision: Equatable {
        case allow
        case refuse(String)
    }

    /// Pure so a test can pin every refusal. Ignore/retry/discard are bookkeeping on the Mac's own
    /// incident list; only apply changes files, so only apply needs the switch and a quiet checkout.
    nonisolated static func decide(action: SelfHealAction.Kind, status: String, hasProposal: Bool,
                                   applyAllowed: Bool, busyReason: String?) -> Decision {
        switch action {
        case .ignore:
            return (status == "new" || status == "needsHuman") ? .allow
                : .refuse("Only a new or needs-attention incident can be ignored.")
        case .retry:
            return (status == "ignored" || status == "needsHuman") ? .allow
                : .refuse("Only an ignored or needs-attention incident can be retried.")
        case .discard:
            // Destructive and not undoable (the branch and worktree are deleted), so it needs the same
            // switch as apply — not just bookkeeping like ignore/retry.
            guard applyAllowed else { return .refuse(PhoneAccess.selfHealApply.deniedMessage) }
            guard status == "proposed", hasProposal else { return .refuse("There is no proposal to discard.") }
            return .allow
        case .apply:
            guard applyAllowed else { return .refuse(PhoneAccess.selfHealApply.deniedMessage) }
            guard status == "proposed", hasProposal else { return .refuse("There is no proposal to apply.") }
            if let busyReason { return .refuse(busyReason) }
            return .allow
        }
    }

    private func perform(_ req: SelfHealAction) {
        guard let manager else { return }
        let store = IncidentStore.shared
        guard let incident = store.incidents.first(where: { $0.id == req.incidentId }) else {
            push(error: "That incident is no longer in the Mac's list.")
            return
        }
        let decision = Self.decide(action: req.action, status: incident.status.rawValue,
                                   hasProposal: incident.proposal != nil,
                                   applyAllowed: manager.phoneAccess.isAllowed(.selfHealApply),
                                   busyReason: busyReason?() ?? manager.phoneWorkReason)
        if case .refuse(let why) = decision { push(error: why); return }
        var reviewedPatch: SelfHealProposalService.ReviewedPatch?
        if req.action == .apply, let proposal = incident.proposal {
            // Only a patch the phone was shown may be applied; a restart or expiry loses it.
            switch reviewed.lookup(for: incident.id, proposal: proposal,
                                   deviceId: manager.connectedDeviceId, now: Date()) {
            case .held(let held):
                reviewedPatch = held
            case .truncated:
                push(error: Self.truncatedMessage)
                return
            case .missing:
                // The phone keeps its cached diff for the whole session, so refill the Mac's cache
                // AND replace the phone's copy instead of asking it to reopen.
                push(error: Self.notReviewedMessage)
                sendDiff(for: incident.id)
                return
            }
        }
        if req.action == .apply || req.action == .discard {
            guard !inFlight.contains(incident.id) else { push(error: "That proposal is already being processed."); return }
            inFlight.insert(incident.id)
        }

        switch req.action {
        case .ignore:
            // Exactly the Mac UI's mutation (SelfHealSettingsSection).
            store.update(id: incident.id) { $0.status = .ignored; $0.note = "ignored manually" }
            push(message: "Ignored.")
        case .retry:
            store.update(id: incident.id) { $0.status = .new; $0.attempts = 0; $0.note = nil }
            push(message: "Queued for the next Self-Heal run.")
        case .discard:
            guard let proposal = incident.proposal else { return }
            Task { @MainActor [weak self] in
                defer { self?.inFlight.remove(incident.id) }
                do {
                    try await Task.detached { try SelfHealProposalService.discard(proposal) }.value
                    SelfHealProposalService.markDiscarded(proposal, store: store)
                    self?.push(message: "Proposal discarded.")
                } catch let failure {
                    self?.push(error: Self.safe(failure.localizedDescription))
                }
            }
        case .apply:
            guard let proposal = incident.proposal, let held = reviewedPatch else { return }
            manager.append(.info, "selfheal apply (phone) \(incident.id)")
            Task { @MainActor [weak self] in
                defer { self?.inFlight.remove(incident.id) }
                do {
                    try await Task.detached {
                        try SelfHealProposalService.apply(proposal, reviewed: held.binaryPatch)
                    }.value
                    self?.reviewed.remove(incident.id)
                    // A leftover worktree is not an error — same as the Mac sheet.
                    try? await Task.detached { try SelfHealProposalService.discard(proposal) }.value
                    SelfHealProposalService.markApplied(proposal, store: store)
                    self?.push(message: "Applied to the LLM-IDE source checkout. Nothing was committed.")
                } catch SelfHealProposalService.Failure.changedSinceReview {
                    self?.reviewed.remove(incident.id)
                    self?.push(error: Self.changedMessage)
                    self?.sendDiff(for: incident.id)
                } catch let failure {
                    self?.push(error: Self.safe(failure.localizedDescription))
                }
            }
        }
    }

    static let notReviewedMessage = "Review the diff again before applying."
    static let changedMessage = "The proposal changed since you reviewed it. The diff was refreshed. Review it again before applying."
    static let truncatedMessage = "Diff too long to review on the phone. Apply it from the Mac."

    private func sendDiff(for incidentId: String) {
        guard let proposal = IncidentStore.shared.incidents.first(where: { $0.id == incidentId })?.proposal else {
            manager?.reply(SelfHealDiffResult(incidentId: incidentId, diff: nil, error: "No proposal for that incident."))
            return
        }
        Task { @MainActor [weak self] in
            do {
                // git AND the redaction both run off the main actor.
                let (patch, text, truncated) = try await Task.detached {
                    let patch = try SelfHealProposalService.reviewedPatch(proposal)
                    let shaped = Self.shapeDiff(patch.text)
                    return (patch, shaped.0, shaped.1)
                }.value
                self?.reviewed.store(patch, for: incidentId, proposal: proposal, truncated: truncated,
                                     deviceId: self?.manager?.connectedDeviceId, now: Date())
                self?.manager?.reply(SelfHealDiffResult(incidentId: incidentId,
                                                        diff: text.isEmpty ? "(no changes)" : text,
                                                        truncated: truncated))
            } catch let failure {
                self?.manager?.reply(SelfHealDiffResult(incidentId: incidentId, diff: nil,
                                                        error: Self.safe(failure.localizedDescription)))
            }
        }
    }

    // MARK: - State

    private func push(message: String? = nil, error: String? = nil) {
        guard manager?.mobileClientPaired == true || message != nil || error != nil else { return }
        manager?.reply(Self.state(incidents: IncidentStore.shared.incidents,
                                  canApply: manager?.phoneAccess.isAllowed(.selfHealApply) ?? false,
                                  enabled: SelfHealSettings.isEnabled(),
                                  message: message, error: error))
    }

    nonisolated static func state(incidents: [Incident], canApply: Bool, enabled: Bool,
                                  message: String?, error: String?) -> SelfHealState {
        SelfHealState(
            incidents: incidents.sorted { $0.lastSeen > $1.lastSeen }.prefix(maxIncidents).map { i in
                SelfHealIncident(
                    id: i.id, source: i.source.rawValue, category: String(i.category.prefix(80)),
                    message: String(i.message.prefix(maxMessage)), count: i.count, status: i.status.rawValue,
                    // The agent's free-text reason is NOT redacted at record time; do it here.
                    note: i.note.map { safe($0, limit: maxNote) },
                    lastSeen: i.lastSeen.timeIntervalSince1970,
                    hasProposal: i.proposal != nil,
                    // Branch name only: worktree and repo paths are absolute local paths.
                    branch: i.proposal?.branch)
            },
            canApply: canApply, enabled: enabled, message: message, error: error)
    }

    /// Redact (secrets, home paths) and cap a diff before it leaves the Mac. Does real regex work,
    /// so callers run it off the main actor. Bounded per line — see `PhoneRedaction`.
    nonisolated static func shapeDiff(_ raw: String) -> (String, Bool) {
        let r = PhoneRedaction.lines(raw, maxChars: maxDiffChars)
        return (r.text, r.truncated)
    }

    nonisolated static func safe(_ s: String, limit: Int = 300) -> String { PhoneRedaction.short(s, limit: limit) }
}

/// Bounded, expiring map of incident id to the patch last sent to the phone. Main-actor owned by the
/// bridge; pure value type so a test can pin capacity and expiry. Entries are bound to the device that
/// reviewed them so a newly paired phone cannot apply another device's review.
struct ReviewedPatchCache {
    struct Entry {
        let patch: SelfHealProposalService.ReviewedPatch
        let proposal: IncidentProposal
        let truncated: Bool
        let deviceId: String?
        let storedAt: Date
    }

    enum Lookup {
        case held(SelfHealProposalService.ReviewedPatch)
        /// Never reviewed, expired, evicted, wrong proposal, or reviewed by another device.
        case missing
        /// The phone saw only the first part of the diff; the whole patch must not be applied from it.
        case truncated
    }

    static let capacity = 8
    static let lifetime: TimeInterval = 30 * 60

    private(set) var entries: [String: Entry] = [:]

    mutating func store(_ patch: SelfHealProposalService.ReviewedPatch, for key: String,
                        proposal: IncidentProposal, truncated: Bool = false,
                        deviceId: String? = nil, now: Date) {
        prune(now: now)
        entries[key] = Entry(patch: patch, proposal: proposal, truncated: truncated,
                             deviceId: deviceId, storedAt: now)
        while entries.count > Self.capacity,
              let oldest = entries.min(by: { $0.value.storedAt < $1.value.storedAt })?.key {
            entries.removeValue(forKey: oldest)
        }
    }

    /// Returns the held patch only if it is fresh, complete, and belongs to this exact proposal and device.
    mutating func lookup(for key: String, proposal: IncidentProposal, deviceId: String? = nil,
                         now: Date) -> Lookup {
        prune(now: now)
        guard let entry = entries[key], entry.proposal == proposal, entry.deviceId == deviceId else {
            return .missing
        }
        return entry.truncated ? .truncated : .held(entry.patch)
    }

    mutating func remove(_ key: String) { entries.removeValue(forKey: key) }

    private mutating func prune(now: Date) {
        entries = entries.filter { now.timeIntervalSince($0.value.storedAt) <= Self.lifetime }
    }
}
