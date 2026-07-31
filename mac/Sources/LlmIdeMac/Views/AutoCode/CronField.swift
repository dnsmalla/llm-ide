import SwiftUI

/// Validated cron editor for one Auto Task: a TextField that commits only
/// valid 5-field cron, the human `describe` hint, and the next-fire timestamp.
/// Invalid input is reverted to the last saved cron on commit.
struct CronField: View {
    let task: AutoTask
    @ObservedObject var settings: AutoTaskSettings
    @EnvironmentObject private var theme: ThemeStore

    @State private var draft: String = ""
    @State private var touched = false

    private var isValid: Bool { CronExpression.parse(draft) != nil }

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                Image(systemName: "clock")
                    .foregroundStyle(theme.current.textMuted)
                TextField("cron", text: $draft)
                    .font(.system(.caption, design: .monospaced))
                    .onSubmit { commit() }
                    .onAppear { draft = settings.cron(for: task) }
                if let next = settings.nextFireAt(for: task) {
                    Text("next: \(Self.fireFormatter.string(from: next))")
                        .font(.caption2)
                        .foregroundStyle(theme.current.textMuted)
                } else {
                    Text("no upcoming fire")
                        .font(.caption2)
                        .foregroundStyle(theme.current.textMuted)
                }
            }
            if !isValid && touched {
                Text("invalid cron")
                    .font(.caption2)
                    .foregroundStyle(.red)
            } else if let desc = CronExpression.parse(settings.cron(for: task))?.describe {
                Text(desc).font(.caption2).foregroundStyle(theme.current.textMuted)
            }
        }
    }

    private func commit() {
        touched = true
        if CronExpression.parse(draft) != nil { settings.setCron(draft, for: task) }
        else { draft = settings.cron(for: task) }   // revert
    }

    static let fireFormatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale.current
        f.dateFormat = "EEE HH:mm"
        return f
    }()
}
