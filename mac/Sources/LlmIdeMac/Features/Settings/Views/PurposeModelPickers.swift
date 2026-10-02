import SwiftUI

/// One model picker per purpose (Planning / Coding / Reviewing / Documents),
/// shown under the Default model picker. "Default" is stored as an empty id,
/// which `PurposeModelPolicy` resolves to the Default model, so an untouched
/// install is unchanged.
struct PurposeModelPickers: View {
    @EnvironmentObject var theme: ThemeStore
    @EnvironmentObject var config: AppConfig

    /// The active provider's model list (the same one the Default picker uses).
    let options: [AIModel]

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            ForEach(ModelPurpose.allCases, id: \.self) { purpose in
                HStack(spacing: Spacing.sm) {
                    Text(Self.title(purpose))
                        .font(Typography.caption)
                        .foregroundStyle(theme.current.textMuted)
                    Picker("", selection: binding(for: purpose)) {
                        Text("Default").tag("")
                        ForEach(options(including: purpose)) { Text($0.displayName).tag($0.id) }
                    }
                    .labelsHidden().pickerStyle(.menu).fixedSize()
                }
                .help(Self.modes(purpose))
            }
            // WARNING: a model change rewrites the prompt cache, exactly like a
            // mode change does, so switching between purposes that use
            // different models re-reads the whole context once at full price.
            Text("Chats follow these by mode. Switching to a mode with a different model re-reads the conversation once, so use one model for modes you switch between often. A model picked in the chat composer overrides these for that chat.")
                .font(Typography.caption)
                .foregroundStyle(theme.current.textMuted)
        }
    }

    private func binding(for purpose: ModelPurpose) -> Binding<String> {
        Binding(
            get: { config.purposeModelIds[purpose] ?? "" },
            set: { config.purposeModelIds[purpose] = $0; config.modelPickIsExplicit = false })
    }

    /// `options` plus the saved id when the list no longer carries it. A
    /// SwiftUI `Picker` whose selection matches no tag renders an empty
    /// selection — the same trap the Default picker's `modelOptions` guards.
    private func options(including purpose: ModelPurpose) -> [AIModel] {
        let current = config.purposeModelIds[purpose] ?? ""
        guard !current.isEmpty, !options.contains(where: { $0.id == current }) else { return options }
        return options + [AIModel(id: current, displayName: AIModel.knownName(for: current, in: options) ?? current)]
    }

    static func title(_ purpose: ModelPurpose) -> String {
        switch purpose {
        case .planning: return "Planning model"
        case .coding: return "Coding model"
        case .reviewing: return "Reviewing model"
        case .documents: return "Documents model"
        }
    }

    static func modes(_ purpose: ModelPurpose) -> String {
        switch purpose {
        case .planning: return "Used by Plan and Assist Plan"
        case .coding: return "Used by Execute and Auto"
        case .reviewing: return "Used by Code Review"
        case .documents: return "Used by Document and Ask"
        }
    }
}
