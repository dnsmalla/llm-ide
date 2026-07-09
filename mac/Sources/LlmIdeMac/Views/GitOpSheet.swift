import SwiftUI

/// Confirm sheet for agent-proposed git operations (write and destructive tiers).
/// Destructive ops show a red warning band; all ops show a human-readable command preview.
struct GitOpSheet: View {
    let args: GitOpArgs
    let onConfirm: () -> Void
    let onCancel: () -> Void
    @EnvironmentObject var theme: ThemeStore

    private var isDestructive: Bool { args.op.tier == .destructive }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(isDestructive ? "Confirm git operation (destructive)" : "Confirm git operation")
                .font(.headline)
            if isDestructive {
                Text("This can discard or rewrite work. Review carefully.")
                    .font(.caption).foregroundStyle(.white)
                    .padding(8).frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.red.opacity(0.85)).clipShape(RoundedRectangle(cornerRadius: 6))
            }
            VStack(alignment: .leading, spacing: 4) {
                Text("Operation").font(.caption).foregroundStyle(.secondary)
                Text(commandPreview).font(.system(size: 12, design: .monospaced))
                    .textSelection(.enabled)
                    .padding(8).frame(maxWidth: .infinity, alignment: .leading)
                    .background(theme.current.surface).clipShape(RoundedRectangle(cornerRadius: 6))
            }
            HStack {
                Spacer()
                Button("Cancel", role: .cancel) { onCancel() }.keyboardShortcut(.cancelAction)
                Button(isDestructive ? "Run anyway" : "Confirm") { onConfirm() }
                    .buttonStyle(.borderedProminent)
                    .tint(isDestructive ? .red : .accentColor)
                    .keyboardShortcut(.defaultAction)
            }
        }
        .padding(16).frame(width: 420)
    }

    // A human-readable preview of what will run (not the exact argv, but the intent).
    private var commandPreview: String {
        switch args.op {
        case .commit:        return "git commit -m \"\(args.message ?? "<message>")\"  (on a feature branch)"
        case .create_branch: return "git checkout -b \(args.branch ?? "agent/\(args.slug ?? "change")")"
        case .checkout:      return "git checkout \(args.branch ?? "")"
        case .push:          return "git push origin <current-branch>"
        case .pull_ff:       return "git pull --ff-only"
        case .merge:         return "git merge --no-ff \(args.branch ?? "")"
        case .revert:        return "git revert --no-edit \(args.ref ?? "HEAD")"
        case .reset:         return "git reset --\(args.mode ?? "mixed") \(args.ref ?? "HEAD")"
        case .stash:         return "git stash push -u"
        case .clean:         return "git clean -fd"
        case .clone:         return "git clone <repo-url>"
        case .merge_to_main: return "git checkout main && git merge --ff-only \(args.branch ?? "") && git push origin main"
        case .add:           return "git add -A"
        case .status, .log, .diff, .branch: return "git \(args.op.rawValue)"
        }
    }
}
