import OSLog
import SwiftUI

/// Review sheet for a single Self-Heal proposal: shows the diff (excluding
/// `.self-heal` and the other excluded paths), and lets the user Apply it to
/// the main checkout (never committing) or Discard the worktree outright.
struct SelfHealProposalSheet: View {
    let proposal: IncidentProposal
    let incidents: [Incident]
    @Environment(\.dismiss) private var dismiss
    @State private var diff = ""
    @State private var diffLoaded = false
    /// The exact `--binary` patch captured when the sheet loaded; Apply uses these bytes.
    @State private var reviewedPatch: Data?
    @State private var failure: String?
    @State private var working = false
    private static let log = Logger(subsystem: "com.llmide.macapp", category: "Incidents")

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Self-Heal proposal").font(.headline)
            ForEach(incidents) { Text("• \($0.message)").font(.system(size: 11)).lineLimit(2) }
            ScrollView {
                Text(diff.isEmpty ? "Loading diff…" : diff)
                    .font(.system(size: 11, design: .monospaced))
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .textSelection(.enabled)
            }
            .frame(minHeight: 300)
            if let failure { Text(failure).font(.caption).foregroundStyle(.red) }
            HStack {
                Button("Discard", role: .destructive) {
                    run(gitWork: { try SelfHealProposalService.discard(proposal) },
                        onSuccess: { SelfHealProposalService.markDiscarded(proposal, store: .shared) })
                }
                Spacer()
                Button("Close") { dismiss() }
                Button("Apply to this checkout") { runApply() }
                .buttonStyle(.borderedProminent)
                .disabled(!diffLoaded)
            }
            .disabled(working)
        }
        .padding(16)
        .frame(minWidth: 640, minHeight: 480)
        .task {
            let p = proposal
            do {
                let reviewed = try await Task.detached { try SelfHealProposalService.reviewedPatch(p) }.value
                if reviewed.binaryPatch.isEmpty {
                    diff = "(no changes)"
                } else {
                    diff = reviewed.text.isEmpty ? "(binary changes only)" : reviewed.text
                    reviewedPatch = reviewed.binaryPatch
                    diffLoaded = true
                }
            } catch {
                failure = error.localizedDescription
            }
        }
    }

    private func runApply() {
        guard let patch = reviewedPatch else { return }
        let p = proposal
        run(gitWork: {
            // WHY bytes, not a re-diff: the user approved this exact patch (binary parts
            // included); the service refuses if the worktree has drifted since.
            try SelfHealProposalService.apply(p, reviewed: patch)
            do {
                try SelfHealProposalService.discard(p)
            } catch {
                // .info, not .error: a leftover worktree is not an incident to self-heal.
                Self.log.info("Self-Heal: could not remove worktree \(p.worktreePath, privacy: .public): \(error.localizedDescription, privacy: .public)")
            }
        }, onSuccess: { SelfHealProposalService.markApplied(p, store: .shared) })
    }

    // gitWork runs off the main actor (a slow git call must not block the UI); onSuccess/failure hop back to touch main-actor-isolated state.
    private func run(gitWork: @escaping @Sendable () throws -> Void, onSuccess: @escaping @MainActor () -> Void) {
        working = true
        Task.detached {
            do {
                try gitWork()
                await MainActor.run {
                    working = false
                    onSuccess()
                    dismiss()
                }
            } catch {
                await MainActor.run {
                    working = false
                    failure = error.localizedDescription
                }
            }
        }
    }
}
