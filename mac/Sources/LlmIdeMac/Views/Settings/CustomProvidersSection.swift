import SwiftUI

struct CustomProvidersSection: View {
    let api: LlmIdeAPIClient
    @EnvironmentObject var theme: ThemeStore
    @State private var providers = CustomProvider.loadAll()
    @State private var showAddSheet = false
    @State private var editingProvider: CustomProvider?

    var body: some View {
        SettingsSectionCard(icon: "atom", title: "Custom Providers") {
            VStack(alignment: .leading, spacing: Spacing.sm) {
                Text("Add named LLM providers (GLM, Ollama, OpenRouter, etc.) for the Code Assistant composer.")
                    .font(Typography.caption)
                    .foregroundStyle(theme.current.textMuted)
                SettingsHint("For Anthropic, OpenAI, Gemini, DeepSeek, and a single shared custom endpoint, use Model Providers above. This section is for multiple named providers with their own model lists — e.g. Z.AI GLM: base URL https://api.z.ai/api/paas/v4 with models glm-5.2 / glm-5-turbo / glm-4.7.")

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
                api: api,
                provider: nil,
                onSave: { provider in
                    provider.save()
                    providers = CustomProvider.loadAll()
                    syncAll()
                    showAddSheet = false
                }
            )
        }
        .sheet(item: $editingProvider) { provider in
            AddProviderSheet(
                api: api,
                provider: provider,
                onSave: { updated in
                    updated.save()
                    providers = CustomProvider.loadAll()
                    syncAll()
                    editingProvider = nil
                }
            )
        }
        // The backend keeps the custom-provider registry in MEMORY (lost on
        // server restart). Re-push the locally-persisted providers whenever
        // this section appears so a restarted server repopulates the registry
        // without the user having to re-save each provider.
        .task {
            let all = CustomProvider.loadAll()
            providers = all
            syncAll()   // repopulate the backend registry (lost on server restart)
        }
    }

    private func deleteProvider(_ provider: CustomProvider) {
        provider.delete()
        providers = CustomProvider.loadAll()
        syncAll()
    }

    private func toggleProvider(_ provider: CustomProvider) {
        var updated = provider
        updated.isEnabled.toggle()
        updated.save()
        providers = CustomProvider.loadAll()
        syncAll()
    }

    /// Re-push every locally-persisted custom provider into the backend
    /// registry (POST /kb/custom-providers, authenticated) so a `custom:<id>`
    /// selection actually resolves at code-assist time. Fire-and-forget: a
    /// transient failure (e.g. auth drift) must not block the UI; the next
    /// mutation or section re-appearance retries.
    private func syncAll() {
        CustomProvider.syncAllToBackend(api: api)
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
    let api: LlmIdeAPIClient
    @EnvironmentObject var theme: ThemeStore
    @Environment(\.dismiss) var dismiss

    @State private var name = ""
    @State private var baseURL = ""
    @State private var description = ""
    @State private var isOpenAICompatible = true
    @State private var models: [AIModel] = []
    @State private var modelInput = ""
    @State private var apiKeyInput = ""
    @State private var error: String?
    @State private var isTesting = false
    @State private var isSaving = false

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

                    // The provider's API key, stored in the server vault under
                    // `custom.<id>.apiKey`. On edit the field is blank (secrets
                    // are write-only — leave blank to keep the existing key).
                    VStack(alignment: .leading, spacing: 4) {
                        Text("API Key")
                            .font(Typography.caption)
                            .foregroundStyle(theme.current.textMuted)
                        SecureField(provider == nil ? "sk-…" : "Enter a new key to replace (leave blank to keep)",
                                    text: $apiKeyInput)
                            .textFieldStyle(.roundedBorder)
                            .font(Typography.mono)
                    }

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

                        Button("Save") { Task { await save() } }
                            .buttonStyle(.borderedProminent)
                            .controlSize(.small)
                            .disabled(!canSave || isSaving)
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

        // Probe {baseURL}/models WITH the entered API key as a Bearer header.
        // OpenAI-compatible providers (Z.AI GLM, OpenRouter, …) reject an
        // unauthenticated /models with 401, so without the key "Test
        // Connection" reported a bogus failure even for a valid setup. Also
        // validate the URL up front — the old force-unwrap crashed on a typo.
        let trimmedBase = baseURL.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalized = trimmedBase.hasSuffix("/") ? String(trimmedBase.dropLast()) : trimmedBase
        guard let url = URL(string: normalized + "/models") else {
            isTesting = false
            error = "Invalid base URL"
            return
        }
        var request = URLRequest(url: url)
        request.timeoutInterval = 8
        let key = apiKeyInput.trimmingCharacters(in: .whitespacesAndNewlines)
        if isOpenAICompatible && !key.isEmpty {
            request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        }

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

    private func save() async {
        isSaving = true
        defer { isSaving = false }
        var newProvider = CustomProvider(
            name: name,
            baseURL: baseURL,
            apiKey: "",   // set below from the stable id
            models: models,
            isOpenAICompatible: isOpenAICompatible,
            description: description
        )
        if let provider = provider {
            newProvider.id = provider.id   // keep id on edit
        }
        // Vault key derived from the provider's STABLE UUID id (not the name):
        // survives renames, avoids charset/collision bugs, and matches the
        // backend allowlist regex /^custom\.[a-z0-9-]+\.apiKey$/.
        newProvider.apiKey = "custom.\(newProvider.id.lowercased()).apiKey"
        // Store the key in the server vault first (best-effort — a network
        // failure must not block persisting the provider itself).
        let trimmedKey = apiKeyInput.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmedKey.isEmpty {
            try? await api.setSecret(key: newProvider.apiKey, value: trimmedKey)
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
