# Explorer, Search, Source Control and Terminal parity triage (verified)

Input: the 66 Mac labels from `Features/{Explorer,Search,SourceControl,Terminal}/` that `scripts/parity-inventory.mjs`
could not find in the desktop (`explorer.md`). This includes the GitHub/GitLab settings sections and the project memory
view, which live in those folders. A Haiku agent classified them first. An Opus pass then:

- traced every REAL_GAP to its Mac call chain,
- grepped the desktop for it, including the Rust host and its native dialogs,
- re-opened the desktop file:line cited by all 23 REWORDED claims,
- checked the MAC_ONLY and RUNTIME claims.

The per-label result is in the scratchpad file `triage/explorer-verified.json` (same schema, plus `verifiedBy` and
`changed`). Here `changed` means that `needs`, `effort` or `risky` was corrected. No label changed class.

## Counts

| Class | Haiku | Verified |
|---|---|---|
| REAL_GAP | 36 | 36 |
| REWORDED | 23 | 23 |
| MAC_ONLY | 3 | 3 |
| RUNTIME | 4 | 4 |
| DEAD_ON_MAC | 0 | 0 |
| Total | 66 | 66 |

No class was overturned. Unlike the Chat round, every Mac view here is reachable in the shipped app:

- `SourceControlView`: `AppShell.swift:732` -> `FeatureCatalog.sourceControlPane` (`FeatureCatalog.swift:202-204`).
- `SearchView`: `AppShell.swift:723` -> `FeatureCatalog.swift:194`.
- `RepoSettingsSection`, which embeds the GitHub and GitLab sections: registered at `FeatureCatalog.swift:165-168`.
- `ProjectMemoryView`: the chat composer's brain button (`ChatComposer.swift:430/450/481`) -> sheet
  (`CodeAssistantPanel.swift:255`) -> `ProjectMemoryRegistry` (`FeatureCatalog.swift:317-321`).

All of these sit under `FEATURE_EXPLORER`.

8 labels had their `needs`, `effort` or `risky` corrected:

- **Discard All** (3 labels): needs is now `rust`, not `ui`. The desktop `git_discard` resets to the staged version,
  keeps staged changes and caps at 200 paths (`git_scm.rs:32,293,331`). The Mac discards staged changes too.
  A UI-only button is possible but it would be a narrower "discard all unstaged + untracked".
- **Delete branch** (2 labels): effort is now S, not M. It is one `git branch -d` command plus a menu entry.
- **GitLab "Use <host>"** (2 labels): risky is now false. The button only fills the Instance URL field from a saved repo
  URL. No token is read or sent.
- **Dismiss** (1 label): effort S, not risky. The label has two sites. The Source Control error-banner Dismiss
  (`SourceControlView.swift:1218`) already exists on the desktop (`ui/screens/explorer/scm/ScmPanel.tsx:85-88`,
  `StatusBanner onDismiss`). Only the Search per-match Dismiss is missing.

## Features

| Feature | Class | Labels | Evidence | Missing | Needs | Effort | Risky | Safe now |
|---|---|---|---|---|---|---|---|---|
| Explorer move to trash | REWORDED | 1 | `ExplorerScreen.tsx:559-566` ConfirmDialog "Move to Trash" | - | | | | |
| Explorer file-op errors | REWORDED | 1 | `ExplorerScreen.tsx:420` StatusBanner fed by `controller.ts:830-841` describe() | - | | | | |
| Explorer empty editor | REWORDED | 1 | `EditorPane.tsx:185-189` "No file open" | - | | | | |
| Project memory viewer | REAL_GAP | 7 | No desktop caller of `/kb/agent/project-memory` or `/kb/agent/session-memory`. Desktop has only the "Memory N" count popover (`ChatScreen.tsx:283-291`) and the read-only file list in Settings > Memory | List of project facts and this chat's facts; per-fact Forget, Clear all, Forget this chat | ui (core routes exist: `extension/routes/agent.mjs:419,484,517,537`, repo-confined) | M | Forget/Clear delete memory data | Viewer yes; Forget/Clear HOLD |
| Search replace controls | REWORDED | 2 | `SearchPanel.tsx:177-178` per-file replace, `:213-240` Replace with + confirmed Replace all | - | | | | |
| Search glob placeholder | RUNTIME | 1 | Placeholder only; desktop `SearchPanel.tsx:260` | - | | | | |
| Search per-match Replace / Dismiss | REAL_GAP | 2 | `SearchView.swift:362-366` RowHoverActions; desktop has no per-match action or dismiss state | Dismiss a hit and exclude it from Replace All (the Mac's confirm says "except the N you dismissed"); replace a single match | ui | Dismiss S, Replace M | Replace writes a file | Dismiss yes; Replace HOLD-lite |
| Git host primary provider | REWORDED | 3 | `RepositoriesSection.tsx:255-267` | - | | | | |
| Git host access token | REWORDED | 4 | `RepositoriesSection.tsx:286-312` (write-only token to the vault, Save/Clear, Connected · host) | - | | | | |
| Git host saved repositories | REWORDED | 6 | `RepositoriesSection.tsx:335-381` (Add repository, empty state, Display name, Not cloned) | - | | | | |
| GitLab instance URL | REWORDED | 1 | `RepositoriesSection.tsx:272-285` | - | | | | |
| Git host provider switch | REWORDED | 1 | `RepositoriesSection.tsx:235-245` tablist | - | | | | |
| Git host placeholders | RUNTIME | 3 | Placeholders only; `RepositoriesSection.tsx:281,370` | - | | | | |
| Git host repo ID resolution | REAL_GAP | 2 | The Mac resolves the ID with provider HTTP from Swift (`GitHubSettingsSection.swift:450-460`). Core has no resolve route; the only related call is `POST /kb/connect-github-issues` (`router.mjs:547`), which the desktop already calls when a repo is added | Save & verify: resolved ID or the error | core (or Rust provider HTTP) | M | Uses the token | HOLD |
| GitLab "Use <host>" suggestion | REAL_GAP | 2 | `GitLabSettingsSection.swift:127-135`; desktop field has no suggestion | Button that fills the Instance URL from the saved project's host | ui | S | No | Yes |
| SCM discard prompt | REWORDED | 1 | Native `native_ask("Discard changes?")` (`git_scm.rs:797-798`) | - | | | | |
| SCM permanent delete after trash failure | MAC_ONLY | 3 | Desktop policy: `trash_guard.rs:1-5`, no permanent-delete fallback on any path | - (deliberate) | | | | |
| SCM create branch | REWORDED | 1 | `BranchesView.tsx:14-23` "Create and switch" | - | | | | |
| SCM branch delete | REAL_GAP | 2 | No delete command in `git_scm.rs`; no delete in `BranchesView` | Delete a non-current branch, fully merged only | rust | S | Deletes a ref | BUILT (2026-11-03): `git_branch_delete`, `-d` first; `-D` only after a second explicit step |
| SCM stash | REAL_GAP | 7 | No stash command (`git_scm.rs:20-21`) | Stash with optional message (untracked included), list, pop | rust | M | Rewrites the working tree | BUILT (2026-11-03): `git_stash_list/push/apply/pop/drop`, Branches tab |
| SCM discard all | REAL_GAP | 3 | Per-file discard only; `controller.discardSelected` (`controller.ts:264`) is never called | Discard All with confirmation and the merge-in-progress refusal | rust (exact parity) or ui (unstaged + untracked only) | S | Overwrites files | BUILT (2026-11-03): `git_discard_all(include_untracked)`, Trash only, Changes header |
| SCM tags | REAL_GAP | 6 | No tag command in `git_scm.rs` | Create a lightweight tag at HEAD; list tags newest first; overflow menu | rust | S | Create adds a ref; listing is read-only | BUILT (2026-11-03): listing + `git_tag_create` (lightweight, or annotated with a message) |
| SCM commit file list | REAL_GAP | 1 | `HistoryView.tsx:41-52` has no count and no empty text | "Files (N)" header and "No files in this commit" | ui | S | No | Yes |
| SCM publish branch | REAL_GAP | 1 | No push of any kind (`api.ts:3-5`) | Push -u origin with the stored token | rust | L | Push + credentials | HOLD |
| SCM merge branch | REAL_GAP | 2 | No merge command; the conflict grouping already exists (`model.ts:8`) | Merge another local branch into the current one | rust | M | Changes the tree | BUILT (2026-11-03): `git_merge` (ff default, `no_ff`), conflicts reported, `git_merge_abort` |
| SCM amend | REAL_GAP | 1 | `git_commit` only creates commits (`git_scm.rs:807`) | "Amend last commit" toggle | rust | M | Rewrites history | BUILT (2026-11-03): `git_commit_amend(message?, force)`, published commits need a second step |
| Terminal new tab | REWORDED | 1 | `TerminalDock.tsx:103` "New terminal" | - | | | | |

36 REAL_GAP labels collapse into 13 features.

## What the host exposes today

- `git.rs`: `git_status`, `git_diff`, `git_show`, `git_stage`.
- `git_scm.rs` (lines 766-855): `git_diff_hunks`, `git_stage_hunks`, `git_stage_all`, `git_discard` (with a native
  confirm), `git_identity`, `git_commit`, `git_branches`, `git_checkout`, `git_create_branch`, `git_log`,
  `git_commit_files`, `git_commit_diff`.
- Nothing for push, pull, fetch, remote, stash, amend, tag, merge or branch delete.

`api.ts:4-5` says stash and amend are missing because they need credentials. That is inaccurate: both are local. They
are still history- or tree-rewriting, so they stay HOLD.

## Reclassifications and corrections

| Row | Label(s) | Haiku | Verified | Reason |
|---|---|---|---|---|
| 48-50 | Discard All | REAL_GAP ui S | REAL_GAP rust S | `git_discard` keeps staged changes; Mac parity needs a new command |
| 42-43 | Delete branch | REAL_GAP rust M | REAL_GAP rust S | One `git branch -d` command plus a menu entry |
| 29-30 | Use <host> | REAL_GAP risky | REAL_GAP not risky | Fills a field only; no token is involved |
| 13 | Dismiss | REAL_GAP ui M risky | REAL_GAP ui S not risky | The SCM banner site is already covered (`ScmPanel.tsx:85-88`); only the Search site is missing |
| 3-9 | Project memory | needs ui | needs ui (confirmed) | Core routes exist; only the UI is missing |

## Labels the scanner did not list but that are real gaps

The Mac branch header also has Pull, Push, Sync (fetch) and Commit & Push (`SourceControlView.swift:849-866,1186-1197`).
They do not appear in the inventory, probably because the words matched desktop text elsewhere. The desktop has none of
them. They belong with Publish Branch in Batch C.

## Implementation batches

### Batch A: pure UI, safe now

1. SCM commit file list: "Files (N)" header and "No files in this commit" (`HistoryView.tsx`).
2. Search per-match Dismiss: hide a hit, exclude dismissed hits from Replace All, and update the confirm count.
3. GitLab "Use <host>" suggestion, when a saved repo's host differs from the Instance URL.

### Batch B: UI needing a small host or core change

1. Project memory viewer (read part): list project and session facts through the existing core routes, opened from
   the chat Memory chip. The Forget, Clear all and Forget-this-chat actions are HOLD until they have a confirmation
   dialog (the core already confines the repo through `resolveAllowedRepoRoot`).
2. SCM tag listing: read-only `git tag --sort=-creatordate` command plus a menu.
3. Search per-match Replace (HOLD-lite, because it writes a file). Safeguards: reuse the Replace All write path,
   re-check the file content before writing, and replace only the selected match.

### Batch C: Rust or core work, or a product decision (all HOLD)

| Item | Decision needed | Safeguards for a safe implementation |
|---|---|---|
| Discard All (BUILT) | Decided: exact parity (staged too, Rust). Untracked is a checkbox, ticked by default as on the Mac; the host dialog states the choice and the counts | Native confirm (Cancel default); refuse during merge, cherry-pick, revert or rebase; no `git clean`; untracked and staged-new files go to the Trash only (2,000 max per call); untracked files trashed one by one, never a folder (an untracked folder can hold ignored files or a nested repo at any depth; the Mac trashes the folder); symlinks and nested repos left in place; ignored files never touched (repo ignore rules only, the user's global excludes file is not read); plan and file fingerprints re-checked after the dialog; unstage then worktree restore as two calls (a single `--staged --worktree` call deleted a staged new file) |
| Branch delete (BUILT) | Decided: `-D` allowed after a second explicit in-page step and a native dialog naming the commits lost | `git branch -d` first; refuse the current branch and one checked out in another worktree; native confirm; validated branch name; force refused if the tip moved during the dialog |
| Stash / pop (BUILT) | Decided: Include untracked is on by default (a checkbox), as the Mac does | Native confirm on pop and drop; apply/pop refused while files are unmerged; pop conflicts left in git's state for the existing conflict flow; entries addressed by index + commit hash (a list that moved is refused) |
| Tag create (BUILT) | Decided: an optional message makes an annotated tag (needs the identity) | Validated name (`check-ref-format`); never moves a tag; signing off; never push tags |
| Merge into current (BUILT) | Decided: plain merge like the Mac (fast-forward when git can), `no_ff` available by the host's mode argument; the dialog says which one it will do | Refuse any uncommitted or untracked entry (the Mac does not; this is stricter on purpose); refuse operations in progress, detached HEAD, current branch; never `--force`; conflicts stay in git's state with Abort merge (native confirm) |
| Amend (BUILT) | Decided: the Mac's "Amend last commit" checkbox; a blank message keeps the old one; a published commit (reachable from a remote-tracking ref) needs a second in-page step and a second native dialog that says a force push will be needed | Refuse during merge or rebase; author kept, committer is the user; 64 KB message; identity required; no hooks, no signing; never offer push after an amend (Commit and Push is not in this build) |
| Publish / Push / Pull / Sync / Commit & Push | Who holds the git credential: the core vault through a short-lived handoff to Rust, or the system git credential helper? | Never `--force`; refuse a dirty tree for pull; never log credentials or put them in a URL or argv (use a credential helper or env passed only to the child process); explicit confirm on the first push of a branch |
| Repo ID resolution (Save & verify) | A core route that uses the vault token, or Rust provider HTTP | Token never sent back to the page; only the configured host is contacted; errors redacted |

## Not verified

- Nothing was run. This is a static read of the code. GUI behaviour of the Mac views (for example, the hover visibility
  of the per-match buttons) was not exercised.
- Whether `/kb/agent/project-memory` sits behind a feature gate that a desktop core build may disable was not checked.
