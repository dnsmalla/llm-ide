import SwiftUI

/// The Add button's sheet: pick the connection type, then fill its form.
///  - OpenAI-compatible (adapter): a catalog provider (OpenAI, Google, Groq, Ollama …) or the generic
///    "OpenAI-compatible" entry, which takes a custom base URL. Stored on the server.
///  - Claude-compatible (Claude engine): a named endpoint that speaks the Anthropic API (GLM, DeepSeek's
///    /anthropic door, Ollama). Stored in this Mac's custom provider list, as before.
struct AddProviderSheet: View {
    @ObservedObject var model: ProvidersModel
    let onClose: () -> Void
    @EnvironmentObject var theme: ThemeStore
    @State private var kind: ProviderKind = .openAIAdapter

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.md) {
            HStack {
                Text("Add a provider").font(Typography.title).foregroundStyle(theme.current.text)
                Spacer()
                Button("Cancel") { onClose() }.buttonStyle(.borderless)
            }
            Picker("Type", selection: $kind) {
                Text(ProviderKind.openAILabel).tag(ProviderKind.openAIAdapter)
                Text(ProviderKind.claudeLabel).tag(ProviderKind.claudeEngine)
            }
            .pickerStyle(.segmented)
            .accessibilityLabel("Connection type")
            switch kind {
            case .claudeEngine:
                CustomProviderForm(model: model, provider: nil, embedded: true, onClose: onClose)
            default:
                CatalogConnectForm(model: model, onClose: onClose)
            }
        }
        .padding(Spacing.lg)
        .frame(minWidth: 520, minHeight: 360)
    }
}

/// Catalog picker + key (+ base URL for the entries that take one). The key lives in a SecureField, is sent
/// once, and is cleared when the form goes away.
struct CatalogConnectForm: View {
    @ObservedObject var model: ProvidersModel
    let onClose: () -> Void
    @EnvironmentObject var theme: ThemeStore
    @State private var entryId = ""
    @State private var apiKey = ""
    @State private var baseURL = ""
    @State private var slug = ""
    @State private var allowPrivate = false
    @State private var saving = false

    private var entries: [LlmIdeAPIClient.CatalogProvider] { model.catalog.providers }
    private var entry: LlmIdeAPIClient.CatalogProvider? { entries.first { $0.id == entryId } ?? entries.first }
    private var needsURL: Bool { entry?.customBaseURL == true }
    private var canSave: Bool {
        guard let entry, !saving else { return false }
        let keyOK = !entry.keyRequired || !apiKey.trimmingCharacters(in: .whitespaces).isEmpty
        let urlOK = !needsURL || !baseURL.trimmingCharacters(in: .whitespaces).isEmpty
        return keyOK && urlOK && !EndpointSecurity.isInsecureRemoteHTTP(baseURL)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.md) {
            if entries.isEmpty {
                Text(model.catalog.loadError.map { "Couldn't load the catalog: \($0)" } ?? "Loading the catalog…")
                    .font(Typography.caption).foregroundStyle(theme.current.textMuted)
                Button("Retry") { Task { await model.catalog.load() } }.controlSize(.small)
            } else if let entry {
                Picker("Provider", selection: Binding(get: { entry.id }, set: { entryId = $0 })) {
                    ForEach(entries) { e in
                        Text(e.connections.isEmpty ? e.name : "\(e.name) (connected)").tag(e.id)
                    }
                }
                .accessibilityLabel("Catalog provider")
                if !entry.notes.isEmpty { SettingsHint(entry.notes) }
                if needsURL {
                    TextField("Base URL (https://host/v1)", text: $baseURL).textFieldStyle(.roundedBorder)
                        .accessibilityLabel("Base URL")
                    TextField("Short name (letters and digits, optional; names a second endpoint)", text: $slug)
                        .textFieldStyle(.roundedBorder)
                    Toggle("This is on my own network (localhost or a private address)", isOn: $allowPrivate)
                        .toggleStyle(.checkbox)
                    SettingsHint("Only turn this on for a server you run. Link-local and cloud-metadata addresses are always refused.")
                } else {
                    Text(entry.baseURL).font(Typography.caption).foregroundStyle(theme.current.textMuted)
                }
                SecureField(entry.keyRequired ? "API key" : "API key (optional)", text: $apiKey)
                    .textFieldStyle(.roundedBorder)
                    .accessibilityLabel("API key")
                if !entry.connections.isEmpty && !needsURL {
                    SettingsHint("Already connected. Saving again with a blank key keeps the stored key.")
                }
                if let error = model.catalog.actionError {
                    Text(error).font(Typography.caption).foregroundStyle(theme.current.danger)
                        .fixedSize(horizontal: false, vertical: true)
                }
                HStack {
                    Spacer()
                    Button("Connect") { connect(entry) }
                        .keyboardShortcut(.defaultAction)
                        .buttonStyle(.borderedProminent)
                        .disabled(!canSave)
                }
            }
        }
        .task { if model.catalog.providers.isEmpty { await model.catalog.load() } }
        .onDisappear { apiKey = ""; model.catalog.actionError = nil }
    }

    private func connect(_ entry: LlmIdeAPIClient.CatalogProvider) {
        saving = true
        let key = apiKey
        apiKey = ""
        Task {
            let ok = await model.catalog.connect(
                catalogId: entry.id, apiKey: key, baseURL: needsURL ? baseURL : nil,
                slug: needsURL && !slug.isEmpty ? slug : nil, allowPrivate: needsURL ? allowPrivate : nil)
            saving = false
            if ok {
                await model.loadConfiguredKeys()
                NotificationCenter.default.post(name: .providerKeysChanged, object: nil)
                onClose()
            }
        }
    }
}

/// Add or edit a custom provider (this Mac's list). Either URL may be given; at least one is needed. A
/// Claude-compatible URL lets the Claude engine run it; an OpenAI-compatible URL is what the adapter dials.
struct CustomProviderForm: View {
    @ObservedObject var model: ProvidersModel
    let provider: CustomProvider?
    var embedded = false
    let onClose: () -> Void
    @EnvironmentObject var theme: ThemeStore

    @State private var name = ""
    @State private var description = ""
    @State private var claudeURL = ""
    @State private var openAIURL = ""
    @State private var models: [AIModel] = []
    @State private var modelInput = ""
    @State private var apiKey = ""
    @State private var error: String?
    @State private var saving = false

    private var isEdit: Bool { provider != nil }

    private var trimmed: (claude: String, openAI: String) {
        (claudeURL.trimmingCharacters(in: .whitespacesAndNewlines), openAIURL.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    private var canSave: Bool {
        let t = trimmed
        let urlOK = isEdit ? !(t.claude.isEmpty && t.openAI.isEmpty) : !t.claude.isEmpty
        return !name.trimmingCharacters(in: .whitespaces).isEmpty && urlOK && !models.isEmpty && !saving
            && !EndpointSecurity.isInsecureRemoteHTTP(t.claude) && !EndpointSecurity.isInsecureRemoteHTTP(t.openAI)
    }

    var body: some View {
        if embedded { form } else {
            VStack(alignment: .leading, spacing: Spacing.md) {
                HStack {
                    Text(isEdit ? "Edit provider" : "Add a custom provider").font(Typography.title)
                    Spacer()
                    Button("Cancel") { onClose() }.buttonStyle(.borderless)
                }
                form
            }
            .padding(Spacing.lg)
            .frame(minWidth: 520, minHeight: 420)
        }
    }

    private var form: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.md) {
                field("Name", $name, "GLM, Ollama, …")
                field("Claude-compatible URL (Anthropic format)\(isEdit ? " (optional)" : "")", $claudeURL,
                      "https://api.z.ai/api/anthropic")
                Text("Z.AI GLM: https://api.z.ai/api/anthropic · DeepSeek: https://api.deepseek.com/anthropic · Ollama: http://localhost:11434. The Claude engine runs the provider through this URL.")
                    .font(Typography.caption).foregroundStyle(theme.current.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
                field("OpenAI-compatible URL (optional)", $openAIURL, "https://api.example.com/v1")
                field("Description (optional)", $description, "Zhipu GLM 4")
                VStack(alignment: .leading, spacing: 4) {
                    Text("API key").font(Typography.caption).foregroundStyle(theme.current.textMuted)
                    SecureField(isEdit ? "Enter a new key to replace (leave blank to keep)" : "sk-…", text: $apiKey)
                        .textFieldStyle(.roundedBorder).font(Typography.mono)
                        .accessibilityLabel("API key")
                }
                VStack(alignment: .leading, spacing: Spacing.sm) {
                    Text("Models").font(Typography.caption).foregroundStyle(theme.current.textMuted)
                    HStack {
                        TextField("glm-4, glm-3.5-turbo", text: $modelInput).textFieldStyle(.roundedBorder)
                            .onSubmit { addModel() }
                        Button("Add") { addModel() }.controlSize(.small)
                            .disabled(modelInput.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                    ForEach(models) { m in
                        HStack {
                            Text(m.displayName).font(Typography.caption)
                            Spacer()
                            Button { models.removeAll { $0.id == m.id } } label: { Image(systemName: "xmark.circle.fill") }
                                .buttonStyle(.borderless).controlSize(.small)
                                .accessibilityLabel("Remove model \(m.displayName)")
                        }
                        .padding(4)
                        .background(RoundedRectangle(cornerRadius: 4).fill(theme.current.surface))
                    }
                }
                if EndpointSecurity.isInsecureRemoteHTTP(trimmed.claude) || EndpointSecurity.isInsecureRemoteHTTP(trimmed.openAI) {
                    Text("This URL uses plain http to a non-local host: your API key would be sent unencrypted. Use https.")
                        .font(Typography.caption).foregroundStyle(theme.current.danger)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let error {
                    Text(error).font(Typography.caption).foregroundStyle(theme.current.danger)
                        .fixedSize(horizontal: false, vertical: true)
                }
                HStack {
                    Spacer()
                    Button(isEdit ? "Save" : "Add") { Task { await save() } }
                        .buttonStyle(.borderedProminent).controlSize(.small)
                        .disabled(!canSave)
                }
            }
            .padding(.vertical, Spacing.xs)
        }
        .onAppear(perform: prefill)
        .onDisappear { apiKey = "" }
    }

    private func field(_ label: String, _ text: Binding<String>, _ placeholder: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label).font(Typography.caption).foregroundStyle(theme.current.textMuted)
            TextField(placeholder, text: text).textFieldStyle(.roundedBorder).font(Typography.mono)
                .accessibilityLabel(label)
        }
    }

    private func prefill() {
        guard let p = provider, name.isEmpty else { return }
        name = p.name
        description = p.description
        models = p.models
        openAIURL = p.isOpenAICompatible ? p.baseURL : ""
        claudeURL = p.anthropicBaseURL ?? (p.isOpenAICompatible ? "" : p.baseURL)
    }

    private func addModel() {
        let separators = CharacterSet(charactersIn: ",").union(.whitespacesAndNewlines)
        for id in modelInput.components(separatedBy: separators) where !id.isEmpty {
            guard !models.contains(where: { $0.id == id }) else { continue }
            models.append(AIModel(id: id, displayName: id))
        }
        modelInput = ""
    }

    private func isHTTP(_ s: String) -> Bool {
        guard let u = URL(string: s), let scheme = u.scheme?.lowercased(), scheme == "http" || scheme == "https",
              let host = u.host, !host.isEmpty else { return false }
        return true
    }

    private func save() async {
        let t = trimmed
        let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedName.isEmpty else { error = "Enter a name."; return }
        guard t.claude.isEmpty || isHTTP(t.claude), t.openAI.isEmpty || isHTTP(t.openAI) else {
            error = "URLs must be http(s) URLs, e.g. https://api.example.com/v1"
            return
        }
        var p = CustomProvider(
            name: trimmedName, baseURL: t.openAI.isEmpty ? t.claude : t.openAI, apiKey: "", models: models,
            isOpenAICompatible: !t.openAI.isEmpty, description: description,
            anthropicBaseURL: t.claude.isEmpty ? nil : t.claude)
        if let provider { p.id = provider.id; p.isEnabled = provider.isEnabled }
        saving = true
        let key = apiKey
        apiKey = ""
        let failure = await model.saveCustom(p, apiKey: key)
        saving = false
        if let failure { apiKey = key; error = failure } else { onClose() }
    }
}
