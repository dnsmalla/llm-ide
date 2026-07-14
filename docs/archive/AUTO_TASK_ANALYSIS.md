# Auto Task Menu Analysis & Recommendations

## Current Auto Tasks Menu

The Mac app currently has **5 automated tasks** available in the `AutoCodeView`:

### 1. 🔍 Review Code (`reviewCode`)
- **Icon**: `checkmark.shield`
- **Default**: ✅ Enabled
- **Purpose**: Review recent commits for bugs, security issues, and code style problems
- **Template**: Customizable
- **Source Section**: N/A (standalone review)

### 2. 📄 Review Doc (`reviewDoc`) 
- **Icon**: `doc.text.magnifyingglass`
- **Default**: ✅ Enabled
- **Purpose**: Review documentation for outdated sections, clarity, and completeness
- **Template**: Customizable
- **Source Section**: `plans` (Review Doc)

### 3. ⚠️ Review Conflicts (`reviewConflicts`)
- **Icon**: `exclamationmark.triangle`
- **Default**: ❌ Disabled
- **Purpose**: Check for merge conflicts and resolution strategies
- **Template**: Customizable
- **Source Section**: `conflicts` (Review Conflicts)

### 4. 🔄 Regression (`regression`)
- **Icon**: `arrow.uturn.backward.circle`
- **Default**: ❌ Disabled
- **Purpose**: Re-ask fixed fault reports to detect regressions
- **Template**: ❌ None (structural task)
- **Source Section**: `regression` (Regression)

### 5. 🧠 Knowledge (`generateKnowledge`)
- **Icon**: `brain`
- **Default**: ✅ Enabled
- **Purpose**: Surface code graph + memory + search index status
- **Template**: ❌ None (structural task)
- **Source Section**: `codeGraph` (Code Graph)

---

## All Mac App Sections

| Section | Label | Purpose | Automatable |
|---------|-------|---------|-------------|
| `library` | Library | File browser/library | ❌ Manual |
| `live` | Live | Live transcription | ❌ Manual |
| `explorer` | Explorer | File explorer | ❌ Manual |
| `search` | Search | Search functionality | ❌ Manual |
| `plans` | Review Doc | Documentation review | ✅ Already exists |
| `conflicts` | Review Conflicts | Conflict detection | ✅ Already exists |
| `sourceControl` | Source Control | Git management | ⚠️ Risky |
| `issues` | Issues | Issue tracking | ✅ **Recommended** |
| `gantt` | Gantt | Project timeline | ⚠️ View-only |
| `visual` | Visual | Image viewer | ❌ Manual |
| `docGen` | Doc Gen | Documentation generation | ✅ **Recommended** |
| `autoCode` | Auto Tasks | Automation hub | ✅ Already exists |
| `codeGraph` | Code Graph | Code visualization | ✅ Already exists |
| `regression` | Regression | Regression testing | ✅ Already exists |
| `settings` | Settings | App configuration | ❌ Manual |

---

## Recommended New Auto Tasks

### 1. 📝 Generate Documentation (`generateDoc`)

**Source Section**: `docGen` (Doc Gen)

**Purpose**: Automatically generate documentation from code changes, API specs, or meeting summaries

**Icon**: `wand.and.stars`

**Default**: ✅ Enabled

**Template**: 
```
Generate comprehensive documentation for recent code changes in this repository. Focus on:
1. New or modified public APIs/functions
2. Updated data structures and interfaces  
3. Configuration changes
4. Migration guides if breaking changes were introduced

This is READ-ONLY: do NOT edit, create, or delete any files. Output the documentation in markdown format suitable for the project's docs/ folder.
```

**Justification**: 
- DocGen section exists but requires manual triggering
- Documentation often lags behind code changes
- Automated documentation keeps project docs current
- Complements the existing "Review Doc" task (one reviews, one generates)

**Implementation Notes**:
- Should integrate with existing `DocGenService`
- Output should be saved to appropriate docs/ locations
- Could be configured to target specific doc sections (API, user guide, etc.)

---

### 2. 🎫 Update Issues (`updateIssues`)

**Source Section**: `issues` (Issues)

**Purpose**: Automatically create or update GitHub/GitLab issues from meeting action items, code review findings, or detected bugs

**Icon**: `checklist`

**Default**: ❌ Disabled (opt-in due to external API calls)

**Template**:
```
Review recent code changes, meeting notes, and detected issues in this repository. For each significant finding that requires action:

1. Check if a related issue already exists in the issue tracker
2. If not, create a new issue with:
   - Clear title describing the problem
   - Detailed description with reproduction steps if applicable
   - Appropriate labels/tags
   - Priority level based on severity
   - Related files/commits referenced

This is READ-ONLY for the codebase: only interact with the issue tracker API. Do NOT modify any source files.
```

**Justification**:
- Issues section exists but requires manual issue creation
- Code review findings often get lost without actionable tracking
- Meeting action items need to be converted to tickets
- Automates the "dispatch" workflow that currently requires manual intervention

**Implementation Notes**:
- Should integrate with existing `RepoIssuesView` and provider APIs
- Requires GitHub/GitLab credentials (already in AppConfig)
- Should be opt-in by default due to external API usage
- Could be configured to only create issues, or also update existing ones

---

### 3. 📊 Update Plan Status (`updatePlanStatus`)

**Source Section**: `plans` (Review Doc - should be renamed to Plans)

**Purpose**: Automatically update plan task statuses based on external outcome tracking (GitHub/GitLab issues, Linear, Backlog)

**Icon**: `chart.bar.doc.horizontal`

**Default**: ❌ Disabled

**Template**: None (structural task)

**Description**: 
```
Poll external outcome trackers (GitHub/GitLab/Linear/Backlog) for all dispatched plan tasks and update their status in the local plan. Tasks marked as done/closed externally will be marked as completed in the plan.
```

**Justification**:
- Plans section exists with outcome tracking but requires manual refresh
- Task statuses often become stale without automated polling
- Reduces manual status checking across multiple external systems
- Complements the existing "dispatch" workflow

**Implementation Notes**:
- Should use existing `/kb/outcomes/refresh` endpoint
- Can leverage existing `refreshOutcomes()` logic from PlanView
- Should run on a configurable interval (hourly/daily)
- Requires credentials for connected providers

---

## Not Recommended for Automation

### ❌ Source Control Operations
**Risk**: Too dangerous to automate git operations like commit, push, or branch management without explicit user approval

### ❌ Gantt Chart Updates  
**Reason**: Gantt is a visualization view, not an action. Timeline updates should happen as a side effect of task status updates, not as a separate automation

### ❌ Visual/Search/Explorer
**Reason**: These are manual browsing/exploration tools, not automation candidates

### ❌ Live Transcription
**Reason**: Requires explicit user intent to start/stop recording

---

## Implementation Priority

### High Priority (Immediate Value)
1. **Generate Documentation** - High impact, low risk, fills clear gap
2. **Update Issues** - Connects code review to issue tracking workflow

### Medium Priority (Process Improvement)  
3. **Update Plan Status** - Reduces manual polling, improves plan accuracy

### Low Priority (Future Enhancement)
- Custom automation hooks for user-defined workflows
- Integration with external CI/CD systems

---

## Updated Auto Task Menu Structure

### Current Tasks (Keep)
- Review Code ✅
- Review Doc ✅  
- Review Conflicts ✅
- Regression ✅
- Knowledge ✅

### New Tasks (Add)
- **Generate Documentation** 🆕
- **Update Issues** 🆕
- **Update Plan Status** 🆕

### Configuration Row (Keep)
- Model & Limits ✅

---

## Recommended UI Changes

### 1. Rename Section Labels for Clarity
- `plans` → "Plans" (currently "Review Doc" which is confusing)
- Keep "Review Doc" as an auto task, but separate from the Plans section

### 2. Add Task Categories
Organize tasks into logical groups:
- **Review Tasks**: Code, Docs, Conflicts
- **Automation Tasks**: Issues, Plan Status, Documentation  
- **Maintenance Tasks**: Regression, Knowledge
- **Configuration**: Model & Limits

### 3. Enhanced Task Configuration
For each task, show:
- Last run status (success/failure/pending)
- Output summary (findings count, issues created, etc.)
- Manual "Run Now" button per task
- Configure schedule (global vs per-task)

---

## Conclusion

The current auto task menu provides a solid foundation for code maintenance automation. By adding **Generate Documentation**, **Update Issues**, and **Update Plan Status**, the system would cover the complete workflow from:

```
Code Changes → Review → Track Issues → Update Plans → Generate Docs
```

This creates a comprehensive autonomous development assistant that reduces manual overhead while maintaining user control through configurable opt-in settings and review workflows.

The recommended additions are low-risk, high-value automations that integrate with existing systems and workflows without introducing dangerous operations or breaking changes.