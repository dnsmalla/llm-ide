import SwiftUI
import GraphKit

/// Mirrors GitLabSettingsSection. Only the auth shape differs: GitHub
/// uses a Bearer-token PAT against api.github.com; no per-host base URL.
struct GitHubSettingsSection: View {
    @EnvironmentObject var theme: ThemeStore
    @EnvironmentObject var config: AppConfig
    @EnvironmentObject var projectStore: ProjectStore
    @Environment(LibraryItemStore.self) private var library

    @State private var tokenDraft: String = ""
    @State private var tokenVisible: Bool = false
    @State private var status: String?
    @State private var busy: Bool = false
    @State private var resolvingIds: Set<String> = []
    @State private var resolveErrors: [String: String] = [:]
    @State private var cloningIds: Set<String> = []
    @State private var cloneErrors: [String: String] = [:]
    private let repoManager = RepoManager()

    var body: some View {
        SettingsSectionCard(icon: "chevron.left.forwardslash.chevron.right", title: "GitHub") {
            VStack(alignment: .leading, spacing: Spacing.sm) {

                if config.resolvedClonesURL == nil {
                    pathsRequiredNotice
                }

                // Access Token
                HStack(spacing: Spacing.md) {
                    Text("Access Token")
                        .font(Typography.body)
                        .foregroundStyle(theme.current.textMuted)
                        .frame(width: 110, alignment: .leading)
                    ZStack(alignment: .trailing) {
                        if tokenVisible {
                            TextField("ghp_xxxxxxxxxxxxxxxxxxxx", text: $tokenDraft)
                                .textFieldStyle(.roundedBorder)
                                .font(Typography.mono)
                                .disableAutocorrection(true)
                        } else {
                            SecureField("ghp_xxxxxxxxxxxxxxxxxxxx", text: $tokenDraft)
                                .textFieldStyle(.roundedBorder)
                                .font(Typography.mono)
                        }
                        Button { tokenVisible.toggle() } label: {
                            Image(systemName: tokenVisible ? "eye.slash" : "eye")
                                .font(.system(size: 11))
                                .foregroundStyle(theme.current.textMuted)
                        }
                        .buttonStyle(.plain)
                        .padding(.trailing, 8)
                        .help(tokenVisible ? "Hide token" : "Show token")
                        .accessibilityLabel(tokenVisible ? "Hide token" : "Show token")
                    }
                }

                HStack {
                    Button(busy ? "Verifying…" : "Save & verify") {
                        Task { await saveAndVerify() }
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
                    .disabled(busy || tokenDraft.isEmpty)

                    if !config.gitHubToken.isEmpty {
                        Button("Clear") {
                            config.gitHubToken = ""
                            config.gitHubSavedRepos = []
                            tokenDraft = ""
                            status = "Cleared."
                        }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                        .foregroundStyle(theme.current.danger)
                    }

                    if let s = status {
                        Text(s)
                            .font(Typography.caption)
                            .foregroundStyle(s.hasPrefix("✓") ? theme.current.accent3 : theme.current.danger)
                    }
                }

                if !config.gitHubToken.isEmpty {
                    HStack(spacing: 4) {
                        Image(systemName: "checkmark.circle.fill")
                            .font(.system(size: 11))
                            .foregroundStyle(theme.current.accent3)
                        Text("Connected · github.com")
                            .font(Typography.caption)
                            .foregroundStyle(theme.current.textMuted)
                    }
                }

                Divider().padding(.vertical, 4)

                HStack {
                    SectionLabel("REPOSITORIES", size: 10, tracking: 1.2)
                    Spacer()
                    Button {
                        var r = SavedGitHubRepo()
                        if config.gitHubSavedRepos.isEmpty { r.isActive = true }
                        config.gitHubSavedRepos.append(r)
                    } label: {
                        HStack(spacing: 4) {
                            Image(systemName: "plus.circle.fill")
                                .font(.system(size: 11))
                            Text("Add repository")
                                .font(.system(size: 12, weight: .medium))
                        }
                        .foregroundStyle(theme.current.accent)
                    }
                    .buttonStyle(.plain)
                    .disabled(config.gitHubToken.isEmpty)
                }

                if config.gitHubSavedRepos.isEmpty {
                    Text("No repositories added yet.")
                        .font(Typography.caption)
                        .foregroundStyle(theme.current.textMuted)
                        .padding(.vertical, 4)
                } else {
                    VStack(spacing: 8) {
                        ForEach($config.gitHubSavedRepos) { $repo in
                            repoRow(repo: $repo)
                        }
                    }
                }
            }
        }
        .onAppear {
            tokenDraft = config.gitHubToken
        }
    }

    // MARK: - Row

    private func deleteRepo(_ r: SavedGitHubRepo) {
        let wasActive = r.isActive
        config.gitHubSavedRepos.removeAll { $0.id == r.id }
        if wasActive, let first = config.gitHubSavedRepos.first,
           let idx = config.gitHubSavedRepos.firstIndex(where: { $0.id == first.id }) {
            config.gitHubSavedRepos[idx].isActive = true
        }
    }

    @ViewBuilder
    private func repoRow(repo: Binding<SavedGitHubRepo>) -> some View {
        let r = repo.wrappedValue
        let t = theme.current
        let isResolving = resolvingIds.contains(r.id)
        let resolveError = resolveErrors[r.id]

        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                Button {
                    for i in config.gitHubSavedRepos.indices {
                        config.gitHubSavedRepos[i].isActive = (config.gitHubSavedRepos[i].id == r.id)
                    }
                } label: {
                    Image(systemName: r.isActive ? "largecircle.fill.circle" : "circle")
                        .font(.system(size: 16))
                        .foregroundStyle(r.isActive ? t.accent : t.border)
                }
                .buttonStyle(.plain)

                TextField("Display name", text: repo.displayName)
                    .textFieldStyle(.plain)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(t.text)

                if r.isActive {
                    Text("ACTIVE")
                        .font(.system(size: 9, weight: .bold))
                        .foregroundStyle(t.accent)
                        .padding(.horizontal, 6).padding(.vertical, 2)
                        .background(Capsule().fill(t.accent.opacity(0.12)))
                        .overlay(Capsule().stroke(t.accent.opacity(0.35), lineWidth: 1))
                }

                Spacer()

                if isResolving {
                    ProgressView().controlSize(.mini).scaleEffect(0.85)
                } else if r.resolvedId != nil {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.system(size: 13))
                        .foregroundStyle(t.accent3)
                        .help("Resolved — repo ID \(r.resolvedId.map(String.init) ?? "—")")
                } else if resolveError != nil {
                    Image(systemName: "exclamationmark.circle")
                        .font(.system(size: 13))
                        .foregroundStyle(t.danger)
                        .help(resolveError ?? "Resolution failed")
                }

                Button {
                    deleteRepo(r)
                } label: {
                    Image(systemName: "trash")
                        .font(.system(size: 12))
                        .foregroundStyle(t.danger.opacity(0.7))
                }
                .buttonStyle(.plain)
            }

            HStack(spacing: 6) {
                Image(systemName: "link")
                    .font(.system(size: 10))
                    .foregroundStyle(t.textMuted.opacity(0.6))
                TextField("https://github.com/owner/repo  or  owner/repo", text: repo.url)
                    .textFieldStyle(.plain)
                    .font(Typography.mono)
                    .foregroundStyle(t.textMuted)
                    .disableAutocorrection(true)
                    .onSubmit {
                        resolveErrors.removeValue(forKey: r.id)
                        Task { await resolveRepo(repo) }
                    }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(RoundedRectangle(cornerRadius: 6).fill(t.body.opacity(0.6)))
            .overlay(RoundedRectangle(cornerRadius: 6).stroke(t.border.opacity(0.4), lineWidth: 1))

            cloneRow(repo: repo)
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 8)
            .fill(r.isActive ? t.accent.opacity(0.05) : t.surface2))
        .overlay(RoundedRectangle(cornerRadius: 8)
            .stroke(r.isActive ? t.accent.opacity(0.3) : t.border.opacity(0.4), lineWidth: 1.5))
        .onChange(of: repo.wrappedValue.url) { _, _ in
            if let idx = config.gitHubSavedRepos.firstIndex(where: { $0.id == r.id }) {
                config.gitHubSavedRepos[idx].resolvedId = nil
            }
            resolveErrors.removeValue(forKey: r.id)
        }
    }

    @ViewBuilder
    private func cloneRow(repo: Binding<SavedGitHubRepo>) -> some View {
        let r = repo.wrappedValue
        let t = theme.current
        let isCloning = cloningIds.contains(r.id)
        let cloneError = cloneErrors[r.id]

        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Image(systemName: r.isCloned ? "checkmark.circle.fill" : "arrow.down.circle")
                    .font(.system(size: 11))
                    .foregroundStyle(r.isCloned ? t.accent3 : t.accent)

                if let path = r.localPath {
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
                    Text("Not cloned").font(Typography.caption).foregroundStyle(t.textMuted)
                    Spacer()
                }

                Button(isCloning
                       ? (r.isCloned ? "Syncing…" : "Cloning…")
                       : (r.isCloned ? "Re-sync"  : "Clone")) {
                    Task { await cloneOrSync(repo) }
                }
                .buttonStyle(.bordered)
                .controlSize(.mini)
                .disabled(isCloning || r.url.isEmpty || config.gitHubToken.isEmpty)
                .help(config.gitHubToken.isEmpty ? "Add and verify a GitHub access token first." : "")
            }

            // Migration affordance — when the saved clone lives
            // outside the Paths-configured Clones folder, surface a
            // "Move here" button. Re-sync alone runs `git pull` at
            // the old path; it never moves anything.
            if let suggestion = movableTo(r) {
                HStack(spacing: 6) {
                    Image(systemName: "arrow.right.arrow.left")
                        .font(.system(size: 10))
                        .foregroundStyle(t.accent2)
                    Text("Currently outside Clones — move to \(suggestion.path)?")
                        .font(Typography.caption)
                        .foregroundStyle(t.textMuted)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Spacer(minLength: 4)
                    Button("Move here") {
                        moveClone(repo: repo, to: suggestion)
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.mini)
                    .disabled(isCloning)
                }
            }

            if let err = cloneError {
                Text(err)
                    .font(Typography.caption)
                    .foregroundStyle(t.danger)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func movableTo(_ r: SavedGitHubRepo) -> URL? {
        guard let localPath = r.localPath,
              let baseDir = config.resolvedClonesURL else { return nil }
        let current = URL(fileURLWithPath: localPath).standardizedFileURL
        let suggested = baseDir
            .appendingPathComponent(current.lastPathComponent)
            .standardizedFileURL
        return current.path == suggested.path ? nil : suggested
    }

    private func moveClone(repo: Binding<SavedGitHubRepo>, to target: URL) {
        let r = repo.wrappedValue
        guard let oldPath = r.localPath else { return }
        let oldURL = URL(fileURLWithPath: oldPath)
        let fm = FileManager.default
        do {
            try fm.createDirectory(at: target.deletingLastPathComponent(),
                                   withIntermediateDirectories: true)
            if fm.fileExists(atPath: target.path) {
                cloneErrors[r.id] = "Target already exists: \(target.path)"
                return
            }
            try fm.moveItem(at: oldURL, to: target)
            repo.wrappedValue.localPath = target.path
            // Re-index — same hygiene as GitLab move.
            library.removeFolder(folderOrigin: target.lastPathComponent)
            library.addFolder(url: target, category: .code)
            // Drop the UA cache keyed at the old path so the
            // user doesn't see stale node fileURLs after the move.
            UAStore().invalidate(for: oldURL)
            cloneErrors[r.id] = nil
        } catch {
            cloneErrors[r.id] = "Move failed: \(error.localizedDescription)"
        }
    }

    /// Mirrors GitLabSettingsSection.pathsRequiredNotice — surfaces
    /// the Paths-root requirement at the top of GitHub settings so
    /// the user sees why Clone is disabled before clicking.
    @ViewBuilder
    private var pathsRequiredNotice: some View {
        let t = theme.current
        HStack(spacing: Spacing.sm) {
            Image(systemName: "exclamationmark.circle.fill")
                .foregroundStyle(t.accent4)
                .font(.system(size: 12))
            VStack(alignment: .leading, spacing: 1) {
                Text("No Paths root set — clones use a default location")
                    .font(Typography.captionStrong)
                    .foregroundStyle(t.text)
                Text("Clones land at ~/Documents/LLM IDE/Clones/<repo>. Set Settings → Paths → Root directory to choose your own.")
                    .font(Typography.caption)
                    .foregroundStyle(t.textMuted)
            }
            Spacer(minLength: 8)
            Button("Open Paths") {
                NotificationCenter.default.post(name: .openSettings, object: nil)
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
        }
        .padding(.horizontal, Spacing.sm)
        .padding(.vertical, 6)
        .background(t.accent4.opacity(0.10))
        .clipShape(RoundedRectangle(cornerRadius: 6))
    }

    // MARK: - Clone / Re-sync

    private func cloneOrSync(_ repo: Binding<SavedGitHubRepo>) async {
        let r = repo.wrappedValue
        cloningIds.insert(r.id)
        cloneErrors.removeValue(forKey: r.id)
        defer { cloningIds.remove(r.id) }

        let token = config.gitHubToken
        let raw = r.url.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !token.isEmpty else {
            cloneErrors[r.id] = "Add and verify a GitHub access token first."
            return
        }
        guard !raw.isEmpty, let (owner, name) = GitHubClient.ownerAndName(from: raw) else {
            cloneErrors[r.id] = "Couldn't parse owner/repo from URL."
            return
        }
        let httpsURL = "https://github.com/\(owner)/\(name).git"

        do {
            if let existingPath = r.localPath {
                let localURL = URL(fileURLWithPath: existingPath)
                try await repoManager.pull(at: localURL, token: token, backend: .github)
            } else {
                // Clones go to <root>/Clones when a Paths root is set, else a
                // sensible default — so cloning works even while a project is
                // active and the global root can't be edited.
                let baseDir = config.effectiveClonesURL
                try? FileManager.default.createDirectory(
                    at: baseDir, withIntermediateDirectories: true)
                let destURL = baseDir.appendingPathComponent(name)
                let branch = try await repoManager.clone(remoteURL: httpsURL, to: destURL, token: token, backend: .github)
                if let idx = config.gitHubSavedRepos.firstIndex(where: { $0.id == r.id }) {
                    config.gitHubSavedRepos[idx].localPath = destURL.path
                    config.gitHubSavedRepos[idx].defaultBranch = branch
                }
                // A bare git clone has no `system/`, `source/`, `notes/`
                // or `code/` — so "Open Folder" would reject it as "not a
                // LLM IDE project". Adopt the freshly-cloned repo as a
                // project: write project.json + scaffold the tree (the repo's
                // own README is preserved). Non-fatal — the clone itself
                // already succeeded.
                do {
                    try projectStore.ensureProjectScaffold(at: destURL)
                } catch {
                    cloneErrors[r.id] = "Cloned, but couldn't initialize LLM IDE project: \(error.localizedDescription)"
                }
                // Prune stale entries (older clone at a different
                // path) before re-indexing — same hygiene as GitLab.
                library.removeFolder(folderOrigin: destURL.lastPathComponent)
                library.addFolder(url: destURL, category: .code)
            }
        } catch {
            cloneErrors[r.id] = error.localizedDescription
        }
    }

    // MARK: - Resolve repo URL → numeric ID

    private func resolveRepo(_ repo: Binding<SavedGitHubRepo>) async {
        let r = repo.wrappedValue
        let raw = r.url.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !raw.isEmpty else { return }
        resolvingIds.insert(r.id)
        resolveErrors.removeValue(forKey: r.id)
        defer { resolvingIds.remove(r.id) }

        let client = GitHubClient(config: config)
        do {
            let repoResult = try await client.resolveRepo(rawURL: raw)
            if let idx = config.gitHubSavedRepos.firstIndex(where: { $0.id == r.id }) {
                config.gitHubSavedRepos[idx].resolvedId = repoResult.id
                if config.gitHubSavedRepos[idx].displayName.isEmpty {
                    config.gitHubSavedRepos[idx].displayName = repoResult.name
                }
            }
        } catch {
            resolveErrors[r.id] = error.localizedDescription
        }
    }

    // MARK: - Save & verify token

    private func saveAndVerify() async {
        let token = tokenDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !token.isEmpty else { return }
        busy = true; status = nil
        defer { busy = false }

        do {
            // Probe with the static helper so an invalid token never
            // touches the Keychain (the previous version wrote it
            // before verifying, polluting Keychain on 401/network
            // failure). Matches GitLabSettingsSection's behavior.
            let user = try await GitHubClient.verifyToken(token)
            config.gitHubToken = token   // commit only on success
            status = "✓ Connected as \(user.name ?? user.login)"
        } catch let e as GitHubClient.GitHubError {
            switch e {
            case .httpError(401, _): status = "Invalid token — check scope and expiry."
            default:                 status = e.localizedDescription
            }
        } catch {
            status = "Connection failed: \(error.localizedDescription)"
        }
    }
}
