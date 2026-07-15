# Configure GitHub & GitLab

LLM IDE supports both GitHub and GitLab, but enforces **mutual exclusivity**: only one provider can be active at a time across all features (Issues, Gantt, Auto Tasks, Code Workflows).

This guide explains how to choose a provider, configure credentials, and switch between them.

## Quick Start

### For GitHub Users

1. **Settings → GitHub**
2. Enter organization/project name (e.g., `acme/web-app`)
3. Paste your GitHub Personal Access Token (PAT)
4. Enter the local clone path
5. Click **Verify & Save**
6. GitHub automatically becomes your primary provider; GitLab deactivates

### For GitLab Users

1. **Settings → GitLab**
2. Enter group/project path (e.g., `mygroup/subgroup/project`)
3. Paste your GitLab Personal Access Token
4. Enter the local clone path
5. Click **Verify & Save**
6. GitLab automatically becomes your primary provider; GitHub deactivates

## Understanding Provider Exclusivity

Why only one provider? Because:

- **Unified workflow** — Issues, Gantt, and Auto Tasks all talk to one repo backend
- **Reduced complexity** — No ambiguity about which provider to create issues in
- **Clear permissions** — Only one set of credentials needs auditing
- **Consistent state** — Plan tasks dispatch to one place, avoiding duplicates

### What This Means

| Scenario | Behavior |
|----------|----------|
| GitHub configured, GitLab enabled | GitHub deactivates automatically |
| Both configured, switching to GitLab | GitHub repos/projects hide; GitLab shows |
| Auto Tasks running on GitHub | Can't add GitLab during a run |
| Gantt view active | Uses active provider (GitHub/GitLab) |

**No data is deleted** — configurations persist; they're just hidden.

## GitHub Setup

### Get Your Token

#### Step 1: Create a Personal Access Token

1. Go to [github.com/settings/tokens](https://github.com/settings/tokens)
2. Click **Generate new token → Generate new token (classic)**
3. Name it: "LLM IDE"
4. Set expiration: 90 days (rotate before expiry)

#### Step 2: Select Required Scopes

LLM IDE needs these permissions:

- **`repo`** — Full control of private repositories
  - Needed for: read/write issues, comments, creating branches
- **`workflow`** — Read/write GitHub Actions workflows
  - Needed for: triggering CI/CD on auto-task fixes (optional)

Recommended scopes for most users:
```
✓ repo (includes: repo:status, repo_deployment, public_repo)
✓ workflow
```

#### Step 3: Copy & Store

1. Click **Generate token**
2. **Copy immediately** — GitHub won't show it again
3. Paste into LLM IDE **Settings → GitHub → API Token**
4. Click **Verify & Save**

### Verify Your Configuration

After saving, LLM IDE will:
1. Check token validity
2. Fetch your available repositories
3. Verify the local clone path exists
4. Show success/error message

**If verification fails:**

| Error | Fix |
|-------|-----|
| "Invalid token" | Check token is copied correctly; regenerate if expired |
| "Repo not found" | Verify org/project name (case-sensitive); ensure token has `repo` scope |
| "Clone path doesn't exist" | Ensure the local directory exists and is readable |
| "Permission denied" | Check token has required scopes; ensure you have access to the repo |

### GitHub Integration Points

Once configured, GitHub enables:

#### Issues View
- List all open/closed issues in your repo
- Filter by assignee, label, milestone
- Create new issues from meeting action items
- Update issue status during Auto Tasks runs

#### Code Workflows
- Create feature branches
- Commit code changes
- Open pull requests
- Request reviews

#### Auto Tasks
- Review code on PRs
- Comment with findings
- Update issue status
- Trigger workflows (if `workflow` scope enabled)

#### Gantt View
- **Not supported on GitHub** — Gantt is GitLab-only (for now)
- If GitHub is active, Gantt shows: "You have GitHub configured, but Gantt currently only supports GitLab projects for timeline planning"

### Rotate Your Token

GitHub recommends rotating tokens every 90 days:

1. Go to [github.com/settings/tokens](https://github.com/settings/tokens)
2. Find your "LLM IDE" token
3. Click **Regenerate token**
4. Copy the new token
5. Update LLM IDE **Settings → GitHub → API Token**
6. Click **Verify & Save**
7. Return to GitHub and delete the old token

## GitLab Setup

### Get Your Token

#### Step 1: Create a Personal Access Token

1. Go to [gitlab.com/-/user_settings/personal_access_tokens](https://gitlab.com/-/user_settings/personal_access_tokens)
2. Click **Add new token**
3. Name: "LLM IDE"
4. Expiration: 90 days (rotate before expiry)
5. Select scopes (see next step)

#### Step 2: Select Required Scopes

LLM IDE needs these permissions:

- **`api`** — Full API access
  - Needed for: read/write issues, merge requests, pipelines
- **`read_repository`** — Read repository files
  - Needed for: clone operations, file access

Recommended scopes:
```
✓ api
✓ read_repository
```

**Optional for advanced features:**
- `write_repository` — Create branches, commits, MRs (for Code Workflows)

#### Step 3: Copy & Store

1. Click **Create personal access token**
2. **Copy immediately** — GitLab won't show it again
3. Paste into LLM IDE **Settings → GitLab → API Token**
4. Click **Verify & Save**

### Verify Your Configuration

After saving, LLM IDE will:
1. Check token validity
2. Fetch your available projects
3. Verify the local clone path
4. Show success/error message

**If verification fails:**

| Error | Fix |
|-------|-----|
| "Invalid token" | Regenerate token; copy carefully |
| "Project not found" | Use full path: `group/subgroup/project` (not just project name) |
| "Clone path doesn't exist" | Create the directory and ensure it's readable |
| "Access denied" | Ensure you're a member of the project; token has `api` scope |

### GitLab Integration Points

Once configured, GitLab enables:

#### Issues View
- List all open/closed issues in your project
- Filter by assignee, labels, milestones
- Create new issues from meeting action items
- Update issue status and assignee

#### Merge Requests
- View open/closed MRs
- Add review comments
- Approve/request changes
- Trigger pipelines

#### Auto Tasks
- Review code on MRs
- Comment with findings
- Create/update issues
- Auto-create branches for fixes

#### Gantt View
- **Gantt is GitLab-only**
- Shows project timeline with milestones
- Drag-drop to reschedule tasks
- Gantt requires GitLab to be the active provider

### Rotate Your Token

GitLab recommends rotating tokens every 90 days:

1. Go to [gitlab.com/-/user_settings/personal_access_tokens](https://gitlab.com/-/user_settings/personal_access_tokens)
2. Find your "LLM IDE" token
3. Click the **Revoke** button
4. Create a new token (repeat Step 1–3 above)
5. Update LLM IDE **Settings → GitLab → API Token**
6. Click **Verify & Save**

## Switching Providers

### GitHub → GitLab

1. **Settings → GitLab**
2. Enter GitLab credentials and verify
3. Once saved, GitHub automatically deactivates
4. **Issues view** switches to GitLab
5. **Gantt view** now works (was disabled on GitHub)
6. **Auto Tasks** run against GitLab going forward

**Your GitHub credentials are preserved** — you can switch back anytime.

### GitLab → GitHub

1. **Settings → GitHub**
2. Enter GitHub credentials and verify
3. Once saved, GitLab automatically deactivates
4. **Issues view** switches to GitHub
5. **Gantt view** disables (GitHub doesn't support it yet)
6. **Auto Tasks** run against GitHub going forward

**Your GitLab credentials are preserved** — you can switch back anytime.

### Mid-Auto-Tasks Switch

If you switch providers while Auto Tasks are running:

1. The current run completes against the old provider
2. Logs are written to the old provider's log file
3. When the timer fires next, it uses the new provider
4. **No data loss** — all findings are preserved in logs

## Self-Hosted Instances

If you use **self-hosted GitHub Enterprise** or **self-hosted GitLab**:

### GitHub Enterprise

1. **Settings → GitHub**
2. You may see an option: "GitHub Server URL" or "Custom Endpoint"
3. Enter your instance URL: `https://github.yourdomain.com`
4. Proceed normally with token and project setup

### Self-Hosted GitLab

1. **Settings → GitLab**
2. You may see an option: "GitLab Instance URL" or "Custom Endpoint"
3. Enter your instance URL: `https://gitlab.yourdomain.com`
4. Proceed normally with token and project setup

If you don't see these fields, contact support — your instance may need special configuration.

## Troubleshooting

### "Token invalid or expired"

**Cause:** Your credentials are no longer valid.

**Fix:**
1. Generate a new token on GitHub/GitLab
2. Ensure it hasn't expired
3. Verify required scopes are selected
4. Paste the new token into LLM IDE
5. Click **Verify & Save**

### "Repository not found"

**Cause:** LLM IDE can't access the repo with your token.

**Fixes:**
- **Check the project path:**
  - GitHub: `owner/repo` (e.g., `microsoft/vscode`)
  - GitLab: `group/subgroup/project` (e.g., `gitlab-org/gitaly`)
- **Verify token has `repo` (GitHub) or `api` (GitLab) scope**
- **Check you're a member of the project** (not just a viewer)
- **If private repo:** token must have full `repo` scope (not `public_repo`)

### "Clone path doesn't exist"

**Cause:** The local directory where the repo is cloned isn't accessible.

**Fix:**
1. Verify the path exists: `ls /path/to/repo`
2. Ensure it's readable: `ls -la /path/to/repo`
3. If it doesn't exist, clone it first:
   ```bash
   # GitHub
   git clone https://github.com/owner/repo /path/to/repo
   
   # GitLab
   git clone https://gitlab.com/group/project /path/to/repo
   ```
4. Update LLM IDE with the correct path
5. Click **Verify & Save**

### "Can't switch providers"

**Cause:** Might be a transient issue or state corruption.

**Fix:**
1. Close and reopen LLM IDE
2. Try switching again
3. If still stuck, clear provider settings and reconfigure
4. Contact support if the issue persists

### "Gantt view disabled"

**Cause:** GitHub is your active provider (Gantt only supports GitLab).

**Fix:**
1. Switch to GitLab: **Settings → GitLab**
2. Verify and save your GitLab credentials
3. Gantt view will appear and work

## Security Best Practices

### ✓ Do This

- **Rotate tokens every 90 days** — Use expiration dates to force rotation
- **Use fine-grained tokens** (GitHub) — Grant only needed permissions
- **Revoke old tokens immediately** — Don't leave stale tokens active
- **Use strong, unique tokens** — Don't reuse across tools
- **Store tokens securely** — LLM IDE keeps them in macOS Keychain
- **Monitor token usage** — Check GitHub/GitLab logs for suspicious access

### ✗ Don't Do This

- **Don't share your token** — Tokens are credentials; treat like passwords
- **Don't commit tokens to git** — Set `git config core.hooksPath` to prevent accidental commits
- **Don't use an organization token** — Use personal tokens; easier to rotate
- **Don't grant unnecessary scopes** — Follow principle of least privilege
- **Don't leave expired tokens lying around** — Clean up old tokens regularly

## Integration with Issues & Gantt

### Issues View with Active Provider

**GitHub:**
- Shows all repositories you have access to
- Can filter by owner, stars, language
- Create/update issues in real-time
- Comments visible in-app

**GitLab:**
- Shows all projects you're a member of
- Can filter by visibility, language, topic
- Create/update issues and MRs
- Comments visible in-app

### Gantt View (GitLab Only)

**Requirement:** GitLab must be the active provider.

**Gantt features:**
- Timeline view of milestones
- Drag-to-reschedule tasks
- Progress bars for each milestone
- Critical path analysis

If you see "Gantt currently only supports GitLab", switch your active provider to GitLab.

## Next Steps

- [Configure Auto Tasks](./configure-auto-tasks.md) — Set up automated code reviews and testing
- [Create a Plan](../tutorials/02-generate-a-plan.md) — Use your repo for AI-assisted planning
- [Reference: Error Codes](../reference/error-codes.md) — Troubleshoot specific errors
