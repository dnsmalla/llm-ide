import SwiftUI

struct CustomProvidersSection: View {
    let api: LlmIdeAPIClient
    @EnvironmentObject var theme: ThemeStore
    @State private var providers = CustomProvider.loadAll()
    @State private var showAddSheet = false
    @State private var editingProvider: CustomProvider?
    @State private var pendingDelete: CustomProvider?
    /// Vault keys that hold a value; nil until the first listing lands (or if
    /// it failed), so rows show no badge rather than a false "missing".
    @State private var configuredKeys: Set<String>?
    @State private var syncError: String?
    /// The stored list exists but could not be decoded. While true the list
    /// is NOT shown as empty and nothing may write, because a save/delete on
    /// top of it would overwrite (lose) the user's real providers.
    @State private var isListUnreadable = CustomProvider.isListUnreadable
    @State private var showDiscardConfirm = false
    /// The Code Assistant's provider override — a custom provider's id, or ""
    /// to use the default provider (Model Providers ◉ above). The composer has
    /// no provider chip, so this is the only place a custom provider is chosen.
    @AppStorage(CodeAssistantModelState.composerProviderKey) private var composerProviderId = ""

    /// Enabled providers only: a disabled one cannot run a turn, and the
    /// composer falls back to the default provider for it anyway.
    private var composerProviderPicker: some View {
        Picker("Code Assistant provider", selection: $composerProviderId) {
            Text("Default provider (Model Providers ◉)").tag("")
            ForEach(providers.filter(\.isEnabled)) { provider in
                Text(provider.canRunAgentEngine ? provider.name : "\(provider.name) — classic engine only")
                    .tag(provider.id)
            }
        }
        .pickerStyle(.menu)
        .font(Typography.body)
        .onAppear(perform: dropStaleComposerProvider)
        .onChange(of: providers) { _, _ in dropStaleComposerProvider() }
    }

    /// An override naming a deleted or disabled provider matches no picker
    /// tag (a blank menu) while the composer silently runs the default — so
    /// clear it and let the picker say what actually runs.
    private func dropStaleComposerProvider() {
        guard !composerProviderId.isEmpty,
              !providers.contains(where: { $0.id == composerProviderId && $0.isEnabled }) else { return }
        composerProviderId = ""
    }

    var body: some View {
        SettingsSectionCard(icon: "atom", title: "Custom Providers") {
            VStack(alignment: .leading, spacing: Spacing.sm) {
                Text("Add named LLM providers (GLM, Ollama, OpenRouter, etc.). Pick one under “Code Assistant provider” to use it in the Code Assistant.")
                    .font(Typography.caption)
                    .foregroundStyle(theme.current.textMuted)
                SettingsHint("For Anthropic, OpenAI, Gemini, DeepSeek, and a single shared custom endpoint, use Model Providers above. This section is for multiple named providers with their own model lists — e.g. Z.AI GLM: base URL https://api.z.ai/api/paas/v4 with models glm-5.2 / glm-5-turbo / glm-4.7. To run a provider on the Claude Agent engine, also give it its Anthropic-compatible URL (Z.AI: https://api.z.ai/api/anthropic).")

                if isListUnreadable {
                    // WHY a dedicated state: an empty list here used to look
                    // like "no providers" and invited Add, which would have
                    // replaced the unreadable blob (the backup is kept).
                    Text("Provider list unreadable (a backup was kept). Adding, editing, or deleting providers is disabled so the stored list is not overwritten.")
                        .font(Typography.caption)
                        .foregroundStyle(theme.current.danger)
                        .fixedSize(horizontal: false, vertical: true)
                    // WHY: without a way out the user stayed locked out of
                    // Add/Edit/Delete forever; this removes the list only
                    // after a verified backup copy exists.
                    Button("Discard unreadable list (backup kept)", role: .destructive) {
                        showDiscardConfirm = true
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                } else if providers.isEmpty {
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
                                hasKey: configuredKeys.map { $0.contains(provider.apiKey) },
                                onEdit: { editingProvider = $0 },
                                onDelete: { pendingDelete = $0 },
                                onToggle: { toggleProvider($0) }
                            )
                        }
                    }

                    Button("Add Provider") { showAddSheet = true }
                        .buttonStyle(.bordered)
                        .controlSize(.small)

                    composerProviderPicker
                }

                if let syncError {
                    Text(syncError)
                        .font(Typography.caption)
                        .foregroundStyle(theme.current.danger)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .confirmationDialog(
            "Delete \(pendingDelete?.name ?? "provider")?",
            isPresented: Binding(get: { pendingDelete != nil },
                                 set: { if !$0 { pendingDelete = nil } }),
            titleVisibility: .visible
        ) {
            Button("Delete", role: .destructive) {
                if let p = pendingDelete { deleteProvider(p) }
                pendingDelete = nil
            }
            Button("Cancel", role: .cancel) { pendingDelete = nil }
        } message: {
            Text("Its stored API key is removed from the server vault too.")
        }
        .confirmationDialog(
            "Discard the unreadable provider list?",
            isPresented: $showDiscardConfirm,
            titleVisibility: .visible
        ) {
            Button("Discard (backup kept)", role: .destructive) { discardUnreadableList() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("A copy is saved first. Your providers will need to be re-added from that backup.")
        }
        .sheet(isPresented: $showAddSheet) {
            AddProviderSheet(
                api: api,
                provider: nil,
                onSave: { provider in
                    persist { provider.save() }
                    showAddSheet = false
                }
            )
        }
        .sheet(item: $editingProvider) { provider in
            AddProviderSheet(
                api: api,
                provider: provider,
                onSave: { updated in
                    persist { updated.save() }
                    editingProvider = nil
                }
            )
        }
        // The backend keeps the custom-provider registry in MEMORY (lost on
        // server restart). Re-push the locally-persisted providers whenever
        // this section appears so a restarted server repopulates the registry
        // without the user having to re-save each provider.
        .task {
            refreshList()
            syncAll()   // repopulate the backend registry (lost on server restart)
            await refreshConfiguredKeys()
        }
    }

    private func refreshList() {
        providers = CustomProvider.loadAll()
        isListUnreadable = CustomProvider.isListUnreadable
    }

    private func discardUnreadableList() {
        if CustomProvider.discardUnreadableList() {
            syncError = nil
            refreshList()
            syncAll()
        } else {
            syncError = "Backup could not be written — nothing was removed."
        }
    }

    /// Runs a local write and syncs only if it actually landed. save/delete
    /// refuse (return false) while the stored list is unreadable.
    private func persist(_ write: () -> Bool) {
        let didWrite = write()
        refreshList()
        if didWrite {
            syncAll()
        } else {
            syncError = "Couldn't save: the stored provider list is unreadable (a backup was kept), so it was left untouched."
        }
    }

    private func deleteProvider(_ provider: CustomProvider) {
        guard !isListUnreadable else { return }
        let didDelete = provider.delete()
        refreshList()
        guard didDelete else {
            syncError = "Couldn't delete: the stored provider list is unreadable (a backup was kept)."
            return
        }
        syncAll()
        // The vault key outlived the provider before — an orphaned secret
        // nothing listed and nothing could clear.
        let vaultKey = provider.apiKey
        if !vaultKey.isEmpty {
            Task {
                do {
                    try await api.setSecret(key: vaultKey, value: "")
                } catch {
                    // `try?` swallowed this: a failed clear left an orphaned secret
                    // that nothing lists and the user never heard about.
                    syncError = "The provider was deleted, but its API key could not be removed from the vault (\(error.localizedDescription)). Remove it manually."
                }
            }
        }
    }

    private func toggleProvider(_ provider: CustomProvider) {
        guard !isListUnreadable else { return }
        var updated = provider
        updated.isEnabled.toggle()
        persist { updated.save() }
    }

    /// Re-push every locally-persisted custom provider into the backend
    /// registry (POST /kb/custom-providers, authenticated) so a `custom:<id>`
    /// selection actually resolves at code-assist time. Not awaited by the UI
    /// (a transient failure must not block it), but the failure is SHOWN: the
    /// old `try?` hid auth drift until a request failed. Calls the throwing
    /// `syncAllToBackendThrowing` because `syncAllToBackend` swallows errors.
    private func syncAll() {
        Task {
            do {
                // Throwing variant refuses to push when the local list is
                // unreadable; pushing loadAll()'s [] wiped the server registry
                // on every Settings open.
                try await CustomProvider.syncAllToBackendThrowing(api: api)
                syncError = nil
                isListUnreadable = false
            } catch CustomProvider.SyncError.localListUnreadable {
                isListUnreadable = true
                syncError = nil
            } catch {
                syncError = "Couldn't sync providers to the server: \(error.localizedDescription). They may not work until it succeeds."
            }
            await refreshConfiguredKeys()
        }
    }

    /// The provider list is machine-global but keys live in the per-account
    /// vault, so after an account switch rows can lack keys; surface that.
    private func refreshConfiguredKeys() async {
        configuredKeys = try? await api.configuredSecretKeys()
    }
}

// MARK: - Provider Row

private struct ProviderRow: View {
    @EnvironmentObject var theme: ThemeStore
    let provider: CustomProvider
    /// nil = unknown (listing not loaded / failed).
    let hasKey: Bool?
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
                HStack(spacing: Spacing.xs) {
                    Text(provider.name)
                        .font(Typography.body)
                        .foregroundStyle(theme.current.text)
                    if let hasKey {
                        // A local server (Ollama) legitimately has no key, so
                        // "missing" in red would be a false alarm.
                        let isKeyless = !hasKey && EndpointSecurity.isLoopbackURL(provider.baseURL)
                        Text(hasKey ? "key configured" : (isKeyless ? "no key" : "key missing"))
                            .font(Typography.caption)
                            .foregroundStyle(hasKey ? theme.current.accent3
                                             : (isKeyless ? theme.current.textMuted : theme.current.danger))
                    }
                }
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
    @State private var anthropicBaseURL = ""
    @State private var description = ""
    @State private var isOpenAICompatible = true
    @State private var models: [AIModel] = []
    @State private var modelInput = ""
    @State private var apiKeyInput = ""
    @State private var error: String?
    @State private var isTesting = false
    @State private var isSaving = false
    @State private var testSucceeded = false

    let provider: CustomProvider?
    let onSave: (CustomProvider) -> Void

    var canSave: Bool {
        !name.isEmpty && !baseURL.isEmpty && !models.isEmpty
            && !EndpointSecurity.isInsecureRemoteHTTP(baseURL)
            && !EndpointSecurity.isInsecureRemoteHTTP(anthropicBaseURL)
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
                    // The provider's Anthropic-format door. The Claude Agent
                    // engine speaks the Anthropic API only, so this is what
                    // lets its models run there; leave blank and the provider
                    // stays on the classic engine (no warning, unchanged).
                    VStack(alignment: .leading, spacing: 4) {
                        LabeledInput(label: "Anthropic-compatible URL (optional — enables the Claude Agent engine)",
                                     text: $anthropicBaseURL, placeholder: "https://api.z.ai/api/anthropic")
                        Text("Z.AI GLM: https://api.z.ai/api/anthropic · DeepSeek: https://api.deepseek.com/anthropic · Ollama: http://localhost:11434. Uses the same API key.")
                            .font(Typography.caption)
                            .foregroundStyle(theme.current.textMuted)
                            .fixedSize(horizontal: false, vertical: true)
                    }
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
                                .onSubmit { addModel() }
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
                    if testSucceeded {
                        Text("Connected ✓")
                            .font(Typography.caption)
                            .foregroundStyle(theme.current.accent3)
                    }
                    if let hint = testBlockedReason {
                        Text(hint)
                            .font(Typography.caption)
                            .foregroundStyle(theme.current.textMuted)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    if Self.isInsecureRemoteHTTP(baseURL) || Self.isInsecureRemoteHTTP(anthropicBaseURL) {
                        Text("This URL uses plain http to a non-local host: your API key would be sent unencrypted. Use https.")
                            .font(Typography.caption)
                            .foregroundStyle(theme.current.danger)
                            .fixedSize(horizontal: false, vertical: true)
                    }

                    HStack {
                        Button("Test Connection") {
                            testConnection()
                        }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                        .disabled(baseURL.isEmpty || isTesting || testBlockedReason != nil)

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
                anthropicBaseURL = provider.anthropicBaseURL ?? ""
                description = provider.description
                isOpenAICompatible = provider.isOpenAICompatible
                models = provider.models
            }
        }
    }

    /// Why "Test Connection" can't run meaningfully. When editing, the stored
    /// key is write-only, so a blank field would test unauthenticated and
    /// report a bogus 401 for a perfectly good provider.
    private var testBlockedReason: String? {
        guard provider != nil, isOpenAICompatible,
              !EndpointSecurity.isLoopbackURL(baseURL),
              apiKeyInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return "Enter the API key to test — the stored key can't be read back."
    }

    /// The placeholder advertises "glm-4, glm-3.5-turbo", so split on commas
    /// and whitespace instead of appending the whole string as one id.
    private func addModel() {
        let separators = CharacterSet(charactersIn: ",").union(.whitespacesAndNewlines)
        for id in modelInput.components(separatedBy: separators) where !id.isEmpty {
            guard !models.contains(where: { $0.id == id }) else { continue }
            models.append(AIModel(id: id, displayName: id))
        }
        modelInput = ""
    }

    private func testConnection() {
        isTesting = true
        error = nil
        testSucceeded = false

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
            // Never put a Bearer key on cleartext to a remote host.
            guard !Self.isInsecureRemoteHTTP(normalized) else {
                isTesting = false
                error = "Refusing to send the API key over plain http to a non-local host. Use https."
                return
            }
            request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        }

        URLSession.shared.dataTask(with: request) { _, response, err in
            DispatchQueue.main.async {
                isTesting = false
                if let err = err {
                    error = "Connection failed: \(err.localizedDescription)"
                } else if let http = response as? HTTPURLResponse, http.statusCode == 200 {
                    error = nil
                    testSucceeded = true
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
        let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedBaseURL = baseURL.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedAnthropicURL = anthropicBaseURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedName.isEmpty else { error = "Enter a name."; return }
        guard Self.isHTTPURL(trimmedBaseURL) else {
            error = "API Base URL must be an http(s) URL, e.g. https://api.example.com/v1"
            return
        }
        guard trimmedAnthropicURL.isEmpty || Self.isHTTPURL(trimmedAnthropicURL) else {
            error = "Anthropic base URL must be an http(s) URL."
            return
        }
        // WHY refuse here (not just warn): the server accepts any http(s) URL
        // and dials it with the vault key, so a plain-http remote endpoint
        // would send the key unencrypted.
        guard !EndpointSecurity.isInsecureRemoteHTTP(trimmedBaseURL),
              !EndpointSecurity.isInsecureRemoteHTTP(trimmedAnthropicURL) else {
            error = "Plain http to a non-local host would send your API key unencrypted. Use https."
            return
        }
        var newProvider = CustomProvider(
            name: trimmedName,
            baseURL: trimmedBaseURL,
            apiKey: "",   // set below from the stable id
            models: models,
            isOpenAICompatible: isOpenAICompatible,
            description: description,
            anthropicBaseURL: trimmedAnthropicURL.isEmpty ? nil : trimmedAnthropicURL
        )
        if let provider = provider {
            newProvider.id = provider.id   // keep id on edit
        }
        // Vault key derived from the provider's STABLE UUID id (not the name):
        // survives renames, avoids charset/collision bugs, and matches the
        // backend allowlist regex /^custom\.[a-z0-9-]+\.apiKey$/.
        newProvider.apiKey = "custom.\(newProvider.id.lowercased()).apiKey"
        // Store the key in the server vault first. A failure keeps the sheet
        // open with the key still typed in: `try?` here closed the sheet as
        // if saved, and the provider then failed every request with no key.
        let trimmedKey = apiKeyInput.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmedKey.isEmpty {
            do {
                try await api.setSecret(key: newProvider.apiKey, value: trimmedKey)
            } catch {
                self.error = "Couldn't store the API key: \(error.localizedDescription)"
                return
            }
        }
        onSave(newProvider)
    }

    /// http (not https) to anything but a loopback host.
    static func isInsecureRemoteHTTP(_ s: String) -> Bool {
        EndpointSecurity.isInsecureRemoteHTTP(s)
    }

    static func isHTTPURL(_ s: String) -> Bool {
        guard let u = URL(string: s), let scheme = u.scheme?.lowercased(),
              scheme == "http" || scheme == "https",
              let host = u.host, !host.isEmpty else { return false }
        return true
    }
}

// MARK: - Helpers

/// Shared URL-safety checks (also used by ProvidersSettingsSection).
enum EndpointSecurity {
    static func isLoopbackURL(_ s: String) -> Bool {
        guard let host = URL(string: s.trimmingCharacters(in: .whitespacesAndNewlines))?.host?.lowercased()
        else { return false }
        return host == "localhost" || host == "127.0.0.1" || host == "::1" || host == "[::1]"
    }

    /// http (not https) to anything but a loopback host.
    static func isInsecureRemoteHTTP(_ s: String) -> Bool {
        guard let url = URL(string: s.trimmingCharacters(in: .whitespacesAndNewlines)),
              url.scheme?.lowercased() == "http", url.host != nil else { return false }
        return !isLoopbackURL(s)
    }
}

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
