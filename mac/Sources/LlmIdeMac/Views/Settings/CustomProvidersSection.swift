import SwiftUI

struct CustomProvidersSection: View {
    @EnvironmentObject var theme: ThemeStore
    @State private var providers = CustomProvider.loadAll()
    @State private var showAddSheet = false
    @State private var editingProvider: CustomProvider?

    var body: some View {
        SettingsSectionCard(icon: "atom", title: "Custom Providers") {
            VStack(alignment: .leading, spacing: Spacing.sm) {
                Text("Add custom LLM providers (GLM, Ollama, OpenRouter, etc.)")
                    .font(Typography.caption)
                    .foregroundStyle(theme.current.textMuted)

                if providers.isEmpty {
                    VStack(alignment: .center, spacing: Spacing.sm) {
                        Text("No custom providers")
                            .font(Typography.caption)
                            .foregroundStyle(theme.current.textMuted)
                        Button("Add Provider") { showAddSheet = true }
                            .buttonStyle(.bordered)
                            .controlSize(.small)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(Spacing.md)
                } else {
                    VStack(spacing: Spacing.sm) {
                        ForEach(providers) { provider in
                            ProviderRow(
                                provider: provider,
                                onEdit: { editingProvider = $0 },
                                onDelete: { deleteProvider($0) },
                                onToggle: { toggleProvider($0) }
                            )
                        }
                    }

                    Button("Add Provider") { showAddSheet = true }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                }
            }
        }
        .sheet(isPresented: $showAddSheet) {
            AddProviderSheet(
                provider: nil,
                onSave: { provider in
                    provider.save()
                    providers = CustomProvider.loadAll()
                    showAddSheet = false
                }
            )
        }
        .sheet(item: $editingProvider) { provider in
            AddProviderSheet(
                provider: provider,
                onSave: { updated in
                    updated.save()
                    providers = CustomProvider.loadAll()
                    editingProvider = nil
                }
            )
        }
    }

    private func deleteProvider(_ provider: CustomProvider) {
        provider.delete()
        providers = CustomProvider.loadAll()
    }

    private func toggleProvider(_ provider: CustomProvider) {
        var updated = provider
        updated.isEnabled.toggle()
        updated.save()
        providers = CustomProvider.loadAll()
    }
}

// MARK: - Provider Row

private struct ProviderRow: View {
    @EnvironmentObject var theme: ThemeStore
    let provider: CustomProvider
    let onEdit: (CustomProvider) -> Void
    let onDelete: (CustomProvider) -> Void
    let onToggle: (CustomProvider) -> Void

    var body: some View {
        HStack(spacing: Spacing.sm) {
            Toggle("", isOn: Binding(
                get: { provider.isEnabled },
                set: { _ in onToggle(provider) }
            ))
            .toggleStyle(.checkbox)

            VStack(alignment: .leading, spacing: 2) {
                Text(provider.name)
                    .font(Typography.body)
                    .foregroundStyle(theme.current.text)
                Text(provider.description.isEmpty ? provider.baseURL : provider.description)
                    .font(Typography.caption)
                    .foregroundStyle(theme.current.textMuted)
                    .lineLimit(1)
            }

            Spacer()

            Button { onEdit(provider) } label: {
                Image(systemName: "pencil")
                    .font(.system(size: 14))
            }
            .buttonStyle(.borderless)
            .controlSize(.small)

            Button { onDelete(provider) } label: {
                Image(systemName: "trash")
                    .font(.system(size: 14))
            }
            .buttonStyle(.borderless)
            .controlSize(.small)
            .tint(theme.current.danger)
        }
        .padding(Spacing.sm)
        .background(RoundedRectangle(cornerRadius: 6).fill(theme.current.surface))
    }
}

// MARK: - Add/Edit Sheet

private struct AddProviderSheet: View {
    @EnvironmentObject var theme: ThemeStore
    @Environment(\.dismiss) var dismiss

    @State private var name = ""
    @State private var baseURL = ""
    @State private var description = ""
    @State private var isOpenAICompatible = true
    @State private var models: [AIModel] = []
    @State private var modelInput = ""
    @State private var error: String?
    @State private var isTesting = false

    let provider: CustomProvider?
    let onSave: (CustomProvider) -> Void

    var canSave: Bool {
        !name.isEmpty && !baseURL.isEmpty && !models.isEmpty
    }

    var body: some View {
        VStack(spacing: Spacing.md) {
            HStack {
                Text(provider == nil ? "Add Custom Provider" : "Edit Provider")
                    .font(Typography.title)
                Spacer()
                Button("Cancel") { dismiss() }
                    .buttonStyle(.borderless)
            }

            ScrollView {
                VStack(alignment: .leading, spacing: Spacing.md) {
                    LabeledInput(label: "Provider Name", text: $name, placeholder: "GLM, Ollama, etc.")
                    LabeledInput(label: "API Base URL", text: $baseURL, placeholder: "https://api.example.com/v1")
                    LabeledInput(label: "Description", text: $description, placeholder: "Zhipu GLM 4 (optional)")

                    Toggle("OpenAI-Compatible API", isOn: $isOpenAICompatible)
                        .font(Typography.body)
                        .toggleStyle(.checkbox)

                    VStack(alignment: .leading, spacing: Spacing.sm) {
                        Text("Models")
                            .font(Typography.caption)
                            .foregroundStyle(theme.current.textMuted)

                        HStack {
                            TextField("glm-4, glm-3.5-turbo", text: $modelInput)
                                .textFieldStyle(.roundedBorder)
                            Button("Add") { addModel() }
                                .buttonStyle(.bordered)
                                .controlSize(.small)
                                .disabled(modelInput.trimmingCharacters(in: .whitespaces).isEmpty)
                        }

                        if !models.isEmpty {
                            VStack(spacing: 4) {
                                ForEach(models) { model in
                                    HStack {
                                        Text(model.displayName)
                                            .font(Typography.caption)
                                        Spacer()
                                        Button { models.removeAll { $0.id == model.id } } label: {
                                            Image(systemName: "xmark.circle.fill")
                                        }
                                        .buttonStyle(.borderless)
                                        .controlSize(.small)
                                    }
                                    .padding(4)
                                    .background(RoundedRectangle(cornerRadius: 4).fill(theme.current.surface))
                                }
                            }
                        }
                    }

                    if let error = error {
                        Text(error)
                            .font(Typography.caption)
                            .foregroundStyle(theme.current.danger)
                    }

                    HStack {
                        Button("Test Connection") {
                            testConnection()
                        }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                        .disabled(baseURL.isEmpty || isTesting)

                        Spacer()

                        Button("Save") { save() }
                            .buttonStyle(.borderedProminent)
                            .controlSize(.small)
                            .disabled(!canSave)
                    }
                }
                .padding(Spacing.md)
            }
        }
        .frame(minWidth: 500, minHeight: 400)
        .padding(Spacing.md)
        .onAppear {
            if let provider = provider {
                name = provider.name
                baseURL = provider.baseURL
                description = provider.description
                isOpenAICompatible = provider.isOpenAICompatible
                models = provider.models
            }
        }
    }

    private func addModel() {
        let modelName = modelInput.trimmingCharacters(in: .whitespaces)
        guard !modelName.isEmpty else { return }
        models.append(AIModel(id: modelName, displayName: modelName))
        modelInput = ""
    }

    private func testConnection() {
        isTesting = true
        error = nil

        // Simple test: try to fetch models endpoint
        var request = URLRequest(url: URL(string: baseURL.appending("/models"))!)
        request.timeoutInterval = 5

        URLSession.shared.dataTask(with: request) { _, response, err in
            DispatchQueue.main.async {
                isTesting = false
                if let err = err {
                    error = "Connection failed: \(err.localizedDescription)"
                } else if let http = response as? HTTPURLResponse, http.statusCode == 200 {
                    error = nil
                } else {
                    error = "Server returned status \((response as? HTTPURLResponse)?.statusCode ?? 0)"
                }
            }
        }
        .resume()
    }

    private func save() {
        let vaultKey = "custom.\(name.lowercased()).apiKey"
        var newProvider = CustomProvider(
            name: name,
            baseURL: baseURL,
            apiKey: vaultKey,
            models: models,
            isOpenAICompatible: isOpenAICompatible,
            description: description
        )
        if let provider = provider {
            newProvider.id = provider.id
        }
        onSave(newProvider)
    }
}

// MARK: - Helpers

private struct LabeledInput: View {
    @EnvironmentObject var theme: ThemeStore
    let label: String
    @Binding var text: String
    let placeholder: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label)
                .font(Typography.caption)
                .foregroundStyle(theme.current.textMuted)
            TextField(placeholder, text: $text)
                .textFieldStyle(.roundedBorder)
                .font(Typography.mono)
        }
    }
}
