## explorer: 35/107 Swift labels exact in desktop code (33%), 6 only inside a longer sentence, 66 missing

Swift files scanned: 24. Shortcuts in Swift (not machine-matched): 2.

| kind | total | missing |
|---|---|---|
| accessibilityLabel | 2 | 0 |
| alert | 4 | 3 |
| button | 29 | 10 |
| confirmationDialog | 4 | 4 |
| help | 22 | 11 |
| menu | 2 | 2 |
| picker | 1 | 1 |
| text | 30 | 26 |
| textfield | 12 | 8 |
| toggle | 1 | 1 |

### Missing

- [alert] "Couldn’t complete the operation" - mac/Sources/LlmIdeMac/Features/Explorer/Views/ExplorerView.swift:332
- [text] "You can undo this in Finder." - mac/Sources/LlmIdeMac/Features/Explorer/Views/ExplorerView.swift:330
- [text] "Select a file to view" - mac/Sources/LlmIdeMac/Features/Explorer/Views/ExplorerView.swift:492
- [help] "Forget everything this chat's memory holds" - mac/Sources/LlmIdeMac/Features/Explorer/Views/ProjectMemoryView.swift:160
- [help] "Forget this" - mac/Sources/LlmIdeMac/Features/Explorer/Views/ProjectMemoryView.swift:252
- [text] "Memory" - mac/Sources/LlmIdeMac/Features/Explorer/Views/ProjectMemoryView.swift:107
- [text] "What the assistant has learned about this project — and in this chat" - mac/Sources/LlmIdeMac/Features/Explorer/Views/ProjectMemoryView.swift:110
- [text] "Clear all" - mac/Sources/LlmIdeMac/Features/Explorer/Views/ProjectMemoryView.swift:117
- [text] "Forget" - mac/Sources/LlmIdeMac/Features/Explorer/Views/ProjectMemoryView.swift:155
- [text] "Learned" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Explorer/Views/ProjectMemoryView.swift:239
- [textfield] "Replace" - mac/Sources/LlmIdeMac/Features/Search/Views/SearchView.swift:226
- [textfield] "e.g. app/job/**, *.swift" - mac/Sources/LlmIdeMac/Features/Search/Views/SearchView.swift:266
- [help] "Replace" - mac/Sources/LlmIdeMac/Features/Search/Views/SearchView.swift:636
- [help] "Dismiss" - mac/Sources/LlmIdeMac/Features/Search/Views/SearchView.swift:644 (+1)
- [help] "Replace all in file" - mac/Sources/LlmIdeMac/Features/Search/Views/SearchView.swift:685
- [button] "Clear token" - mac/Sources/LlmIdeMac/Features/SourceControl/Views/GitHubSettingsSection.swift:141 (+1)
- [textfield] "Display name" - mac/Sources/LlmIdeMac/Features/SourceControl/Views/GitHubSettingsSection.swift:253 (+1)
- [textfield] "https://github.com/owner/repo  or  owner/repo" - mac/Sources/LlmIdeMac/Features/SourceControl/Views/GitHubSettingsSection.swift:297
- [help] "Resolved — repo ID" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/SourceControl/Views/GitHubSettingsSection.swift:275
- [text] "Set as primary provider" - mac/Sources/LlmIdeMac/Features/SourceControl/Views/GitHubSettingsSection.swift:64 (+1)
- [text] "Issues, Gantt, and code workflows will use GitHub as the primary provider. GitLab projects are deactivated." - mac/Sources/LlmIdeMac/Features/SourceControl/Views/GitHubSettingsSection.swift:77
- [text] "Access Token" - mac/Sources/LlmIdeMac/Features/SourceControl/Views/GitHubSettingsSection.swift:96 (+1)
- [text] "Connected · github.com" - mac/Sources/LlmIdeMac/Features/SourceControl/Views/GitHubSettingsSection.swift:165
- [text] "Add repository" - mac/Sources/LlmIdeMac/Features/SourceControl/Views/GitHubSettingsSection.swift:188
- [text] "No repositories added yet." - mac/Sources/LlmIdeMac/Features/SourceControl/Views/GitHubSettingsSection.swift:198
- [text] "Not cloned" - mac/Sources/LlmIdeMac/Features/SourceControl/Views/GitHubSettingsSection.swift:357 (+1)
- [button] "Use" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/SourceControl/Views/GitLabSettingsSection.swift:130
- [textfield] "https://gitlab.com" - mac/Sources/LlmIdeMac/Features/SourceControl/Views/GitLabSettingsSection.swift:124
- [textfield] "https://gitlab.com/group/project" - mac/Sources/LlmIdeMac/Features/SourceControl/Views/GitLabSettingsSection.swift:352
- [help] "Your saved project is on this host. Your token is only sent to the Instance URL." - mac/Sources/LlmIdeMac/Features/SourceControl/Views/GitLabSettingsSection.swift:135
- [help] "Resolved — project ID" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/SourceControl/Views/GitLabSettingsSection.swift:328
- [text] "Issues, Gantt, and code workflows will use GitLab as the primary provider. GitHub repositories are deactivated." - mac/Sources/LlmIdeMac/Features/SourceControl/Views/GitLabSettingsSection.swift:101
- [text] "Instance URL" - mac/Sources/LlmIdeMac/Features/SourceControl/Views/GitLabSettingsSection.swift:120
- [text] "Connected ·" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/SourceControl/Views/GitLabSettingsSection.swift:208
- [text] "Add project" - mac/Sources/LlmIdeMac/Features/SourceControl/Views/GitLabSettingsSection.swift:232
- [text] "No projects added yet." - mac/Sources/LlmIdeMac/Features/SourceControl/Views/GitLabSettingsSection.swift:242
- [picker] "Provider" - mac/Sources/LlmIdeMac/Features/SourceControl/Views/RepoSettingsSection.swift:26
- [button] "permanently" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/SourceControl/Views/SourceControlView.swift:627
- [button] "Stash" - mac/Sources/LlmIdeMac/Features/SourceControl/Views/SourceControlView.swift:656
- [button] "Discard All Changes" - mac/Sources/LlmIdeMac/Features/SourceControl/Views/SourceControlView.swift:665 (+1)
- [button] "Create Tag…" - mac/Sources/LlmIdeMac/Features/SourceControl/Views/SourceControlView.swift:822
- [button] "Publish Branch" - mac/Sources/LlmIdeMac/Features/SourceControl/Views/SourceControlView.swift:897
- [button] "Merge “" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/SourceControl/Views/SourceControlView.swift:909
- [button] "Stash Changes…" - mac/Sources/LlmIdeMac/Features/SourceControl/Views/SourceControlView.swift:939
- [button] "Pop:" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/SourceControl/Views/SourceControlView.swift:946
- [toggle] "Amend last commit" - mac/Sources/LlmIdeMac/Features/SourceControl/Views/SourceControlView.swift:1169
- [menu] "Tags" - mac/Sources/LlmIdeMac/Features/SourceControl/Views/SourceControlView.swift:824
- [menu] "Merge into current" - mac/Sources/LlmIdeMac/Features/SourceControl/Views/SourceControlView.swift:907
- [textfield] "Message (optional)" - mac/Sources/LlmIdeMac/Features/SourceControl/Views/SourceControlView.swift:654
- [textfield] "Tag name" - mac/Sources/LlmIdeMac/Features/SourceControl/Views/SourceControlView.swift:672
- [help] "More actions (tags, discard all)" - mac/Sources/LlmIdeMac/Features/SourceControl/Views/SourceControlView.swift:837
- [help] "Stash" - mac/Sources/LlmIdeMac/Features/SourceControl/Views/SourceControlView.swift:958
- [alert] "Stash changes" - mac/Sources/LlmIdeMac/Features/SourceControl/Views/SourceControlView.swift:653
- [alert] "New tag" - mac/Sources/LlmIdeMac/Features/SourceControl/Views/SourceControlView.swift:671
- [confirmationDialog] "Discard changes?" - mac/Sources/LlmIdeMac/Features/SourceControl/Views/SourceControlView.swift:612
- [confirmationDialog] "Couldn't move to the Trash" - mac/Sources/LlmIdeMac/Features/SourceControl/Views/SourceControlView.swift:623
- [confirmationDialog] "Delete branch?" - mac/Sources/LlmIdeMac/Features/SourceControl/Views/SourceControlView.swift:644
- [confirmationDialog] "Discard all changes?" - mac/Sources/LlmIdeMac/Features/SourceControl/Views/SourceControlView.swift:664
- [text] "” could not be moved to the Trash. Deleting it permanently cannot be undone." (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/SourceControl/Views/SourceControlView.swift:631
- [text] "Create a new branch from the current HEAD and switch to it." - mac/Sources/LlmIdeMac/Features/SourceControl/Views/SourceControlView.swift:642
- [text] "” will be deleted (only if fully merged)." (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/SourceControl/Views/SourceControlView.swift:651
- [text] "Stash all working-tree changes (including untracked files)." - mac/Sources/LlmIdeMac/Features/SourceControl/Views/SourceControlView.swift:662
- [text] "This discards all uncommitted changes, staged and unstaged. Untracked files are moved to the Trash." - mac/Sources/LlmIdeMac/Features/SourceControl/Views/SourceControlView.swift:669
- [text] "Create a lightweight tag at the current HEAD." - mac/Sources/LlmIdeMac/Features/SourceControl/Views/SourceControlView.swift:680
- [text] "No files in this commit" - mac/Sources/LlmIdeMac/Features/SourceControl/Views/SourceControlView.swift:771
- [help] "New Terminal Tab" - mac/Sources/LlmIdeMac/Features/Terminal/Views/TerminalTabBar.swift:35
