## issues: 18/71 Swift labels exact in desktop code (25%), 3 only inside a longer sentence, 50 missing

Swift files scanned: 12. Shortcuts in Swift (not machine-matched): 5.

| kind | total | missing |
|---|---|---|
| accessibilityLabel | 1 | 1 |
| button | 15 | 11 |
| help | 6 | 4 |
| label | 7 | 3 |
| text | 34 | 25 |
| textfield | 7 | 5 |
| toggle | 1 | 1 |

### Missing

- [textfield] "Search projects…" - mac/Sources/LlmIdeMac/Features/Issues/Gantt/Views/GanttContainerView.swift:172
- [text] "Gantt Chart" - mac/Sources/LlmIdeMac/Features/Issues/Gantt/Views/GanttContainerView.swift:120
- [text] "project to view the timeline" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Issues/Gantt/Views/GanttContainerView.swift:122
- [button] "Clear" - mac/Sources/LlmIdeMac/Features/Issues/Gantt/Views/GanttFilterBar.swift:53 (+3)
- [button] "Done" - mac/Sources/LlmIdeMac/Features/Issues/Gantt/Views/GanttFilterBar.swift:235
- [help] "Clear search" - mac/Sources/LlmIdeMac/Features/Issues/Gantt/Views/GanttFilterBar.swift:26
- [accessibilityLabel] "Clear search" - mac/Sources/LlmIdeMac/Features/Issues/Gantt/Views/GanttFilterBar.swift:25
- [text] "Date Range" - mac/Sources/LlmIdeMac/Features/Issues/Gantt/Views/GanttFilterBar.swift:223
- [button] "Retry" - mac/Sources/LlmIdeMac/Features/Issues/Gantt/Views/GanttView.swift:256 (+1)
- [button] "Open Details" - mac/Sources/LlmIdeMac/Features/Issues/Gantt/Views/GanttView.swift:509
- [button] "Edit Schedule…" - mac/Sources/LlmIdeMac/Features/Issues/Gantt/Views/GanttView.swift:511
- [help] "Refresh  ⌘R" - mac/Sources/LlmIdeMac/Features/Issues/Gantt/Views/GanttView.swift:344 (+1)
- [help] "(author) — unassigned" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Issues/Gantt/Views/GanttView.swift:482
- [text] "Milestone" - mac/Sources/LlmIdeMac/Features/Issues/Gantt/Views/GanttView.swift:308
- [textfield] "issue numbers, comma-separated (e.g. 12, 34)" - mac/Sources/LlmIdeMac/Features/Issues/Gantt/Views/IssueScheduleEditorSheet.swift:124
- [text] "Due date must be on or after the start date." - mac/Sources/LlmIdeMac/Features/Issues/Gantt/Views/IssueScheduleEditorSheet.swift:62
- [text] "Schedule" - mac/Sources/LlmIdeMac/Features/Issues/Gantt/Views/IssueScheduleEditorSheet.swift:81
- [text] "Blocking issues — shown as arrows from the blocker bar to this issue." - mac/Sources/LlmIdeMac/Features/Issues/Gantt/Views/IssueScheduleEditorSheet.swift:126
- [text] "Clear schedule" - mac/Sources/LlmIdeMac/Features/Issues/Gantt/Views/IssueScheduleEditorSheet.swift:135
- [text] "Pick an existing issue" - mac/Sources/LlmIdeMac/Features/Issues/Views/ExistingIssuePicker.swift:38
- [text] "Loading open issues…" - mac/Sources/LlmIdeMac/Features/Issues/Views/ExistingIssuePicker.swift:59
- [text] "No open issues" - mac/Sources/LlmIdeMac/Features/Issues/Views/ExistingIssuePicker.swift:86
- [button] "View" - mac/Sources/LlmIdeMac/Features/Issues/Views/RepoIssueDetailSheet.swift:153 (+1)
- [button] "Edit" - mac/Sources/LlmIdeMac/Features/Issues/Views/RepoIssueDetailSheet.swift:473
- [button] "Remove" - mac/Sources/LlmIdeMac/Features/Issues/Views/RepoIssueDetailSheet.swift:510
- [toggle] "Draft" - mac/Sources/LlmIdeMac/Features/Issues/Views/RepoIssueDetailSheet.swift:851
- [textfield] "feature/issue-" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Issues/Views/RepoIssueDetailSheet.swift:844
- [textfield] "main" - mac/Sources/LlmIdeMac/Features/Issues/Views/RepoIssueDetailSheet.swift:848
- [text] "created." (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Issues/Views/RepoIssueDetailSheet.swift:151
- [text] "opened this issue" - mac/Sources/LlmIdeMac/Features/Issues/Views/RepoIssueDetailSheet.swift:290
- [text] "No labels in this project" - mac/Sources/LlmIdeMac/Features/Issues/Views/RepoIssueDetailSheet.swift:361
- [text] "Edit" - mac/Sources/LlmIdeMac/Features/Issues/Views/RepoIssueDetailSheet.swift:443
- [text] "Set due date" - mac/Sources/LlmIdeMac/Features/Issues/Views/RepoIssueDetailSheet.swift:490
- [text] "Due date" - mac/Sources/LlmIdeMac/Features/Issues/Views/RepoIssueDetailSheet.swift:504
- [text] "No comments yet." - mac/Sources/LlmIdeMac/Features/Issues/Views/RepoIssueDetailSheet.swift:571
- [text] "system" - mac/Sources/LlmIdeMac/Features/Issues/Views/RepoIssueDetailSheet.swift:592
- [text] "Create" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Issues/Views/RepoIssueDetailSheet.swift:815
- [text] "already exists for this branch." (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Issues/Views/RepoIssueDetailSheet.swift:832
- [button] "Any milestone" - mac/Sources/LlmIdeMac/Features/Issues/Views/RepoIssuesView.swift:399
- [button] "Any label" - mac/Sources/LlmIdeMac/Features/Issues/Views/RepoIssuesView.swift:446
- [button] "Any assignee" - mac/Sources/LlmIdeMac/Features/Issues/Views/RepoIssuesView.swift:468
- [textfield] "Search title / body" - mac/Sources/LlmIdeMac/Features/Issues/Views/RepoIssuesView.swift:361
- [text] "New Issue" - mac/Sources/LlmIdeMac/Features/Issues/Views/RepoIssuesView.swift:165 (+1)
- [text] "Drop issues here" - mac/Sources/LlmIdeMac/Features/Issues/Views/RepoKanbanPanel.swift:136
- [label] "projects" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Issues/Views/RepoProjectDropdown.swift:26
- [label] "Quick Fix" - mac/Sources/LlmIdeMac/Features/ReviewConflicts/Views/ReviewView.swift:198
- [label] "Guided" - mac/Sources/LlmIdeMac/Features/ReviewConflicts/Views/ReviewView.swift:201
- [help] "Quick Fix (one screen) or Guided (5 steps) — start a Code update" - mac/Sources/LlmIdeMac/Features/ReviewConflicts/Views/ReviewView.swift:215
- [text] "New Change…" - mac/Sources/LlmIdeMac/Features/ReviewConflicts/Views/ReviewView.swift:206
- [text] "Linked: **" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/ReviewConflicts/Views/ReviewView.swift:256
