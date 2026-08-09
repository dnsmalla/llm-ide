import SwiftUI

/// "Add Task" sheet for the Auto Tasks page — name + prompt template.
/// Styled like FileNamePromptSheet (Explorer's create/rename sheet): the
/// parent owns error display via the `onConfirm` closure's throw-free
/// contract here (validation is inline, Save is disabled until valid).
struct AddCustomAutoTaskSheet: View {
    let onConfirm: (String, String, CustomAutoTask.Mode, String?) -> Void
    let onCancel: () -> Void

    @State private var name: String = ""
    @State private var template: String = ""
    @State private var mode: CustomAutoTask.Mode = .review
    @State private var cron: String = ""
    @State private var cronTouched = false

    private var trimmedCron: String {
        cron.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var cronIsValid: Bool {
        trimmedCron.isEmpty || CronExpression.parse(trimmedCron) != nil
    }

    private var isValid: Bool {
        !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !template.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && cronIsValid
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            Text("New Custom Task").font(Typography.title)

            Text("Name").font(Typography.caption).foregroundStyle(.secondary)
            TextField("e.g. \"Nightly Cleanup\"", text: $name)
                .textFieldStyle(.roundedBorder)

            Text("Mode").font(Typography.caption).foregroundStyle(.secondary)
            Picker("Mode", selection: $mode) {
                ForEach(CustomAutoTask.Mode.allCases, id: \.self) { m in
                    Text(m.label).tag(m)
                }
            }
            .pickerStyle(.segmented)
            Text(mode.detail)
                .font(.caption2)
                .foregroundStyle(.secondary)

            Text("Schedule (optional)").font(Typography.caption).foregroundStyle(.secondary)
            TextField("Cron, e.g. 0 * * * * — leave empty for manual ▶ only", text: $cron)
                .textFieldStyle(.roundedBorder)
                .font(.system(.body, design: .monospaced))
                .onChange(of: cron) { _, _ in cronTouched = true }
            if cronTouched && !cronIsValid {
                Text("Invalid cron expression")
                    .font(.caption2)
                    .foregroundStyle(.red)
            } else if cronTouched && cronIsValid, !trimmedCron.isEmpty,
                      let desc = CronExpression.parse(trimmedCron)?.describe {
                Text(desc)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }

            Text("Prompt").font(Typography.caption).foregroundStyle(.secondary)
            TextEditor(text: $template)
                .font(Typography.mono)
                .frame(minHeight: 160)
                .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Color.secondary.opacity(0.3), lineWidth: 1))
                .cornerRadius(6)

            HStack {
                Spacer()
                Button("Cancel", action: onCancel).keyboardShortcut(.cancelAction)
                Button("Create") {
                    let cronValue = trimmedCron.isEmpty ? nil : trimmedCron
                    onConfirm(name, template, mode, cronValue)
                }
                .keyboardShortcut(.defaultAction)
                .disabled(!isValid)
            }
        }
        .padding(Spacing.md)
        .frame(width: 420)
    }
}
