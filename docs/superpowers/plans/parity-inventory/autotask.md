## autotask: 30/102 Swift labels exact in desktop code (29%), 4 only inside a longer sentence, 68 missing

Swift files scanned: 30. Shortcuts in Swift (not machine-matched): 2.

| kind | total | missing |
|---|---|---|
| accessibilityLabel | 5 | 3 |
| button | 15 | 4 |
| confirmationDialog | 1 | 1 |
| help | 8 | 7 |
| label | 6 | 3 |
| picker | 3 | 1 |
| text | 55 | 43 |
| textfield | 7 | 6 |
| toggle | 2 | 0 |

### Missing

- [picker] "Mode" - mac/Sources/LlmIdeMac/Features/AutoTask/Views/AddCustomAutoTaskSheet.swift:40 (+1)
- [textfield] "e.g. \"Nightly Cleanup\"" - mac/Sources/LlmIdeMac/Features/AutoTask/Views/AddCustomAutoTaskSheet.swift:36
- [textfield] "Cron, e.g. 0 * * * * — leave empty for manual ▶ only" - mac/Sources/LlmIdeMac/Features/AutoTask/Views/AddCustomAutoTaskSheet.swift:51
- [text] "New Custom Task" - mac/Sources/LlmIdeMac/Features/AutoTask/Views/AddCustomAutoTaskSheet.swift:33
- [text] "Mode" - mac/Sources/LlmIdeMac/Features/AutoTask/Views/AddCustomAutoTaskSheet.swift:39 (+1)
- [text] "Schedule (optional)" - mac/Sources/LlmIdeMac/Features/AutoTask/Views/AddCustomAutoTaskSheet.swift:50
- [button] "Reset to Default" - mac/Sources/LlmIdeMac/Features/AutoTask/Views/AutoCodeView.swift:716
- [label] "Attempt repair on regression" - mac/Sources/LlmIdeMac/Features/AutoTask/Views/AutoCodeView.swift:1095
- [label] "Auto-reopen regressed faults" - mac/Sources/LlmIdeMac/Features/AutoTask/Views/AutoCodeView.swift:1098
- [help] "Add Custom Task" - mac/Sources/LlmIdeMac/Features/AutoTask/Views/AutoCodeView.swift:110
- [help] "Push current state to a paired iPhone now" - mac/Sources/LlmIdeMac/Features/AutoTask/Views/AutoCodeView.swift:117
- [confirmationDialog] "\" template to default?" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/AutoTask/Views/AutoCodeView.swift:708
- [accessibilityLabel] "Pending" - mac/Sources/LlmIdeMac/Features/AutoTask/Views/AutoCodeView.swift:983
- [accessibilityLabel] "Implementing" - mac/Sources/LlmIdeMac/Features/AutoTask/Views/AutoCodeView.swift:987
- [text] "No linked repository detected. Auto Tasks need an active GitLab or GitHub project with a local clone path and a matching access token." - mac/Sources/LlmIdeMac/Features/AutoTask/Views/AutoCodeView.swift:132
- [text] "No enabled tasks — turn off \"Show only enabled\" to manage all tasks." - mac/Sources/LlmIdeMac/Features/AutoTask/Views/AutoCodeView.swift:168
- [text] "No runs recorded yet. Use Run Now or ▶ on a task." - mac/Sources/LlmIdeMac/Features/AutoTask/Views/AutoCodeView.swift:214
- [text] "Implement" - mac/Sources/LlmIdeMac/Features/AutoTask/Views/AutoCodeView.swift:407
- [text] "))s" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/AutoTask/Views/AutoCodeView.swift:504
- [text] "Select a review task from the left to edit its AI prompt." - mac/Sources/LlmIdeMac/Features/AutoTask/Views/AutoCodeView.swift:548
- [text] "Your custom prompt will be permanently replaced." - mac/Sources/LlmIdeMac/Features/AutoTask/Views/AutoCodeView.swift:724
- [text] "Log · live" - mac/Sources/LlmIdeMac/Features/AutoTask/Views/AutoCodeView.swift:826 (+1)
- [text] "What this task will send to the CLI, with the skill and paths above applied." - mac/Sources/LlmIdeMac/Features/AutoTask/Views/AutoCodeView.swift:919
- [text] "Configuration" - mac/Sources/LlmIdeMac/Features/AutoTask/Views/AutoCodeView.swift:1091
- [text] "Verify timeout (s)" - mac/Sources/LlmIdeMac/Features/AutoTask/Views/AutoCodeView.swift:1102
- [text] "Nothing to configure — see the description above." - mac/Sources/LlmIdeMac/Features/AutoTask/Views/AutoCodeView.swift:1110
- [button] "Choose…" - mac/Sources/LlmIdeMac/Features/AutoTask/Views/AutoTaskSettingsSection.swift:108
- [help] "Rescan this project's .claude/skills/" - mac/Sources/LlmIdeMac/Features/AutoTask/Views/AutoTaskSettingsSection.swift:175
- [text] "(not installed)" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/AutoTask/Views/AutoTaskSettingsSection.swift:156
- [button] "Approve" - mac/Sources/LlmIdeMac/Features/AutoTask/Views/AutoTaskTemplateSection.swift:76
- [button] "Rename…" - mac/Sources/LlmIdeMac/Features/AutoTask/Views/AutoTaskTemplateSection.swift:202
- [textfield] "e.g. “Nightly API Review”" - mac/Sources/LlmIdeMac/Features/AutoTask/Views/AutoTaskTemplateSection.swift:303
- [text] "This template changed outside the app (for example by a git pull) and is not approved, so tasks ignore it and use their own prompt. Read it, then approve it to let tasks run it unattended." - mac/Sources/LlmIdeMac/Features/AutoTask/Views/AutoTaskTemplateSection.swift:71
- [text] "This prompt belongs to this task alone. Save it as a template to reuse it in others." - mac/Sources/LlmIdeMac/Features/AutoTask/Views/AutoTaskTemplateSection.swift:86
- [text] "This task has no prompt of its own — pick a saved template to give it one." - mac/Sources/LlmIdeMac/Features/AutoTask/Views/AutoTaskTemplateSection.swift:91
- [text] "The file is removed from templates/auto_task/. Every task using it falls back to its own prompt." - mac/Sources/LlmIdeMac/Features/AutoTask/Views/AutoTaskTemplateSection.swift:156
- [text] "(missing)" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/AutoTask/Views/AutoTaskTemplateSection.swift:176
- [text] "Unsaved" - mac/Sources/LlmIdeMac/Features/AutoTask/Views/AutoTaskTemplateSection.swift:236
- [text] "Saved to templates/auto_task/ as a markdown file." - mac/Sources/LlmIdeMac/Features/AutoTask/Views/AutoTaskTemplateSection.swift:306
- [textfield] "cron" - mac/Sources/LlmIdeMac/Features/AutoTask/Views/CronField.swift:143
- [accessibilityLabel] "Schedule active" - mac/Sources/LlmIdeMac/Features/AutoTask/Views/CronField.swift:105
- [textfield] "Cron (empty = manual only)" - mac/Sources/LlmIdeMac/Features/AutoTask/Views/CustomTaskScheduleSection.swift:125
- [text] "Manual only — use ▶ Run" - mac/Sources/LlmIdeMac/Features/AutoTask/Views/CustomTaskScheduleSection.swift:78
- [text] "invalid" - mac/Sources/LlmIdeMac/Features/AutoTask/Views/CustomTaskScheduleSection.swift:129
- [text] "Clears the schedule — task runs only via ▶ Run" - mac/Sources/LlmIdeMac/Features/AutoTask/Views/CustomTaskScheduleSection.swift:148
- [textfield] "Filter folders" - mac/Sources/LlmIdeMac/Features/AutoTask/Views/LibraryFolderPicker.swift:46
- [text] "Reading the project's folders…" - mac/Sources/LlmIdeMac/Features/AutoTask/Views/LibraryFolderPicker.swift:76
- [label] "When all models are exhausted: Pause until reset." - mac/Sources/LlmIdeMac/Features/AutoTask/Views/ModelLimitsPanel.swift:472
- [help] "Edit limit" - mac/Sources/LlmIdeMac/Features/AutoTask/Views/ModelLimitsPanel.swift:205
- [help] "Higher priority" - mac/Sources/LlmIdeMac/Features/AutoTask/Views/ModelLimitsPanel.swift:265
- [help] "Lower priority" - mac/Sources/LlmIdeMac/Features/AutoTask/Views/ModelLimitsPanel.swift:267
- [help] "Refresh usage" - mac/Sources/LlmIdeMac/Features/AutoTask/Views/ModelLimitsPanel.swift:486
- [text] "Your usage limits" - mac/Sources/LlmIdeMac/Features/AutoTask/Views/ModelLimitsPanel.swift:132
- [text] "No models in this provider's chain yet. Add a model in Settings → Providers." - mac/Sources/LlmIdeMac/Features/AutoTask/Views/ModelLimitsPanel.swift:145
- [text] "Limit" - mac/Sources/LlmIdeMac/Features/AutoTask/Views/ModelLimitsPanel.swift:272
- [text] "Runs" - mac/Sources/LlmIdeMac/Features/AutoTask/Views/ModelLimitsPanel.swift:277
- [text] "Tokens" - mac/Sources/LlmIdeMac/Features/AutoTask/Views/ModelLimitsPanel.swift:277
- [text] "Daily" - mac/Sources/LlmIdeMac/Features/AutoTask/Views/ModelLimitsPanel.swift:279
- [text] "Monthly" - mac/Sources/LlmIdeMac/Features/AutoTask/Views/ModelLimitsPanel.swift:279
- [text] "Switch at" - mac/Sources/LlmIdeMac/Features/AutoTask/Views/ModelLimitsPanel.swift:282
- [text] "No cap — unlimited; the chain won't pause on this model." - mac/Sources/LlmIdeMac/Features/AutoTask/Views/ModelLimitsPanel.swift:290
- [text] "API rate limit" - mac/Sources/LlmIdeMac/Features/AutoTask/Views/ModelLimitsPanel.swift:328
- [text] "updated" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/AutoTask/Views/ModelLimitsPanel.swift:334
- [text] "No API rate-limit data yet — it appears after an API-key call to this provider. Not available in subscription / CLI mode (providers expose no API for subscription usage)." - mac/Sources/LlmIdeMac/Features/AutoTask/Views/ModelLimitsPanel.swift:348
- [text] "· resets" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/AutoTask/Views/ModelLimitsPanel.swift:370 (+1)
- [text] "Claude subscription usage" - mac/Sources/LlmIdeMac/Features/AutoTask/Views/ModelLimitsPanel.swift:391
- [text] "auto-refreshes" - mac/Sources/LlmIdeMac/Features/AutoTask/Views/ModelLimitsPanel.swift:392
- [text] "Anthropic didn't return a recognizable usage shape for this account." - mac/Sources/LlmIdeMac/Features/AutoTask/Views/ModelLimitsPanel.swift:408
