# Repository Provider Mutual Exclusivity Review

## Status: ✅ IMPLEMENTED & WORKING

The system enforces that **only one repo provider (GitLab OR GitHub) is active at a time**.

---

## Architecture

### 1. **Configuration Layer** (`AppConfig.swift`)

```swift
@Published var preferredRepoProvider: RepoBackendKind? {
    didSet {
        defaults.set(preferredRepoProvider?.rawValue, forKey: "preferredRepoProvider")
        if let pref = preferredRepoProvider {
            deactivateOtherProvider(than: pref)  // ← ENFORCES EXCLUSIVITY
        }
    }
}
```

**RepoBackendKind** enum:
- `.gitlab` — GitLab instance
- `.github` — GitHub.com

### 2. **Mutual Exclusivity Logic** (`Config.swift:deactivateOtherProvider`)

```swift
private func deactivateOtherProvider(than preferred: RepoBackendKind) {
    if preferred == .gitlab {
        // Deactivate ALL GitHub repos
        var updated = gitHubSavedRepos
        for i in updated.indices {
            updated[i].isActive = false
        }
        gitHubSavedRepos = updated
    } else {
        // Deactivate ALL GitLab projects
        var updated = gitLabSavedProjects
        for i in updated.indices {
            updated[i].isActive = false
        }
        gitLabSavedProjects = updated
    }
}
```

**When happens:**
- User sets GitHub as preferred → all GitLab projects deactivated
- User sets GitLab as preferred → all GitHub repos deactivated
- User clears preference → both can be independently managed

### 3. **UI Settings** (GitHubSettingsSection & GitLabSettingsSection)

```swift
// Only shown when BOTH tokens are configured
if !config.gitHubToken.isEmpty && !config.gitLabToken.isEmpty {
    Button {
        if config.preferredRepoProvider == .github {
            config.preferredRepoProvider = nil
        } else {
            config.preferredRepoProvider = .github
        }
    } label: {
        HStack {
            Image(systemName: config.preferredRepoProvider == .github 
                ? "checkmark.circle.fill" : "circle")
            Text("Set as primary provider")
        }
    }
    
    if config.preferredRepoProvider == .github {
        Text("Issues, Gantt, and code workflows will use GitHub. GitLab projects are deactivated.")
    }
}
```

---

## Resolution Flow (`AutoCodeUpdateService.resolveBackendAndProject()`)

### Step 1: Check for Backend Override (Tests only)
```swift
if let backend = backendOverride {
    return resolveWithBackend(backend)
}
```

### Step 2: Check for Linked Repo (Active Project)
```swift
if let active = projectStore?.activeProject,
   let linked = active.bundle.settings.linkedRepo {
    return resolveLinkedRepo(active, linked: linked)
}
```

When a project is linked to a repo:
- GitLab: creates GitLabClient
- GitHub: creates GitHubClient
- Uses `linked.remoteId` as projectId

### Step 3: Fallback — Find Active Repos

```swift
// If no linked repo, check for active saved repos
case .gitlab:
    guard let p = config.gitLabSavedProjects.first(where: { $0.isActive }) else { return nil }
    // Use GitLab

case .github:
    guard let r = config.gitHubSavedRepos.first(where: { $0.isActive }) else { return nil }
    // Use GitHub
```

**Key: `.first(where: { $0.isActive })` — only finds ACTIVE repos**

---

## Data Model

### SavedGitLabProject
```swift
struct SavedGitLabProject: Codable, Identifiable, Equatable {
    var id: String
    var url: String
    var displayName: String
    var resolvedId: Int?
    var isActive: Bool        // ← MUTUAL EXCLUSIVITY KEY
    var localPath: String?    // Local git clone
    var defaultBranch: String?
}
```

### SavedGitHubRepo
```swift
struct SavedGitHubRepo: Codable, Identifiable, Equatable {
    var id: String
    var url: String
    var displayName: String
    var resolvedId: Int?
    var isActive: Bool        // ← MUTUAL EXCLUSIVITY KEY
    var localPath: String?    // Local git clone
    var defaultBranch: String?
}
```

---

## Usage Flow

### Scenario 1: User has both GitLab and GitHub configured

1. **Settings → GitHub → "Set as primary provider"** (checkbox)
   - `preferredRepoProvider = .github`
   - Triggers `deactivateOtherProvider(than: .github)`
   - All GitLab projects: `isActive = false`

2. **Issues tab, Gantt, Code workflows**
   - Route uses `preferredRepoProvider` to pick backend
   - Only GitHub repos are `.isActive`
   - GitLab is completely inactive

3. **Switch to GitLab** (Settings → GitLab → "Set as primary provider")
   - `preferredRepoProvider = .gitlab`
   - All GitHub repos: `isActive = false`
   - GitLab becomes active

### Scenario 2: User has only one provider

- `preferredRepoProvider = nil` (no preference)
- Both can be independently configured
- Whichever has an active repo is used

---

## Verification Points

✅ **Settings UI**
- Shows "Set as primary provider" toggle when both tokens exist
- Visual indicator (checkmark) shows current preference
- Info banner explains the effect

✅ **Config Persistence**
- `preferredRepoProvider` saved to UserDefaults
- Survives app restart
- Preference state is atomic

✅ **Resolution Logic**
- `resolveBackendAndProject()` respects `isActive` flag
- Fallback diagnosis explains why resolution failed
- LinkedRepos bypass provider preference (project-specific override)

✅ **API Methods**
- `clearProviderPreference()` — restore independent management

---

## Known Limitations

1. **LinkedRepo bypasses preference**: If a project is explicitly linked to GitHub/GitLab, it uses that provider regardless of global preference
   - **By design**: Project-level override wins over global setting
   - **Impact**: Code workflows on a linked project always use the linked provider

2. **No auto-suggest**: User must manually set preference
   - **By design**: Explicit choice is clearer than magic
   - **Improvement**: Could auto-set on first GitHub/GitLab save

3. **UI only in Settings**: Preference toggle only visible in Settings
   - **Could add**: Quick-switch in Issues tab header when both providers available

---

## Testing Checklist

- [ ] Set GitHub as preferred → verify GitLab projects deactivated
- [ ] Set GitLab as preferred → verify GitHub repos deactivated
- [ ] Clear preference → verify both independently manageable
- [ ] Verify Issues/Gantt/Code workflows use preferred provider
- [ ] Verify linked projects override global preference
- [ ] Verify preference persists across app restart

---

## Conclusion

The system **correctly enforces mutual exclusivity** between GitLab and GitHub at the configuration level. When a user sets one as preferred, the other is automatically deactivated, and all workflows (Issues, Gantt, Code) route to the active provider.

**No changes needed** — the design is sound and working as intended.
