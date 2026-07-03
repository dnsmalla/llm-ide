import SwiftUI
import GraphKit

struct GitLabSettingsSection: View {
    @EnvironmentObject var theme: ThemeStore
    @EnvironmentObject var config: AppConfig
    @EnvironmentObject var projectStore: ProjectStore
    @Environment(LibraryItemStore.self) private var library

    @State private var gitLabTokenDraft: String = ""
    @State private var gitLabTokenVisible: Bool = false
    @State private var gitLabStatus: String?
    @State private var gitLabBusy: Bool = false
    @State private var resolvingIds: Set<String> = []
    @State private var resolveErrors: [String: String] = [:]
    @State private var cloningIds: Set<String> = []
    @State private var cloneErrors: [String: String] = [:]
    private let repoManager = RepoManager()

    // Derives the GitLab host from saved project URLs; falls back to configured base.
    private var detectedBase: String {
        for p in config.gitLabSavedProjects {
            let raw = p.url.trimmingCharacters(in: .whitespacesAndNewlines)
            if raw.hasPrefix("http"), let u = URL(string: raw),
               let scheme = u.scheme, let host = u.host {
                return "\(scheme)://\(host)"
            }
        }
        return config.gitLabBaseURL
    }

    var body: some View {
        SettingsSectionCard(icon: "checklist", title: "GitLab") {
            VStack(alignment: .leading, spacing: Spacing.sm) {

                // Access Token
                HStack(spacing: Spacing.md) {
                    Text("Access Token")
                        .font(Typography.body)
                        .foregroundStyle(theme.current.textMuted)
                        .frame(width: 110, alignment: .leading)
                    ZStack(alignment: .trailing) {
                        if gitLabTokenVisible {
                            TextField("glpat-xxxxxxxxxxxxxxxxxxxx", text: $gitLabTokenDraft)
                                .textFieldStyle(.roundedBorder)
                                .font(Typography.mono)
                                .disableAutocorrection(true)
                        } else {
                            SecureField("glpat-xxxxxxxxxxxxxxxxxxxx", text: $gitLabTokenDraft)
                                .textFieldStyle(.roundedBorder)
                                .font(Typography.mono)
                        }
                        Button { gitLabTokenVisible.toggle() } label: {
                            Image(systemName: gitLabTokenVisible ? "eye.slash" : "eye")
                                .font(.system(size: 11))
                                .foregroundStyle(theme.current.textMuted)
                        }
                        .buttonStyle(.plain)
                        .padding(.trailing, 8)
                        .help(gitLabTokenVisible ? "Hide token" : "Show token")
                        .accessibilityLabel(gitLabTokenVisible ? "Hide token" : "Show token")
                    }
                }

                // Save / Clear / Status
                HStack {
                    Button(gitLabBusy ? "Verifying…" : "Save & verify") {
                        Task { await saveGitLab() }
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
                    .disabled(gitLabBusy || gitLabTokenDraft.isEmpty)

                    if !config.gitLabToken.isEmpty {
                        Button("Clear") {
                            config.gitLabToken = ""
                            config.gitLabBaseURL = "https://gitlab.com"
                            config.gitLabSavedProjects = []
                            gitLabTokenDraft = ""
                            gitLabStatus = "Cleared."
                        }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                        .foregroundStyle(theme.current.danger)
                    }

                    if let s = gitLabStatus {
                        Text(s)
                            .font(Typography.caption)
                            .foregroundStyle(s.hasPrefix("✓") ? theme.current.accent3 : theme.current.danger)
                    }
                }

                if !config.gitLabToken.isEmpty {
                    HStack(spacing: 4) {
                        Image(systemName: "checkmark.circle.fill")
                            .font(.system(size: 11))
                            .foregroundStyle(theme.current.accent3)
                        Text("Connected · \(detectedBase)")
                            .font(Typography.caption)
                            .foregroundStyle(theme.current.textMuted)
                    }
                }

                Divider().padding(.vertical, 4)

                OperationsAllowlistView(provider: .gitlab)

                Divider().padding(.vertical, 4)

                // Projects header
                HStack {
                    SectionLabel("PROJECTS", size: 10, tracking: 1.2)
                    Spacer()
                    Button {
                        var p = SavedGitLabProject()
                        if config.gitLabSavedProjects.isEmpty { p.isActive = true }
                        config.gitLabSavedProjects.append(p)
                    } label: {
                        HStack(spacing: 4) {
                            Image(systemName: "plus.circle.fill")
                                .font(.system(size: 11))
                            Text("Add project")
                                .font(.system(size: 12, weight: .medium))
                        }
                        .foregroundStyle(theme.current.accent)
                    }
                    .buttonStyle(.plain)
                    .disabled(config.gitLabToken.isEmpty)
                }

                if config.gitLabSavedProjects.isEmpty {
                    Text("No projects added yet.")
                        .font(Typography.caption)
                        .foregroundStyle(theme.current.textMuted)
                        .padding(.vertical, 4)
                } else {
                    VStack(spacing: 8) {
                        ForEach($config.gitLabSavedProjects) { $proj in
                            projectRow(proj: $proj)
                        }
                    }
                }
            }
        }
        .onAppear {
            gitLabTokenDraft = config.gitLabToken
        }
    }

    // MARK: - Project deletion

    /// Removes the project from Settings. The AppShell observer notices
    /// `gitLabSavedProjects` changed and prunes the Library's CODE section
    /// to match, so no separate cascade call is needed here.
    private func deleteProject(_ p: SavedGitLabProject) {
        let wasActive = p.isActive
        config.gitLabSavedProjects.removeAll { $0.id == p.id }
        if wasActive, let first = config.gitLabSavedProjects.first,
           let idx = config.gitLabSavedProjects.firstIndex(where: { $0.id == first.id }) {
            config.gitLabSavedProjects[idx].isActive = true
        }
    }

    // MARK: - Project row

    @ViewBuilder
    private func projectRow(proj: Binding<SavedGitLabProject>) -> some View {
        let p = proj.wrappedValue
        let t = theme.current
        let isResolving = resolvingIds.contains(p.id)
        let resolveError = resolveErrors[p.id]

        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                // Active radio
                Button {
                    for i in config.gitLabSavedProjects.indices {
                        config.gitLabSavedProjects[i].isActive = (config.gitLabSavedProjects[i].id == p.id)
                    }
                } label: {
                    Image(systemName: p.isActive ? "largecircle.fill.circle" : "circle")
                        .font(.system(size: 16))
                        .foregroundStyle(p.isActive ? t.accent : t.border)
                }
                .buttonStyle(.plain)

                // Display name
                TextField("Display name", text: proj.displayName)
                    .textFieldStyle(.plain)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(t.text)

                if p.isActive {
                    Text("ACTIVE")
                        .font(.system(size: 9, weight: .bold))
                        .foregroundStyle(t.accent)
                        .padding(.horizontal, 6).padding(.vertical, 2)
                        .background(Capsule().fill(t.accent.opacity(0.12)))
                        .overlay(Capsule().stroke(t.accent.opacity(0.35), lineWidth: 1))
                }

                Spacer()

                // Resolve status indicator
                if isResolving {
                    ProgressView()
                        .controlSize(.mini)
                        .scaleEffect(0.85)
                } else if p.resolvedId != nil {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.system(size: 13))
                        .foregroundStyle(t.accent3)
                        .help("Resolved — project ID \(p.resolvedId.map(String.init) ?? "—")")
                } else if resolveError != nil {
                    Image(systemName: "exclamationmark.circle")
                        .font(.system(size: 13))
                        .foregroundStyle(t.danger)
                        .help(resolveError ?? "Resolution failed")
                }

                // Delete — always cascades; the Library auto-mirrors this list.
                Button {
                    deleteProject(p)
                } label: {
                    Image(systemName: "trash")
                        .font(.system(size: 12))
                        .foregroundStyle(t.danger.opacity(0.7))
                }
                .buttonStyle(.plain)
            }

            // URL field — plain style, auto-resolves on Enter
            HStack(spacing: 6) {
                Image(systemName: "link")
                    .font(.system(size: 10))
                    .foregroundStyle(t.textMuted.opacity(0.6))
                TextField("https://gitlab.com/group/project", text: proj.url)
                    .textFieldStyle(.plain)
                    .font(Typography.mono)
                    .foregroundStyle(t.textMuted)
                    .disableAutocorrection(true)
                    .onSubmit {
                        resolveErrors.removeValue(forKey: p.id)
                        Task { await resolveProject(proj) }
                    }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(RoundedRectangle(cornerRadius: 6).fill(t.body.opacity(0.6)))
            .overlay(RoundedRectangle(cornerRadius: 6).stroke(t.border.opacity(0.4), lineWidth: 1))

            // Clone / Re-sync row
            cloneRow(proj: proj)
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 8)
            .fill(p.isActive ? t.accent.opacity(0.05) : t.surface2))
        .overlay(RoundedRectangle(cornerRadius: 8)
            .stroke(p.isActive ? t.accent.opacity(0.3) : t.border.opacity(0.4), lineWidth: 1.5))
        .onChange(of: proj.wrappedValue.url) { _, _ in
            if let idx = config.gitLabSavedProjects.firstIndex(where: { $0.id == p.id }) {
                config.gitLabSavedProjects[idx].resolvedId = nil
            }
            resolveErrors.removeValue(forKey: p.id)
        }
    }

    @ViewBuilder
    private func cloneRow(proj: Binding<SavedGitLabProject>) -> some View {
        let p = proj.wrappedValue
        let t = theme.current
        let isCloning = cloningIds.contains(p.id)
        let cloneError = cloneErrors[p.id]

        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Image(systemName: p.isCloned ? "checkmark.circle.fill" : "arrow.down.circle")
                    .font(.system(size: 11))
                    .foregroundStyle(p.isCloned ? t.accent3 : t.accent)

                if let path = p.localPath {
                    Text(URL(fileURLWithPath: path).lastPathComponent)
                        .font(Typography.mono)
                        .foregroundStyle(t.textMuted)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Spacer()
                    Button {
                        NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)])
                    } label: {
                        Image(systemName: "folder")
                            .font(.system(size: 11))
                            .foregroundStyle(t.textMuted)
                    }
                    .buttonStyle(.plain)
                    .help("Reveal in Finder")
                } else {
                    Text("Not cloned")
                        .font(Typography.caption)
                        .foregroundStyle(t.textMuted)
                    Spacer()
                }

                // Re-sync stays available even without Paths set —
                // the existing clone has its own localPath. Only a
                // *fresh* clone needs the Paths root.
                Button(isCloning ? (p.isCloned ? "Syncing…" : "Cloning…") : (p.isCloned ? "Re-sync" : "Clone")) {
                    Task { await cloneOrSync(proj) }
                }
                .buttonStyle(.bordered)
                .controlSize(.mini)
                .disabled(isCloning || p.url.isEmpty || config.gitLabToken.isEmpty || !config.isAllowed(.sync, provider: .gitlab))
                .help(config.gitLabToken.isEmpty
                      ? "Add and verify a GitLab access token first."
                      : (config.isAllowed(.sync, provider: .gitlab) ? "" : "Enable Pull / Re-sync in Automation & Actions above"))
            }

            if let err = cloneError {
                Text(err)
                    .font(Typography.caption)
                    .foregroundStyle(t.danger)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    // MARK: - Clone / Re-sync

    private func cloneOrSync(_ proj: Binding<SavedGitLabProject>) async {
        let p = proj.wrappedValue
        cloningIds.insert(p.id)
        cloneErrors.removeValue(forKey: p.id)
        defer { cloningIds.remove(p.id) }

        let token = config.gitLabToken
        let repoURL = p.url.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !repoURL.isEmpty, !token.isEmpty else { return }

        do {
            // Re-sync (pull) only when the saved clone still exists on disk.
            // A stale localPath (clone deleted, or layout changed) falls
            // through to a fresh clone into the active project's code/.
            if let existingPath = p.localPath,
               FileManager.default.fileExists(atPath: existingPath) {
                // Re-sync: git pull
                let localURL = URL(fileURLWithPath: existingPath)
                try await repoManager.pull(at: localURL, token: token)
            } else {
                // Fresh clone — refuses to proceed until the user has
                // configured Settings → Paths. We used to fall back to
                // `~/Developer/LLM IDE/`, but that quietly bypassed
                // the user's intent and made the "Move to Clones
                // folder" banner trip later. Production wants the
                // path setting to be authoritative; no fallback.
                // When a project is open, clone INTO its code/ folder so the
                // code is part of the project (and shows in its Explorer);
                // otherwise fall back to the global Clones/ dir.
                let baseDir = projectStore.activeProjectCodeDir ?? config.effectiveClonesURL
                // trimmingCharacters strips trailing "/" so .last
                // returns the repo name for URLs ending in `/`.
                let rawSlug = repoURL
                    .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
                    .components(separatedBy: "/")
                    .last?
                    .replacingOccurrences(of: ".git", with: "") ?? ""
                let slug = rawSlug.isEmpty ? "repo" : rawSlug
                try? FileManager.default.createDirectory(
                    at: baseDir, withIntermediateDirectories: true)
                let destURL = baseDir.appendingPathComponent(slug)
                let branch = try await repoManager.clone(remoteURL: repoURL, to: destURL, token: token)
                if let idx = config.gitLabSavedProjects.firstIndex(where: { $0.id == p.id }) {
                    config.gitLabSavedProjects[idx].localPath = destURL.path
                    config.gitLabSavedProjects[idx].defaultBranch = branch
                }
                // Index the cloned tree into the Library so it shows
                // up under CODE. Prune any prior entries with the
                // same folderOrigin first — otherwise an earlier
                // clone at a different path leaves stale items
                // mixed in with the new ones, and the Library tree
                // widens its commonAncestor up to ~/.
                library.removeFolder(folderOrigin: destURL.lastPathComponent)
                library.addFolder(url: destURL, category: .code)
            }
        } catch {
            cloneErrors[p.id] = error.localizedDescription
        }
    }

    // MARK: - Resolve project URL → numeric ID

    private func resolveProject(_ proj: Binding<SavedGitLabProject>) async {
        let p = proj.wrappedValue
        let raw = p.url.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !raw.isEmpty else { return }

        resolvingIds.insert(p.id)
        resolveErrors.removeValue(forKey: p.id)
        defer { resolvingIds.remove(p.id) }

        // Numeric project ID — use configured base
        if let numId = Int(raw) {
            let client = GitLabClient(config: config)
            do {
                let project = try await client.getProject(id: numId)
                applyResolved(project, to: p.id)
            } catch {
                resolveErrors[p.id] = error.localizedDescription
            }
            return
        }

        // Full URL — extract the GitLab host directly from the pasted URL
        var apiBase = config.gitLabBaseURL.trimmingCharacters(in: .whitespacesAndNewlines)
        var path = raw

        if raw.hasPrefix("http"), let parsedURL = URL(string: raw),
           let scheme = parsedURL.scheme, let host = parsedURL.host {
            apiBase = "\(scheme)://\(host)"
            // Also update the stored base URL to match the project's host
            config.gitLabBaseURL = apiBase
            path = parsedURL.path
        }

        path = path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard !path.isEmpty else { return }

        let encoded = path
            .components(separatedBy: "/")
            .map { $0.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? $0 }
            .joined(separator: "%2F")

        guard let url = URL(string: "\(apiBase)/api/v4/projects/\(encoded)") else {
            resolveErrors[p.id] = "Invalid URL"
            return
        }

        var req = URLRequest(url: url, timeoutInterval: 15)
        req.setValue(config.gitLabToken, forHTTPHeaderField: "PRIVATE-TOKEN")

        // Refuse to send the PAT to a non-https host (loopback is fine).
        guard GitLabClient.isSafeBaseURL(apiBase) else {
            resolveErrors[p.id] = "GitLab host must use https (or be loopback)."
            return
        }

        do {
            let (data, resp) = try await GitLabClient.session.data(for: req)
            guard let http = resp as? HTTPURLResponse else {
                resolveErrors[p.id] = "No response"
                return
            }
            guard http.statusCode == 200 else {
                let msg = (try? AppJSON.decoder.decode([String: String].self, from: data))?["message"]
                    ?? "HTTP \(http.statusCode)"
                resolveErrors[p.id] = msg
                return
            }
            let project = try AppJSON.decoder.decode(GitLabProject.self, from: data)
            applyResolved(project, to: p.id)
        } catch {
            resolveErrors[p.id] = error.localizedDescription
        }
    }

    private func applyResolved(_ project: GitLabProject, to id: String) {
        if let idx = config.gitLabSavedProjects.firstIndex(where: { $0.id == id }) {
            config.gitLabSavedProjects[idx].resolvedId = project.id
            if config.gitLabSavedProjects[idx].displayName.isEmpty {
                config.gitLabSavedProjects[idx].displayName = project.name
            }
        }
    }

    // MARK: - Save & verify token

    private func saveGitLab() async {
        let token = gitLabTokenDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !token.isEmpty else { return }

        // Derive base from project URLs or fall back to stored base
        let base = detectedBase

        gitLabBusy = true
        gitLabStatus = nil
        defer { gitLabBusy = false }

        // Don't send the PAT to anything other than https (loopback exempt).
        // Otherwise a typo'd or malicious base URL could leak the token over plaintext.
        guard GitLabClient.isSafeBaseURL(base) else {
            gitLabStatus = "Instance URL must use https (loopback http is allowed)."
            return
        }

        guard let url = URL(string: "\(base)/api/v4/user") else {
            gitLabStatus = "Invalid instance URL."
            return
        }

        var req = URLRequest(url: url, timeoutInterval: 10)
        req.setValue(token, forHTTPHeaderField: "PRIVATE-TOKEN")
        do {
            let (data, resp) = try await GitLabClient.session.data(for: req)
            guard let http = resp as? HTTPURLResponse else { gitLabStatus = "No response."; return }
            if http.statusCode == 200 {
                // GitLab's /user payload mixes types (id: number, bot: bool, …),
                // so decoding the whole object as [String: String] always fails
                // and the name fell through to "unknown". Read it untyped and
                // pull just the string fields we display.
                let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
                let name = (obj?["name"] as? String)
                    ?? (obj?["username"] as? String)
                    ?? "unknown"
                config.gitLabToken = token
                config.gitLabBaseURL = base
                gitLabStatus = "✓ Connected as \(name)"
            } else if http.statusCode == 401 {
                gitLabStatus = "Invalid token — check scope and expiry."
            } else {
                gitLabStatus = "HTTP \(http.statusCode) from GitLab."
            }
        } catch {
            gitLabStatus = "Connection failed: \(error.localizedDescription)"
        }
    }
}
