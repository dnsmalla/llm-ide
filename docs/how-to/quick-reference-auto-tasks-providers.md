# Quick Reference: Auto Tasks & Providers

One-page cheat sheet for common operations.

## Auto Tasks Quick Setup

```
Settings → Auto Tasks

1. Toggle "Enabled" to ON
2. Set lookback: 5 meetings (or 7 days)
3. Set interval: 60 minutes
4. Select tasks: Review Code ✓, Review Doc ✓, Regression, etc.
5. Click "Run Now" to test
6. Check logs: "Reveal Logs"
```

## Auto Tasks Settings Reference

| Setting | Default | Range | Notes |
|---------|---------|-------|-------|
| Enabled | OFF | ON/OFF | Master toggle for all auto tasks |
| Lookback by days | OFF | ON/OFF | Switch between "meetings count" and "days" mode |
| Lookback count | 5 | 1–20 | Scan last N meetings (when `by days` = OFF) |
| Lookback days | 7 | 1–30 | Scan last N days (when `by days` = ON) |
| Interval minutes | 60 | 5–1440 | How often to run (min 5 min, max 24 hr) |
| Auto-stash | OFF | ON/OFF | Stash uncommitted changes before running |
| Review Code | ON | ON/OFF | Analyze code for quality issues |
| Review Doc | ON | ON/OFF | Check documentation consistency |
| Review Conflicts | OFF | ON/OFF | Detect merge conflicts |
| Regression | OFF | ON/OFF | Re-run tests on changed commits |
| Generate Knowledge | ON | ON/OFF | Update code graph insights |
| Generate Doc | ON | ON/OFF | Auto-generate documentation |
| Update Issues | OFF | ON/OFF | Sync task status with tracker |
| Update Plan Status | OFF | ON/OFF | Poll external task status |
| Regression: Attempt repair | OFF | ON/OFF | Auto-fix failing tests |
| Regression: Auto-reopen | OFF | ON/OFF | Reopen issues that regressed |
| Regression: Verify timeout | 120s | 1–600s | Max time per test |

## GitHub Quick Setup

```
Settings → GitHub

1. Enter org/project: owner/repo (e.g., acme/web-app)
2. Paste GitHub PAT token
3. Enter local clone path: /Users/you/projects/web-app
4. Click "Verify & Save"
5. Check if GitHub is now your active provider ✓
```

**Get a GitHub token:**
1. Go to https://github.com/settings/tokens
2. Click "Generate new token (classic)"
3. Scopes: `repo`, `workflow`
4. Copy token immediately

## GitLab Quick Setup

```
Settings → GitLab

1. Enter group/project: group/subgroup/project (e.g., acme/backend/api)
2. Paste GitLab PAT token
3. Enter local clone path: /Users/you/projects/api
4. Click "Verify & Save"
5. Check if GitLab is now your active provider ✓
```

**Get a GitLab token:**
1. Go to https://gitlab.com/-/user_settings/personal_access_tokens
2. Click "Add new token"
3. Scopes: `api`, `read_repository`
4. Copy token immediately

## Provider Exclusivity

When you set a provider, the other one **deactivates automatically**:

```
GitHub configured? → GitLab deactivates
GitLab configured? → GitHub deactivates

Both credentials saved, only one active.
Switch anytime: just configure the other one.
```

## Run Modes

### Scheduled (Default)

```
Enabled = ON → Timer runs every N minutes
Only while app is open
Check status in menu bar
Results logged automatically
```

### Manual

```
Settings → Auto Tasks → "Run Now"
Runs immediately (bypasses timer)
Wait for completion in UI
Check "Reveal Logs" for details
```

## Lookback Modes

### By Count (Default)

```
Scan the last 5 meetings (regardless of date)
Best for: consistent meeting frequency
Example: Daily standup + planning → lookback 3–5
```

### By Age

```
Scan all meetings from last 7 days
Best for: irregular meeting schedule
Example: Weekly planning + ad-hoc meetings → lookback 7 days
```

**Switch modes:**
```
Settings → Auto Tasks → "Scan last" → toggle "by count" / "by age"
```

## Viewing Results

### In Settings

```
Settings → Auto Tasks
├── Status: "Idle" / "Running" / "Disabled"
├── Last run: X minutes ago
├── Stats: N created, N implemented, N failed
├── "Run Now" button
└── "Reveal Logs" button
```

### Menu Bar

```
Menu bar shows:
├── Auto Tasks status
├── Number of enabled tasks
├── Last run stats
└── Quick toggle

Click to expand popover with full details
```

### Detailed Logs

```
Click "Reveal Logs"
Folder: ~/Library/Logs/LLM IDE/

Files:
- auto-task-review-code.log
- auto-task-review-doc.log
- auto-task-regression.log
- auto-task-generate-doc.log
- auto-task-update-issues.log
- etc.

Each log contains: timestamps, findings, errors
```

## Troubleshooting Matrix

| Problem | Quick Fix | Details |
|---------|-----------|---------|
| "No linked repo" | Configure GitHub/GitLab in Settings | See GitHub/GitLab Setup section |
| Token invalid | Regenerate token on GitHub/GitLab, paste new one | Tokens expire; rotate every 90 days |
| Clone path doesn't exist | Create dir and clone repo: `git clone <url> <path>` | Dir must exist and be readable |
| No actions found | Increase lookback count/days | Might not have recent meetings with actions |
| Working tree dirty | Enable "Auto-stash" or commit changes | Choose based on your workflow |
| Stash restore conflict | Run `git stash pop` manually | Your changes are safe; resolve manually |
| Tasks not running | Check "Enabled" toggle; try "Run Now" | Timer requires app to be open |
| Regression timeout | Increase "Verify timeout" setting | Default 120s; may need more for large repos |

## Keyboard Shortcuts & Navigation

| Action | Location |
|--------|----------|
| Open Auto Tasks settings | Settings (gear icon) → scroll to "Auto Tasks" |
| Open GitHub settings | Settings → scroll to "GitHub" |
| Open GitLab settings | Settings → scroll to "GitLab" |
| Run Auto Tasks now | Settings → Auto Tasks → "Run Now" |
| View Auto Tasks logs | Settings → Auto Tasks → "Reveal Logs" |
| Switch providers | Settings → GitHub or GitLab → Verify & Save |

## Common Sequences

### First-Time Setup

```
1. Configure repository (GitHub or GitLab)
   Settings → [GitHub|GitLab] → Enter credentials → Verify & Save
   
2. Configure Auto Tasks
   Settings → Auto Tasks → Toggle Enabled ON
   
3. Test it
   Settings → Auto Tasks → Click "Run Now"
   
4. Monitor
   Check menu bar for status
   Click "Reveal Logs" to see details
```

### Rotate Credentials

```
1. Generate new token (GitHub/GitLab)
2. Copy token
3. Settings → [GitHub|GitLab] → Paste new token
4. Click "Verify & Save"
5. Revoke old token on GitHub/GitLab
```

### Switch Providers (GitHub ↔ GitLab)

```
1. Settings → [New Provider]
2. Enter credentials
3. Click "Verify & Save"
4. Old provider automatically deactivates
5. Features switch to new provider instantly
```

### Enable Regression Testing

```
1. Settings → Auto Tasks
2. Toggle "Regression" to ON
3. (Optional) Toggle "Attempt repair on regression" ON
4. (Optional) Toggle "Auto-reopen regressed faults" ON
5. (Optional) Increase "Verify timeout" if tests are slow
6. Click "Run Now" to test
```

## Performance Tips

| Goal | Setting Changes |
|------|-----------------|
| Reduce CPU/memory | Disable unused tasks; increase interval to 2–4 hours |
| Run faster | Reduce lookback count; disable expensive tasks (Regression) |
| Catch more issues | Enable all tasks; decrease interval; increase lookback |
| Save credentials | Both providers auto-save; switch anytime without reconfiguring |

## Security Reminders

- **Token is a credential** — Treat it like a password
- **Rotate tokens** — Every 90 days (both GitHub and GitLab recommend this)
- **Revoke old tokens** — When you rotate, delete the old one immediately
- **Never commit tokens** — `.git/config` should never contain tokens
- **Keychain is safe** — LLM IDE stores tokens in macOS Keychain (encrypted)
- **Audit logs** — Check GitHub/GitLab activity logs occasionally

## Links

- **Full Auto Tasks guide:** [Configure Auto Tasks](configure-auto-tasks.md)
- **Full Provider guide:** [Configure GitHub & GitLab](configure-github-gitlab.md)
- **Help & Support:** [Help & Support](help-support-auto-tasks-providers.md)
- **Error codes:** [Error Codes](../reference/error-codes.md)
