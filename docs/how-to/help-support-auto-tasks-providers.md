# Help & Support — Auto Tasks & Repository Providers

This section provides comprehensive guidance for using Auto Tasks and configuring your repository provider (GitHub or GitLab) in LLM IDE.

## Quick Links

### Getting Started

- **[Configure Auto Tasks](configure-auto-tasks.md)** — Enable automated code reviews, regression testing, and quality checks
- **[Configure GitHub & GitLab](configure-github-gitlab.md)** — Set up your repository provider and switch between them

### Common Tasks

#### Auto Tasks

1. **Enable Auto Tasks for the first time**
   - Read: [Configure Auto Tasks](configure-auto-tasks.md#initial-setup)
   - Time: 5–10 minutes

2. **Understand lookback windows**
   - Read: [Configure Auto Tasks](configure-auto-tasks.md#understanding-lookback-modes)
   - Time: 3 minutes

3. **Set up regression testing**
   - Read: [Configure Auto Tasks](configure-auto-tasks.md#step-3-select-which-tasks-to-run)
   - Look for: "Regression-specific options"
   - Time: 5 minutes

4. **Monitor Auto Tasks results**
   - Read: [Configure Auto Tasks](configure-auto-tasks.md#viewing-results)
   - Time: 3 minutes

5. **Troubleshoot Auto Tasks not running**
   - Read: [Configure Auto Tasks](configure-auto-tasks.md#troubleshooting)
   - Time: 5–10 minutes

#### Repository Providers

1. **Set up GitHub for the first time**
   - Read: [Configure GitHub & GitLab](configure-github-gitlab.md#github-setup)
   - Time: 5 minutes

2. **Set up GitLab for the first time**
   - Read: [Configure GitHub & GitLab](configure-github-gitlab.md#gitlab-setup)
   - Time: 5 minutes

3. **Understand why only one provider can be active**
   - Read: [Configure GitHub & GitLab](configure-github-gitlab.md#understanding-provider-exclusivity)
   - Time: 3 minutes

4. **Switch from GitHub to GitLab**
   - Read: [Configure GitHub & GitLab](configure-github-gitlab.md#switching-providers)
   - Time: 2 minutes

5. **Rotate my repository token**
   - Read: [Configure GitHub & GitLab](configure-github-gitlab.md#rotate-your-token)
   - Time: 5 minutes

6. **Troubleshoot token or repository errors**
   - Read: [Configure GitHub & GitLab](configure-github-gitlab.md#troubleshooting)
   - Time: 5–10 minutes

## What is Auto Tasks?

Auto Tasks is an **automation system** that monitors your meetings for action items and automatically:

- **Reviews code** for quality and best practices
- **Tests for regressions** when code changes land
- **Generates documentation** for your codebase
- **Syncs task status** with issue trackers (GitHub, GitLab, Linear, Backlog)
- **Detects merge conflicts** and other issues

**When is it useful?**
- You want continuous quality checks without manual intervention
- Your team needs consistent code review feedback
- You want to catch regressions before merging
- You need issue status to stay in sync across tools

**When should you skip it?**
- Your team prefers manual code review processes
- You don't use automated testing
- Your workflow doesn't need documentation generation

## What are Repository Providers?

LLM IDE integrates with **GitHub** and **GitLab** to:
- Manage issues and tasks
- Create code branches and commits
- Display timeline/Gantt views
- Run automated quality checks

**Why mutual exclusivity?**

LLM IDE enforces that **only one provider is active at a time** because:

1. **Simplified mental model** — You always know where issues go
2. **No duplicate work** — Auto Tasks don't create issues twice
3. **Clear permissions** — One set of credentials to audit
4. **Consistent state** — Gantt, Issues, and Auto Tasks all talk to the same backend

**Can I use both?**

- **Yes, you can configure both** — LLM IDE remembers both GitHub and GitLab credentials
- **But only one is active** — Whichever you set last becomes the primary provider
- **Switching is instant** — Your GitHub credentials persist; switch back anytime

## FAQ

### Auto Tasks

**Q: What happens if my repository working tree is dirty (has uncommitted changes)?**

A: Auto Tasks has two modes:
- **Auto-stash OFF (default):** Auto Tasks skip if there are uncommitted changes (safe)
- **Auto-stash ON:** Auto Tasks stash your changes, run, then restore (riskier but thorough)

Choose based on your workflow. If you work with uncommitted changes frequently, keep it OFF.

**Q: How often should Auto Tasks run?**

A: Default is every 60 minutes. Recommendations:
- **5–15 min** for high-velocity teams (continuous deployment)
- **30–60 min** for standard development
- **2–4 hours** for async/distributed teams
- **24 hours** for daily review cycles

**Q: What if Auto Tasks fail?**

A: Each task logs failures to its own log file. Click **Settings → Auto Tasks → Reveal Logs** to inspect what went wrong. Common issues:
- Repository token expired → regenerate and update credentials
- Clone path doesn't exist → verify the path
- No meetings in lookback window → increase the lookback count/days
- Test subprocess timed out → increase "Verify timeout" setting

**Q: Can Auto Tasks create issues or merge requests automatically?**

A: It depends on the task:
- **Review Code task** — Comments on MRs/PRs (doesn't create them)
- **Generate Doc task** — Can suggest doc changes (manual approval needed)
- **Create Issue task** — Can open issues for review findings (if enabled)

For security, most destructive operations require review before executing.

**Q: Does Auto Tasks work offline?**

A: No. Auto Tasks need:
1. Connection to your repository (GitHub/GitLab API)
2. Connection to LLM IDE server (for AI model calls)
3. Local repository clone (for git operations)

**Q: Can I disable Auto Tasks without losing my settings?**

A: Yes! Toggle **Enabled** to OFF. All your settings are saved. Re-enable anytime and they'll be restored.

### Repository Providers

**Q: I have both GitHub and GitLab. Which should I use?**

A: Choose based on:
- **GitHub:** If you're on GitHub.com or GitHub Enterprise; best for open source
- **GitLab:** If you're on GitLab.com or self-hosted; required for Gantt view
- **Either:** If you just need issues + code review (both work equally well)

**Q: Can I switch providers if Auto Tasks are running?**

A: Yes, but it's not recommended. The current run will complete against the old provider. Once switched, the next scheduled run uses the new provider.

**Q: What if my token expires?**

A: LLM IDE will notify you with an error. Regenerate your token on GitHub/GitLab and update it in Settings. Auto Tasks won't run again until you do.

**Q: Why doesn't Gantt work with GitHub?**

A: GitHub doesn't expose timeline/milestone data in a way that works with LLM IDE's Gantt visualization. GitLab's project roadmap features map directly to Gantt. We're exploring GitHub support in a future version.

**Q: Can I use a self-hosted GitHub or GitLab?**

A: Yes, but you might need to specify a custom endpoint URL (e.g., `https://github.mycompany.com`). Check if LLM IDE shows an option for "Custom Endpoint" or "Server URL" in Settings.

**Q: How do I rotate my credentials safely?**

A: For both providers:
1. Generate a new token on GitHub/GitLab (same scopes as before)
2. Copy the new token
3. Update **Settings → [GitHub|GitLab] → API Token**
4. Click **Verify & Save**
5. Return to GitHub/GitLab and revoke the old token

No data is lost; the switch is instant.

**Q: What if I accidentally delete my GitHub PAT or GitLab token?**

A: LLM IDE can't recover it (GitHub/GitLab don't store it either). Generate a new one and update Settings.

## Detailed Guides

For comprehensive information, see:

- **[Configure Auto Tasks](configure-auto-tasks.md)** (15 min read)
  - Prerequisites and initial setup
  - All auto task types explained
  - Lookback modes vs run intervals
  - Log viewing and troubleshooting
  - Best practices and performance tips

- **[Configure GitHub & GitLab](configure-github-gitlab.md)** (20 min read)
  - Step-by-step setup for each provider
  - Token creation and scopes explained
  - Provider switching procedure
  - Self-hosted instances
  - Security best practices
  - Full troubleshooting guide

## Still Need Help?

If your question isn't answered above:

1. **Check the detailed guides** above (most questions are answered there)
2. **Review your logs** — Click **Settings → Auto Tasks → Reveal Logs** to see detailed errors
3. **Contact support** — Include:
   - Error message or unexpected behavior
   - Screenshot of settings
   - Relevant log files (sanitize tokens first)
   - Your LLM IDE version (Help → About)

## Related Topics

- **[First Meeting](../tutorials/01-first-meeting.md)** — How to capture your first meeting
- **[Generate a Plan](../tutorials/02-generate-a-plan.md)** — Use your repository for AI planning
- **[Architecture Overview](../explanation/architecture.md)** — How the system works internally
- **[Error Codes](../reference/error-codes.md)** — Interpret specific errors
