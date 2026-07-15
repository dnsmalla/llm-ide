# Configure Auto Tasks

Auto Tasks is a powerful automation feature that automatically runs code reviews, regression testing, documentation generation, and other quality checks on your repositories. This guide explains how to set up and customize auto tasks for your workflow.

## Overview

Auto Tasks enable the LLM IDE to:
- **Review code** — Analyze commits for quality and best practices
- **Review documentation** — Check doc completeness and consistency  
- **Review conflicts** — Detect merge conflicts and issues
- **Run regression tests** — Verify that fixes don't break existing functionality
- **Generate knowledge** — Extract insights from your codebase graph
- **Update issues** — Sync task status with external trackers (GitHub, GitLab, Linear, Backlog)
- **Generate documentation** — Create and maintain code docs

## Prerequisites

Before enabling Auto Tasks, ensure:
1. **A linked repository** — GitHub or GitLab project with a local clone
2. **Repository credentials** — Valid API token for your provider (GitHub PAT or GitLab token)
3. **Meeting data** — At least one captured meeting with action items (for lookback scanning)

## Initial Setup

### Step 1: Configure Your Repository Provider

Auto Tasks require one active repository provider. Choose between **GitHub** or **GitLab** (mutual exclusivity enforced).

**Via macOS App:**

1. Open **LLM IDE → Settings** → scroll to "GitHub" or "GitLab" section
2. Enter your:
   - **Organization/Project name** (e.g., `myorg/my-project`)
   - **API Token** (GitHub PAT or GitLab token — kept secure in Keychain)
   - **Local clone path** (where the repo is cloned locally)
3. Click **Verify & Save**

Once saved, the other provider automatically deactivates. Only one provider can be active at a time.

#### GitHub Setup

- **Token type:** Personal Access Token (PAT)
- **Required scopes:**
  - `repo` — Read/write repository access
  - `workflow` — GitHub Actions access (if using regressions)
- **Expiry:** Set an expiration date and rotate before it expires

**Get your GitHub token:**
1. Go to [github.com/settings/tokens](https://github.com/settings/tokens)
2. Click **Generate new token (classic)**
3. Select scopes: `repo`, `workflow`
4. Copy token and paste into LLM IDE Settings

#### GitLab Setup

- **Token type:** Personal Access Token (PAT) or Project Access Token
- **Required scopes:**
  - `api` — Full API access
  - `read_repository` — Repository read access
- **Expiry:** Set an expiration date and rotate before it expires

**Get your GitLab token:**
1. Go to [gitlab.com/-/user_settings/personal_access_tokens](https://gitlab.com/-/user_settings/personal_access_tokens)
2. Click **Add new token**
3. Select scopes: `api`, `read_repository`
4. Copy token and paste into LLM IDE Settings

### Step 2: Enable Auto Tasks

In **Settings → Auto Tasks**:

1. Toggle **Enabled** to turn on the feature
2. Configure the **Lookback window** (default: last 5 meetings)
   - Choose between **by count** (last N meetings) or **by age** (last N days)
   - Adjust slider: min 1, max 20 meetings or 1-30 days
3. Set the **Run interval** (default: every 60 minutes)
   - How often Auto Tasks checks for new meeting actions
   - Minimum: 5 minutes, Maximum: 24 hours
   - Only runs while the app is open

4. Toggle **Auto-stash uncommitted changes** (optional)
   - When ON: stashes your work before running, restores after
   - When OFF: skips if working tree is dirty (default, safer)

### Step 3: Select Which Tasks to Run

In **Settings → Auto Tasks → Run automatically**, enable the tasks you want:

- **✓ Review Code** — Analyzes diffs for quality issues
- **✓ Review Doc** — Checks documentation consistency
- **Review Conflicts** — Detects merge conflicts (optional)
- **Regression** — Re-runs tests on flagged commits
- **Generate Knowledge** — Updates the code graph
- **✓ Generate Doc** — Auto-generates missing docs
- **Update Issues** — Syncs with external trackers (optional)
- **Update Plan Status** — Polls plan outcome status (optional)

**Regression-specific options** (if enabled):
- **Attempt repair on regression** — Try to auto-fix broken tests
- **Auto-reopen regressed faults** — Flag issues that re-broke
- **Verify timeout (seconds)** — Max time per test verification (default 120s)

## Understanding Lookback Modes

Auto Tasks need to know which meetings to scan for action items.

### By Count (Default)

Scans the **last N meetings** (ignoring dates).

**Best for:** Teams with consistent meeting frequency

- Default: 5 meetings
- Useful when meetings happen daily/weekly
- Adapts automatically to schedule changes

**Example:** "Scan the last 3 meetings, regardless of when they happened"

### By Age

Scans meetings from the **last N days** (ignoring count).

**Best for:** Teams with irregular meeting schedules

- Default: 7 days (1 week)
- Useful when meetings are sporadic or variable
- Captures all recent activity regardless of count

**Example:** "Scan all meetings from the last 7 days"

### When to Switch

Switch to **"by age"** if:
- Your team has inconsistent meeting frequency
- You want to ensure no old action items are missed
- You work async with batched meetings

Keep **"by count"** if:
- Your team meets regularly (e.g., daily standup + planning)
- You want to limit scope to recent activity
- You process meetings continuously

## Run Interval Explained

The **run interval** controls how often Auto Tasks wakes up to check for new work.

### Recommended Intervals

| Interval | Use Case |
|----------|----------|
| **5–15 min** | High-velocity teams, continuous deployment |
| **30–60 min** | Standard development workflow |
| **2–4 hours** | Batch processing, async teams |
| **24 hours** | Once-daily review cycle |

### How It Works

1. Auto Tasks starts a repeating timer when you enable them
2. On each interval tick, it:
   - Scans your meeting lookback for new action items
   - Checks if your repository is clean (or stashes if enabled)
   - Runs enabled tasks (Review Code, Regression, etc.)
   - Records findings in the local log
3. Timer runs **only while the app is open**
4. Closing the app pauses Auto Tasks

### Manual Run

To run immediately without waiting for the next interval:

1. Go to **Settings → Auto Tasks**
2. Click **Run Now** button
3. Progress shows in the UI; detailed logs appear in **Reveal Logs**

## Viewing Results

### In-App Status

**Settings → Auto Tasks** shows:
- Current status (Idle / Running / Disabled)
- Last run time and summary (created, implemented, failed)
- Live streaming of task findings as they complete

### Menu Bar Summary

When Auto Tasks are enabled, the menu bar shows:
- Number of enabled tasks
- Last run stats
- Quick toggle to enable/disable
- One-click access to logs

### Detailed Logs

Click **Reveal Logs** to open the auto-task log folder:

```
~/Library/Logs/LLM IDE/
├── auto-task-review-code.log
├── auto-task-review-doc.log
├── auto-task-review-conflicts.log
├── auto-task-regression.log
├── auto-task-generate-doc.log
├── auto-task-update-issues.log
└── auto-task-update-plan-status.log
```

Each log contains:
- Task run timestamp
- Meeting actions scanned
- Findings (issues, suggestions, repairs attempted)
- External API responses (for GitHub/GitLab sync)

## Troubleshooting

### "No linked repository detected"

**Cause:** Auto Tasks can't find an active GitHub or GitLab configuration.

**Fix:**
1. Go to **Settings → GitHub** or **Settings → GitLab**
2. Enter your credentials and verify
3. Ensure the **local clone path** exists and is readable
4. Return to **Auto Tasks** and try **Run Now**

### Auto Tasks not running on schedule

**Cause:** The app might be closed, or the timer didn't start.

**Fix:**
1. Ensure LLM IDE is open
2. Go to **Settings → Auto Tasks**
3. Check that **Enabled** is ON
4. Check the **Run interval** setting (minimum 5 min)
5. Try **Run Now** to verify connectivity
6. Check **Reveal Logs** for error messages

### Tasks run but find no actions

**Possible causes:**
- No meetings captured in your lookback window
- Meetings exist but contain no action items
- Lookback window is too narrow

**Fix:**
1. Verify you have recent captured meetings
2. Increase the lookback count or days
3. Check that your meeting capture is working (see [debug-captions-not-appearing.md](./debug-captions-not-appearing.md))
4. Manually add action items if testing

### "Stash restore conflict"

**Cause:** When auto-stash is ON, Git couldn't cleanly restore your changes.

**Fix:**
1. Your changes are safe in `git stash`
2. Run `git stash pop` to recover them
3. Resolve any merge conflicts manually
4. Consider disabling **Auto-stash** if conflicts are frequent

### Regression task fails

**Cause:** Test verification timed out or subprocess failed.

**Fix:**
1. Check the regression log for the specific error
2. Increase **Verify timeout** in Settings (default 120s)
3. Ensure your test environment is properly configured
4. Verify the local clone path has all test dependencies

## Best Practices

### ✓ Do This

- **Enable only tasks you need** — Disable unused tasks to save time
- **Set appropriate lookback window** — Match your team's meeting cadence
- **Review logs after changes** — Check if settings are working as expected
- **Rotate credentials regularly** — Update tokens before expiry
- **Test with "Run Now" first** — Verify settings before relying on the timer
- **Monitor the menu bar** — Glance at Auto Task status while working

### ✗ Don't Do This

- **Don't enable Auto-stash on dirty working trees** — You might lose uncommitted work if restore fails
- **Don't set run interval to < 5 min** — Excessive CPU usage, diminishing returns
- **Don't ignore error logs** — Silent failures mean you won't know if tasks stopped working
- **Don't use expired credentials** — Tasks will fail silently when tokens expire
- **Don't change both provider and settings simultaneously** — Switch providers first, then reconfigure

## Integration with External Services

### GitHub Integration

Auto Tasks can:
- Open issues for code review findings
- Comment on pull requests
- Update issue status
- Trigger GitHub Actions workflows

**Requirements:** Your GitHub token must have `repo` and `workflow` scopes.

### GitLab Integration

Auto Tasks can:
- Create merge request comments
- Create issues for findings
- Update issue labels and status
- Trigger GitLab CI pipelines

**Requirements:** Your GitLab token must have `api` and `read_repository` scopes.

### Linear Integration

Auto Tasks can update task status if you use Linear for issue tracking.

**Requirements:** Linear API token in LLM IDE settings.

### Backlog Integration

Auto Tasks can sync with Backlog for Japanese teams.

**Requirements:** Backlog API key in LLM IDE settings.

## Performance Considerations

Auto Tasks are designed to be lightweight:

| Task | Typical Duration | Resource Impact |
|------|------------------|-----------------|
| Review Code | 30–60s | Medium (LLM call) |
| Review Doc | 20–40s | Medium (LLM call) |
| Review Conflicts | 5–10s | Low |
| Regression | 2–5 min | High (subprocess) |
| Generate Knowledge | 1–2 min | Medium |
| Update Issues | 10–30s | Low (API calls) |
| Update Plan Status | 5–15s | Low (API calls) |

**Tips to reduce load:**
- Disable unused tasks
- Increase run interval (e.g., 2 hours instead of 30 min)
- Use **by age** lookback instead of large counts
- Ensure your repo clone is fast (SSD, not network drive)

## Next Steps

- Review [configure-github-gitlab.md](./configure-github-gitlab.md) for detailed provider setup
- Check [troubleshooting](../reference/error-codes.md) for specific error codes
- See [CLAUDE.md](../../CLAUDE.md) under "Auto Task Feature Audit" for internal architecture
