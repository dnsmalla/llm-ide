import SwiftUI

/// Review sheet for a single Self-Heal proposal: shows the diff (excluding
/// `.self-heal` and the other excluded paths), and lets the user Apply it to
/// the main checkout (never committing) or Discard the worktree outright.
struct SelfHealProposalSheet: View {
    let proposal: IncidentProposal
    let incidents: [Incident]
    @Environment(\.dismiss) private var dismiss
    @State private var diff = ""
    @State private var failure: String?
    @State private var working = false

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
                Button("Apply to this checkout") {
                    run(gitWork: {
                        try SelfHealProposalService.apply(proposal)
                        try? SelfHealProposalService.discard(proposal)
                    }, onSuccess: { SelfHealProposalService.markApplied(proposal, store: .shared) })
                }
                .buttonStyle(.borderedProminent)
            }
            .disabled(working)
        }
        .padding(16)
        .frame(minWidth: 640, minHeight: 480)
        .task {
            let p = proposal
            let text = await Task.detached { (try? SelfHealProposalService.diff(p)) ?? "" }.value
            diff = text.isEmpty ? "(no changes)" : text
        }
    }

    // `gitWork` runs off the main actor so a slow `git apply`/`discard` never
    // blocks the UI; `onSuccess` and the failure path hop back to the main
    // actor to touch `IncidentStore`/dismiss, since this view's state and
    // `SelfHealProposalService`'s store helpers are main-actor-isolated.
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
