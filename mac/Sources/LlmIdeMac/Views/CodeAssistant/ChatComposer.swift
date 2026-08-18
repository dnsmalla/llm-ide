import SwiftUI
import AppKit

extension CodeAssistantPanel {

    // MARK: - Autocomplete actions

    /// ↑ moves the autocomplete selection when the menu is open, otherwise walks
    /// prompt history (the original behaviour).
    func arrowUpAction() -> Bool {
        if completion.isOpen { completion.moveUp(); return true }
        return historyUp() == .handled
    }
    func arrowDownAction() -> Bool {
        if completion.isOpen { completion.moveDown(); return true }
        return historyDown() == .handled
    }

    /// Apply the highlighted completion: rewrite the draft for a command/skill,
    /// or attach the chosen file and strip its "@token" from the draft.
    func acceptCompletion() {
        guard let accept = completion.acceptSelected(currentDraft: draft) else {
            completion.close(); return
        }
        switch accept {
        case .replaceDraft(let s):
            draft = s
        case .attachFile(let url, let newDraft):
            switch addFile(url: url) {
            case .added, .duplicate: break
            case .notText:   attachNotice = "That file isn't text — not attached."
            case .unreadable: attachNotice = "Couldn't read that file."
            }
            draft = newDraft
        case .useSkill(let id, let name, let newDraft):
            // Library skill → chip carrying the id sent via the skill channel.
            addInvokedSkill(.init(id: id, name: name, action: .library(id)))
            draft = newDraft
        case .useDirective(let id, let name, let directive, let newDraft):
            // In-built skill/subagent → chip carrying the directive text that's
            // prepended to the message on send (composer stays clean).
            addInvokedSkill(.init(id: id, name: name, action: .directive(directive)))
            draft = newDraft
        }
        completion.close()
    }

    /// Append an invoked-skill chip, deduped by id.
    func addInvokedSkill(_ skill: InvokedSkill) {
        if !attachmentState.selectedSkills.contains(where: { $0.id == skill.id }) {
            attachmentState.selectedSkills.append(skill)
        }
    }

    // MARK: - Attachment bar

    /// Dismissible inline notice for files that couldn't be attached.
    func attachNoticeBar(_ message: String) -> some View {
        HStack(spacing: 6) {
            Image(systemName: "info.circle")
                .font(.system(size: 11))
                .foregroundStyle(theme.current.textMuted)
            Text(message)
                .font(.system(size: 11))
                .foregroundStyle(theme.current.textMuted)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
            Button {
                attachNotice = nil
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(theme.current.textMuted)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Dismiss")
        }
        .padding(.horizontal, Spacing.md)
        .padding(.vertical, 6)
        .background(theme.current.surface.opacity(0.6))
    }

    /// Non-dismissable inline hint shown while the agent-engine toggle is on
    /// but the selected provider can't take the v2 engine — sits directly
    /// above the input bar's mode/model chips so the condition and its
    /// remedy (switch provider) are on screen together. Clears itself the
    /// moment the conflict does (unlike `attachNoticeBar`, there is no
    /// "later" to keep it for — the state is live).
    var agentV2ProviderHintBar: some View {
        HStack(spacing: 6) {
            Image(systemName: "info.circle")
                .font(.system(size: 11))
                .foregroundStyle(theme.current.warning)
            Text("v2 needs the Anthropic provider — turns will use the classic engine until you switch.")
                .font(.system(size: 11))
                .foregroundStyle(theme.current.textMuted)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, Spacing.md)
        .padding(.vertical, 6)
        .background(theme.current.warning.opacity(0.08))
    }

    var attachmentBar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(attachmentState.attachments) { a in
                    AttachmentChip(path: a.path, charCount: a.content.count, isBinary: a.content.hasPrefix("[binary:")) {
                        attachmentState.attachments.removeAll { $0.path == a.path }
                    }
                }
            }
            .padding(.horizontal, Spacing.md)
            .padding(.vertical, 6)
        }
        .background(theme.current.surface.opacity(0.6))
    }

    /// Chips for library skills the user invoked — distinct from attachmentState.attachments so
    /// it's clear these are followed, not edited. Each is individually removable.
    var skillBar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(attachmentState.selectedSkills) { s in
                    HStack(spacing: 4) {
                        Image(systemName: s.iconName)
                            .font(.system(size: 10))
                        Text(s.name)
                            .font(.system(size: 11, weight: .medium))
                            .lineLimit(1)
                        Button {
                            attachmentState.selectedSkills.removeAll { $0.id == s.id }
                        } label: {
                            Image(systemName: "xmark.circle.fill")
                                .font(.system(size: 11))
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Remove \(s.name) skill")
                    }
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .foregroundStyle(theme.current.accent)
                    .background(theme.current.accent.opacity(0.12))
                    .clipShape(Capsule())
                }
            }
            .padding(.horizontal, Spacing.md)
            .padding(.vertical, 6)
        }
        .background(theme.current.surface.opacity(0.6))
    }

    // MARK: - Input bar

    var inputBar: some View {
        VStack(spacing: 0) {
            // Messages queued while a turn is running — they auto-send in order,
            // one per turn. Each is individually removable.
            if !engine.queued.isEmpty {
                VStack(spacing: 0) {
                    ForEach(Array(engine.queued.enumerated()), id: \.element.id) { index, q in
                        HStack(spacing: 6) {
                            Image(systemName: "clock")
                                .font(.system(size: 10))
                                .foregroundStyle(theme.current.textMuted)
                            Text("Queued #\(index + 1): \(q.text)")
                                .font(.system(size: 11))
                                .foregroundStyle(theme.current.textMuted)
                                .lineLimit(1)
                                .truncationMode(.tail)
                            Spacer()
                            Button {
                                // Remove by stable id, not index — the queue may
                                // have shifted (FIFO drain) since this row rendered.
                                engine.cancelQueued(id: q.id)
                            } label: {
                                Image(systemName: "xmark.circle.fill")
                                    .font(.system(size: 11))
                                    .foregroundStyle(theme.current.textMuted)
                            }
                            .buttonStyle(.plain)
                            .help("Cancel this queued message")
                            .accessibilityLabel("Cancel queued message \(index + 1)")
                        }
                        .padding(.horizontal, 12)
                        .padding(.vertical, 5)
                    }
                }
                .background(theme.current.surface)
                Divider().background(theme.current.border)
            }
            // Autocomplete dropdown — sits directly above the editor (Cursor-style).
            // Kept ALWAYS in the tree and toggled via height/opacity — do NOT
            // wrap in `if completion.isOpen`. Inserting/removing this sibling
            // adjacent to the editor rebuilds the editor subtree and drops the
            // NSTextView's first responder, which silently kills ↑ history
            // recall after the menu has been used once (same fragility the
            // placeholder below documents).
            CompletionMenu(controller: completion, onAccept: { acceptCompletion() })
                .environmentObject(theme)
                .padding(.horizontal, 8)
                .padding(.top, 4)
                .frame(height: completion.isOpen ? nil : 0)
                .opacity(completion.isOpen ? 1 : 0)
                .allowsHitTesting(completion.isOpen)
                .clipped()
            // Text area
            ZStack(alignment: .topLeading) {
                // Keep the placeholder ALWAYS in the tree and toggle its
                // opacity — do NOT wrap it in `if draft.isEmpty`. Inserting/
                // removing this sibling on the first recall (empty → text)
                // rebuilds the editor subtree, and the NSTextView loses first
                // responder, so the second ↑ never reaches keyDown — which is
                // why recall got stuck after a single prompt.
                Text(isCompact ? "Ask Claude…" : "Ask Claude about the attached code…")
                    .font(.system(size: 12))
                    .foregroundStyle(theme.current.textMuted.opacity(0.6))
                    .padding(.horizontal, 12)
                    .padding(.top, 10)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .allowsHitTesting(false)
                    .opacity(draft.isEmpty ? 1 : 0)
                // Recall previous prompts with ↑ / ↓ (like a shell / Claude
                // Code). Backed by NSTextView so the arrows are reliably
                // intercepted: SwiftUI's TextEditor swallows them for caret
                // movement once the field has text, which capped recall at a
                // single prompt. historyUp/historyDown still own the gating —
                // they only hijack the arrows when the field is empty or we're
                // already browsing; otherwise the caret moves normally.
                HistoryTextEditor(
                    text: $draft,
                    font: .systemFont(ofSize: 12),
                    textColor: NSColor(theme.current.text),
                    onArrowUp: { arrowUpAction() },
                    onArrowDown: { arrowDownAction() },
                    onReturn: { if completion.isOpen { acceptCompletion(); return true }; return false },
                    onTab: { if completion.isOpen { acceptCompletion(); return true }; return false },
                    onEscape: { if completion.isOpen { completion.close(); return true }; return false }
                )
                .frame(height: composerHeight)
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
            }
            .background(theme.current.body)

            Divider().background(theme.current.border)

            // Bottom toolbar — picks between a single-row layout and a
            // two-row stacked layout depending on available width.
            // ViewThatFits measures the wide layout's ideal width
            // against the parent's offered width; if it doesn't fit,
            // it falls back to the stacked one.
            ViewThatFits(in: .horizontal) {
                toolbarSingleRow
                toolbarStacked
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(theme.current.surface)
        }
        .overlay(RoundedRectangle(cornerRadius: 8)
                    .strokeBorder(theme.current.border, lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .padding(.horizontal, Spacing.md)
        .padding(.vertical, 10)
    }

    // MARK: - Toolbar layouts (used by ViewThatFits)

    /// Wide layout — all chips, hint, and send button on one row.
    var toolbarSingleRow: some View {
        HStack(spacing: 6) {
            if showFileAttachButtons {
                contextButton(icon: "plus", label: "Add from Library", action: { sheets.showLibraryPicker = true })
                if !attachmentState.attachments.isEmpty {
                    Text("\(attachmentState.attachments.count) file\(attachmentState.attachments.count == 1 ? "" : "s") · \(formatBytes(totalAttachmentChars))")
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundStyle(theme.current.textMuted)
                        .lineLimit(1)
                        .padding(.leading, 4)
                }
            }
            if showModelPicker { modelPickerChips }
            modePicker
            editModeChip
            memoryButton
            Spacer()
            keyHint
            voiceControlButton
            sendButton
        }
    }

    /// Narrow layout — chips wrap to a top row; the keyboard hint
    /// and send button keep their own bottom row right-aligned.
    var toolbarStacked: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                if showFileAttachButtons {
                    contextButton(icon: "plus", label: "Add from Library", action: { sheets.showLibraryPicker = true })
                }
                if showModelPicker { modelPickerChips }
                modePicker
                editModeChip
                memoryButton
                Spacer(minLength: 0)
            }
            if showFileAttachButtons && !attachmentState.attachments.isEmpty {
                Text("\(attachmentState.attachments.count) file\(attachmentState.attachments.count == 1 ? "" : "s") · \(formatBytes(totalAttachmentChars))")
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(theme.current.textMuted)
                    .lineLimit(1)
            }
            HStack(spacing: 6) {
                Spacer(minLength: 0)
                keyHint
                voiceControlButton
                sendButton
            }
        }
    }

    /// Opens the project-memory viewer (auto-captured facts about this repo).
    /// Shows the last turn's memory token cost so the always-on memory block's
    /// overhead is visible — 0 means no project memory was injected.
    var memoryButton: some View {
        Button { sheets.showProjectMemory = true } label: {
            HStack(spacing: 3) {
                Image(systemName: "brain").font(.system(size: 11))
                if let t = engine.agent.lastMemoryTokens {
                    Text(t > 0 ? "~\(formatTokens(t))" : "0")
                        .font(.system(size: 9, weight: .medium, design: .rounded))
                }
            }
            .frame(height: 22)
            .padding(.horizontal, engine.agent.lastMemoryTokens == nil ? 0 : 3)
        }
        .buttonStyle(.plain)
        .foregroundStyle(theme.current.textMuted)
        .help(memoryButtonHelp)
        .accessibilityLabel("Project memory")
    }

    var memoryButtonHelp: String {
        guard let t = engine.agent.lastMemoryTokens else {
            return "Project memory — what the assistant has learned about this repo"
        }
        if t == 0 {
            return "Project memory — no memory injected last turn (0 tokens). None generated for this project yet."
        }
        let chat = engine.agent.lastMemoryHasChat ? " (incl. chat-captured facts)" : " (graph-derived only)"
        return "Project memory — added ~\(t) tokens to the last request\(chat). Click to view/prune."
    }

    /// "1.2k" / "850" style compact token count.
    func formatTokens(_ t: Int) -> String {
        t >= 1000 ? String(format: "%.1fk", Double(t) / 1000.0) : "\(t)"
    }

    var keyHint: some View {
        Text("⌘↵")
            .font(.system(size: 10, design: .monospaced))
            .foregroundStyle(theme.current.textMuted.opacity(0.6))
            .fixedSize()
    }

    var sendButton: some View {
        HStack(spacing: 6) {
            // While a turn is running, offer a Stop control that cancels it.
            if engine.busy {
                Button { engine.stop() } label: {
                    Image(systemName: "stop.fill")
                        .font(.system(size: 11, weight: .semibold))
                        .frame(width: 24, height: 24)
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .keyboardShortcut(.cancelAction)   // Esc
                .help("Stop the running response (Esc)")
                .accessibilityLabel("Stop")
            }
            if engine.agent.agentIsAutonomous && !engine.busy {
                Button(action: {
                    engine.agent.agentStopRequested = true
                    engine.agent.agentIsAutonomous = false
                }) {
                    Label("Stop", systemImage: "stop.circle.fill")
                        .foregroundColor(theme.current.danger)
                }
                .buttonStyle(.borderless)
                .help("Stop autonomous agent")
            }
            // ⌘↵ submits the draft: sends now when idle, queues when a turn is
            // already running (auto-sends as the next turn).
            Button {
                submit()
            } label: {
                Image(systemName: engine.busy ? "arrow.up.to.line" : "arrow.up")
                    .font(.system(size: 12, weight: .semibold))
                    .frame(width: 24, height: 24)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.small)
            .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            .keyboardShortcut(.return, modifiers: .command)
            .help(engine.busy ? "Queue this message — sends when the current response finishes (⌘↵)" : "Send (⌘↵)")
            .accessibilityLabel(engine.busy ? "Queue message" : "Send message")
        }
    }

    /// CLI-branded agent chip + model picker.
    /// Both chips are `.fixedSize()` so their text never squeezes —
    /// without this, a narrow parent container collapses the chip
    /// down past 1-character width and SwiftUI renders the label
    /// vertically (one glyph per line).  The chips truncate via
    /// `.lineLimit(1)` as a belt-and-braces guard.
    var modelPickerChips: some View {
        let isCustom = modelState.selectedProvider.starts(with: "custom:")
        let currentTool = !isCustom ? (AICliTool(rawValue: modelState.selectedProvider) ?? .claudeCode) : .claudeCode
        let currentProvider = isCustom
            ? modelState.customProviders.first(where: { "custom:\($0.id)" == modelState.selectedProvider })
            : nil

        return HStack(spacing: 6) {
            // Provider chip — a menu to switch among the direct-API providers
            // (Claude / OpenAI / Gemini) and custom providers.
            Menu {
                // Built-in tools
                ForEach(AICliTool.selectable) { tool in
                    Button { switchProvider(.builtIn(tool)) } label: {
                        Label(tool.displayName, systemImage: tool.icon)
                    }
                }
                if !modelState.customProviders.isEmpty {
                    Divider()
                    // Custom providers
                    ForEach(modelState.customProviders) { provider in
                        Button { switchProvider(.custom(provider)) } label: {
                            Label(provider.name, systemImage: "network")
                        }
                    }
                }
            } label: {
                let label = currentProvider?.name ?? currentTool.displayName
                Chip(
                    icon: isCustom ? "network" : currentTool.icon,
                    label: isCompact ? "" : label,
                    trailing: "chevron.down",
                    compact: isCompact
                )
            }
            .menuStyle(.borderlessButton)
            .help("Switch model provider")
            .fixedSize()

            // Model picker. Truncate label aggressively when compact so
            // the chip stays one capsule wide instead of wrapping.
            Menu {
                ForEach(modelsForCurrentProvider()) { model in
                    Button(model.displayName) {
                        modelState.selectedModel = model.id
                        // Persist the pick so surfaces that read AppConfig —
                        // notably the iPhone chat proxy (MobileExploreBridge
                        // reads config.defaultModelId) — forward the actually-
                        // selected model instead of the stale tool default
                        // (empty for the generic Custom tool). Without this the
                        // phone sent provider with no model → GLM "Unknown
                        // Model". Skip custom:<uuid> providers: those aren't
                        // represented by config.activeCLI (mobile proxy support
                        // is built-in providers only).
                        if !modelState.selectedProvider.starts(with: "custom:") {
                            config.defaultModelId = model.id
                        }
                    }
                }
                if !isCustom {
                    Divider()
                    Button("Add model…") { modelState.newModelId = ""; modelState.showAddModel = true }
                }
            } label: {
                let displayName = isCustom
                    ? (modelState.customProviders.first(where: { "custom:\($0.id)" == modelState.selectedProvider })?.models.first(where: { $0.id == modelState.selectedModel })?.displayName ?? modelState.selectedModel)
                    : currentModelDisplayName(for: currentTool)
                Chip(
                    icon: nil,
                    label: isCompact ? String(displayName.prefix(6)) : displayName,
                    trailing: "chevron.down",
                    compact: isCompact
                )
            }
            .menuStyle(.borderlessButton)
            .help("Select model")
            .fixedSize()
        }
        .alert("Add a model", isPresented: $modelState.showAddModel) {
            TextField("model id, e.g. gpt-5 / claude-opus-4-9 / gemini-2.5-pro", text: $modelState.newModelId)
            Button("Add") {
                let id = modelState.newModelId.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !id.isEmpty else { return }
                let active = AICliTool(rawValue: config.activeCLI) ?? .claudeCode
                addCustomModel(id, provider: active.provider)
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Adds a model id under the current provider. It's sent to the backend as-is and routed by id prefix — handy for a release not yet in the list.")
        }
    }

    /// Shared chip-style Menu builder for any `ChipMenuOption` enum — one
    /// generic in place of one hand-written Menu+Chip per mode selector.
    /// `editModeChip` and `modePicker` below are its only two call sites.
    func chipMenu<T: ChipMenuOption>(_ selection: Binding<T>) -> some View {
        Menu {
            ForEach(Array(T.allCases)) { option in
                Button { selection.wrappedValue = option } label: {
                    Label(option.label, systemImage: option.icon)
                }
            }
        } label: {
            Chip(
                icon: selection.wrappedValue.icon,
                label: isCompact ? "" : selection.wrappedValue.label,
                trailing: "chevron.down",
                compact: isCompact
            )
        }
        .menuStyle(.borderlessButton)
        .help(selection.wrappedValue.help)
        .fixedSize()
    }

    /// Edit-acceptance mode selector (Manual / Bypass).
    var editModeChip: some View {
        chipMenu(Binding(
            get: { editMode },
            set: { editModeRaw = $0.rawValue }
        ))
    }

    /// Code-assist mode selector (Auto / Plan / Assist Plan / Code Review / Document / Execute).
    var modePicker: some View {
        chipMenu($modelState.selectedMode)
    }
    func currentModelDisplayName(for cli: AICliTool) -> String {
        let models = modelsFor(cli)
        return models.first(where: { $0.id == modelState.selectedModel })?.displayName
            ?? models.first?.displayName
            ?? modelState.selectedModel
    }

    /// Models for the currently selected provider (built-in or custom).
    func modelsForCurrentProvider() -> [AIModel] {
        if modelState.selectedProvider.starts(with: "custom:") {
            // Custom provider: return its models list
            if let custom = modelState.customProviders.first(where: { "custom:\($0.id)" == modelState.selectedProvider }) {
                return custom.models
            }
            return []
        } else {
            // Built-in provider
            if let cli = AICliTool(rawValue: modelState.selectedProvider) {
                return modelsFor(cli)
            }
            return []
        }
    }

    /// `/model <query>` — real, direct action (not a fake reference entry):
    /// resolves `query` against the current provider's known models (exact
    /// id/displayName match first, substring fallback) and sets it the same
    /// way tapping a model-picker chip menu item does, including the
    /// `config.defaultModelId` sync for built-in providers (see the model
    /// picker Menu in this file) so the iPhone chat proxy sees the change
    /// too. There is no way to programmatically open the picker's native
    /// SwiftUI Menu itself (see ChatSlashCommands.swift's header note on
    /// scope), so a bare "/model" with no argument just explains usage.
    func applyModelCommand(_ query: String) {
        guard !query.isEmpty else {
            engine.error = "Usage: /model <name> — e.g. /model sonnet, /model gpt-5"
            return
        }
        let candidates = modelsForCurrentProvider()
        let q = query.lowercased()
        guard let match = candidates.first(where: { $0.id.lowercased() == q || $0.displayName.lowercased() == q })
            ?? candidates.first(where: { $0.id.lowercased().contains(q) || $0.displayName.lowercased().contains(q) })
        else {
            let available = candidates.map(\.displayName).joined(separator: ", ")
            engine.error = "No model matching \"\(query)\" for the current provider.\(available.isEmpty ? "" : " Available: \(available)")"
            return
        }
        modelState.selectedModel = match.id
        if !modelState.selectedProvider.starts(with: "custom:") {
            config.defaultModelId = match.id
        }
    }

    /// Models to offer for a provider: the live list when we've fetched one,
    /// otherwise the built-in static list (keeps the picker populated when no
    /// key is set or the fetch failed), plus any user-added custom ids.
    func modelsFor(_ cli: AICliTool) -> [AIModel] {
        let base = (modelState.liveModels[cli.provider]?.isEmpty == false) ? modelState.liveModels[cli.provider]! : cli.models
        let baseIds = Set(base.map(\.id))
        let custom = customModels(for: cli.provider)
            .filter { !baseIds.contains($0) }
            .map { AIModel(id: $0, displayName: $0) }
        return base + custom
    }

    /// User-added model ids for a provider (decoded from AppStorage JSON).
    func customModels(for provider: String) -> [String] {
        let dict = (try? JSONDecoder().decode([String: [String]].self,
                                              from: Data(customModelsRaw.utf8))) ?? [:]
        return dict[provider] ?? []
    }

    /// Append a custom model id for a provider and select it.
    func addCustomModel(_ id: String, provider: String) {
        var dict = (try? JSONDecoder().decode([String: [String]].self,
                                              from: Data(customModelsRaw.utf8))) ?? [:]
        var list = dict[provider] ?? []
        if !list.contains(id) { list.append(id) }
        dict[provider] = list
        if let data = try? JSONEncoder().encode(dict), let s = String(data: data, encoding: .utf8) {
            customModelsRaw = s
        }
        modelState.selectedModel = id
        // Persist so the iPhone chat proxy forwards this model too (see the
        // model-picker Button above). addCustomModel is only reachable from the
        // built-in "Add model…" alert, so modelState.selectedProvider is a built-in tool.
        if !modelState.selectedProvider.starts(with: "custom:") {
            config.defaultModelId = id
        }
    }

    /// Fetch the provider's live chat models (best-effort; silent on failure).
    func loadModels(for cli: AICliTool) async {
        guard let ids = try? await api.listProviderModels(cli.provider), !ids.isEmpty else { return }
        modelState.liveModels[cli.provider] = ids.map { AIModel(id: $0, displayName: $0) }
    }

    /// Switch the active model provider and reset the selected model.
    func switchProvider(_ provider: ProviderSwitch) {
        switch provider {
        case .builtIn(let tool):
            modelState.selectedProvider = tool.rawValue
            modelState.selectedModel = tool.defaultModelId
            config.activeCLI = tool.rawValue
            config.defaultModelId = tool.defaultModelId
            Task { await loadModels(for: tool) }
        case .custom(let customProvider):
            modelState.selectedProvider = "custom:\(customProvider.id)"
            modelState.selectedModel = customProvider.models.first?.id ?? ""
        }
    }

    enum ProviderSwitch {
        case builtIn(AICliTool)
        case custom(CustomProvider)
    }

    /// Single source of truth for composer text-area height.  Caps
    /// the editor so it never pushes everything else off-screen.
    /// Grows linearly with line count up to a hard ceiling.
    var composerHeight: CGFloat {
        let lineCount = max(1, draft.components(separatedBy: "\n").count)
        let approx = CGFloat(lineCount) * 16 + 12
        return min(max(approx, 40), 120)
    }

    /// Compact text-button for the composer footer.  Borderless,
    /// hover-only highlight — quieter than the previous pill style so
    /// the composer feels like one cohesive element instead of a row
    /// of competing controls.
    @ViewBuilder
    func contextButton(icon: String, label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 4) {
                Image(systemName: icon)
                    .font(.system(size: 10, weight: .medium))
                // These are the lowest-priority controls, so drop them to
                // icon-only as soon as the panel isn't comfortably wide —
                // keeping room for the model picker rather than clipping it.
                // `lineLimit(1)` + `fixedSize` are essential: without them a
                // narrow row squeezes the label to 1-character width and
                // SwiftUI renders it vertically (one glyph per line).
                if panelWidth >= 320 {
                    Text(label)
                        .font(.system(size: 11))
                        .lineLimit(1)
                        .fixedSize(horizontal: true, vertical: false)
                }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .foregroundStyle(theme.current.textMuted)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(label)
    }

    func formatBytes(_ chars: Int) -> String {
        if chars < 1024 { return "\(chars) B" }
        if chars < 1024 * 1024 {
            let kb = Double(chars) / 1024.0
            return String(format: "%.1f KB", kb)
        }
        let mb = Double(chars) / (1024.0 * 1024.0)
        return String(format: "%.2f MB", mb)
    }

    var totalAttachmentChars: Int {
        attachmentState.attachments.reduce(0) { $0 + $1.content.count }
    }

    enum AttachOutcome { case added, duplicate, notText, unreadable }


    // MARK: - Send

    @MainActor
    /// ⌘↵ / Send button. Sends the draft now when idle; appends it to the queue
    /// when a turn is already running (queued messages auto-send in FIFO order,
    /// one per turn).
    func submit() {
        let msg = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !msg.isEmpty else { return }
        draft = ""

        // Built-in slash command — never sent to the model as a prompt.
        // Deliberately NOT the same mechanism as a plugin's own slash command
        // (that's server-side prompt-expansion, not a client-side UI action).
        if ChatSlashCommands.isClearCommand(msg) {
            Task { await engine.clearCurrentChat() }
            return
        }
        if let section = ChatSlashCommands.sectionCommand(msg) {
            NotificationCenter.default.post(name: .openSection, object: section.rawValue)
            return
        }
        if let modelQuery = ChatSlashCommands.modelArgument(msg) {
            applyModelCommand(modelQuery)
            return
        }

        // Record the PLAIN text for ↑ recall (not the skill-decorated message).
        if sentPrompts.last != msg {
            sentPrompts.append(msg)
            if sentPrompts.count > 100 { sentPrompts.removeFirst(sentPrompts.count - 100) }
        }
        historyIndex = nil
        draftStash = ""
        // Consume the invoked-skill chips one-shot for THIS message: in-built
        // directives are prepended to the text; library ids ride alongside it
        // (sent via the skill channel). Cleared so a skill applies to exactly the
        // message it was invoked for, not silently to every later turn.
        let directives = attachmentState.selectedSkills.compactMap { s -> String? in
            if case .directive(let d) = s.action { return d } else { return nil }
        }
        let skillIds = attachmentState.selectedSkills.compactMap { s -> String? in
            if case .library(let id) = s.action { return id } else { return nil }
        }
        attachmentState.selectedSkills = []
        let outgoing = directives.isEmpty ? msg : directives.joined(separator: "\n") + "\n\n" + msg
        if engine.busy {
            engine.enqueue(outgoing, skillIds: skillIds)
        } else {
            engine.startTurn(outgoing, skillIds: skillIds)
        }
    }

    /// ↑ in the composer: walk back through previously-sent prompts. Returns
    /// `.ignored` (so the cursor moves normally) unless the field is empty or
    /// we're already browsing history.
    /// Seed ↑/↓ recall from a loaded/switched session's messages. Without
    /// this, `sentPrompts` only tracks prompts submitted in the CURRENT app
    /// run, so after a relaunch or session switch the chat shows prior turns
    /// but ↑ recalls nothing. Synthetic tool acks are skipped so they don't
    /// pollute recall — by ROLE now (`.toolResult` is not `.user`), where this
    /// used to have to guess from a leading "(".
    func rebuildSentPrompts(from turns: [ChatMessage]) {
        var prompts: [String] = []
        for t in turns where t.role == .user {
            let c = t.content.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !c.isEmpty else { continue }
            if prompts.last != c { prompts.append(c) }
        }
        if prompts.count > 100 { prompts.removeFirst(prompts.count - 100) }
        sentPrompts = prompts
        historyIndex = nil
        draftStash = ""
    }

    func historyUp() -> KeyPress.Result {
        guard !sentPrompts.isEmpty, draft.isEmpty || historyIndex != nil else { return .ignored }
        if let i = historyIndex {
            guard i > 0 else { return .handled }   // already at the oldest
            historyIndex = i - 1
        } else {
            draftStash = draft                     // stash the live draft
            historyIndex = sentPrompts.count - 1
        }
        draft = sentPrompts[historyIndex!]
        return .handled
    }

    /// ↓ in the composer: walk forward; past the newest, restore the draft.
    func historyDown() -> KeyPress.Result {
        guard let i = historyIndex else { return .ignored }
        if i < sentPrompts.count - 1 {
            historyIndex = i + 1
            draft = sentPrompts[historyIndex!]
        } else {
            historyIndex = nil
            draft = draftStash
        }
        return .handled
    }

}
