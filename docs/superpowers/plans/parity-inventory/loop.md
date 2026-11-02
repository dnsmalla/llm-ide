## loop: 35/177 Swift labels exact in desktop code (20%), 7 only inside a longer sentence, 135 missing

Swift files scanned: 83. Shortcuts in Swift (not machine-matched): 0.

| kind | total | missing |
|---|---|---|
| accessibilityLabel | 3 | 1 |
| alert | 3 | 3 |
| button | 27 | 17 |
| confirmationDialog | 2 | 2 |
| help | 21 | 20 |
| label | 3 | 2 |
| menu | 1 | 1 |
| navigationTitle | 1 | 0 |
| picker | 4 | 0 |
| section | 2 | 2 |
| stepper | 6 | 5 |
| text | 88 | 67 |
| textfield | 12 | 11 |
| toggle | 4 | 4 |

### Missing

- [stepper] "non-improving failures" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopBudgetsEditor.swift:31
- [stepper] "Max repairs per stage:" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopBudgetsEditor.swift:35
- [button] "Cancel" - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopEngineHomeView.swift:99 (+5)
- [button] "Set as Primary" - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopEngineHomeView.swift:175
- [help] "Built-in loop — editable and can be switched off, but not deleted" - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopEngineHomeView.swift:158
- [help] "Primary — the loop the phone and the chat command run" - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopEngineHomeView.swift:164
- [help] "Not run by the scheduled Loop auto task" - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopEngineHomeView.swift:170
- [alert] "Delete this loop?" - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopEngineHomeView.swift:95
- [text] "Its stages, budgets, and run history stay on disk under this project's loop.json, but it will no longer appear here. \"" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopEngineHomeView.swift:107
- [text] "Its stages, budgets, and run history stay on disk under this project's loop.json, but it will no longer appear here." - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopEngineHomeView.swift:109
- [button] "Reset custom templates" - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopEngineView+DetailPane.swift:341 (+1)
- [button] "Reveal" - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopEngineView+DetailPane.swift:520
- [toggle] "Use isolated git worktrees for concurrent runs" - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopEngineView+DetailPane.swift:376
- [toggle] "Open a merge request after a successful run that changed files" - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopEngineView+DetailPane.swift:482
- [toggle] "Write a run summary note to the Library" - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopEngineView+DetailPane.swift:491 (+2)
- [textfield] "Loop name" - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopEngineView+DetailPane.swift:31
- [textfield] "e.g. Stabilize the auth test suite" - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopEngineView+DetailPane.swift:37
- [textfield] "e.g. swift test passes 3 times in a row" - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopEngineView+DetailPane.swift:40
- [textfield] "What does this loop do?" - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopEngineView+DetailPane.swift:331 (+1)
- [textfield] "e.g. src/auth/**" - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopEngineView+DetailPane.swift:553
- [label] "Add path" - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopEngineView+DetailPane.swift:577
- [section] "Built-in" - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopEngineView+DetailPane.swift:275 (+1)
- [section] "My templates" - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopEngineView+DetailPane.swift:281 (+1)
- [stepper] "Batches per run:" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopEngineView+DetailPane.swift:251
- [alert] "Save as template" - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopEngineView+DetailPane.swift:329 (+1)
- [alert] "Couldn't save template" - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopEngineView+DetailPane.swift:337
- [text] "Optional. When set, both are given to the repair agent and any generate stage alongside the raw failure output — so a fix stays aimed at what this loop is for, not just at making a command exit 0." - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopEngineView+DetailPane.swift:42
- [text] "No stages yet. Apply a template below, or add a stage with + on the left." - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopEngineView+DetailPane.swift:50
- [text] "After a batch passes every check, the run starts the plan's next todo batch, up to this many. Iterations and repairs count afresh for each batch; the time budget covers the whole run. A batch that fails is rolled back and ends the run." - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopEngineView+DetailPane.swift:253
- [text] "Choose a recipe…" - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopEngineView+DetailPane.swift:274
- [text] "Applying replaces the current stages and budgets and saves shortly after. Shell stages will need approving again." - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopEngineView+DetailPane.swift:323
- [text] "Saves the current stages and budgets as a reusable recipe, available in every project." - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopEngineView+DetailPane.swift:335
- [text] "Budgets — a run stops at whichever it hits first. The time budget is checked between iterations (and never during the first one), so a long iteration can overrun it; paused time is not counted." - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopEngineView+DetailPane.swift:361
- [text] "When another run is already using the main checkout, start in an isolated worktree instead of waiting. Changed worktrees and their branches are retained for review. Off by default." - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopEngineView+DetailPane.swift:378
- [text] "A non-improving failure is one whose failing-test count did not shrink; for runners we can't parse, one whose output is unchanged." - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopEngineView+DetailPane.swift:382
- [text] "If a repair edits a test, build file, or system/" - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopEngineView+DetailPane.swift:389 (+1)
- [text] "Scope — restrict this loop to specific paths (optional)" - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopEngineView+DetailPane.swift:406
- [text] "Not enforced — the policy above is Off, which disables the scope check too." - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopEngineView+DetailPane.swift:410
- [text] "Unrestricted — this loop's repairs may touch any path not otherwise protected." - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopEngineView+DetailPane.swift:416
- [text] "When set, a repair that changes a path matching none of these is treated as an out-of-scope violation, under the same policy as the protected-path setting above." - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopEngineView+DetailPane.swift:421
- [text] "Changes save automatically; Save writes immediately — including states autosave skips, like an emptied stage list." - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopEngineView+DetailPane.swift:430
- [text] "A readable markdown summary per run — outcome, pipeline, per-stage results, files changed — under llm-doc/loop/. The journal above always records every run regardless." - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopEngineView+DetailPane.swift:493
- [text] "not yet" - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopEngineView+DetailPane.swift:526
- [help] "Runs this project's own Python (python -m pytest --version, pip check). Only click for a repository you trust." - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopEngineView+Environment.swift:23
- [text] "Not inspected yet." - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopEngineView+Environment.swift:44
- [text] "Nothing is installed or changed. The Python check runs this project's own Python, so it only starts when you click — only click for a repository you trust." - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopEngineView+Environment.swift:48
- [text] "iter ·" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopEngineView+PastRunInspector.swift:40 (+1)
- [text] "repairs/stage · pause timeout:" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopEngineView+PastRunInspector.swift:87
- [text] "No stages executed." - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopEngineView+PastRunInspector.swift:97
- [text] "failing" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopEngineView+PastRunInspector.swift:126
- [text] "Files changed" - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopEngineView+PastRunInspector.swift:187 (+1)
- [button] "Skill (generate)" - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopEngineView.swift:359 (+1)
- [button] "Move up" - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopEngineView.swift:447
- [button] "Move down" - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopEngineView.swift:449
- [button] "Run this stage only" - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopEngineView.swift:453
- [button] "Reset to default" - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopEngineView.swift:591
- [button] "Leave queue" - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopEngineView.swift:687
- [button] "command\\(pending.count == 1 ?" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopEngineView.swift:754
- [button] "Approve all" - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopEngineView.swift:771
- [button] "Set up" - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopEngineView.swift:792
- [button] "Reveal JSON" - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopEngineView.swift:1119
- [button] "Back" - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopEngineView.swift:1125
- [toggle] "Repairable" - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopEngineView.swift:1011 (+1)
- [menu] "More targets" - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopEngineView.swift:1066
- [textfield] "Stage name" - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopEngineView.swift:843 (+1)
- [textfield] "e.g. swift test && swift build" - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopEngineView.swift:859
- [textfield] "Defaults to: apply this skill" - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopEngineView.swift:970 (+1)
- [textfield] "Filter" - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopEngineView.swift:1302
- [label] "Disabled: no test command detected — re-enabled automatically when one is found." - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopEngineView.swift:581
- [help] "Add a stage" - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopEngineView.swift:368
- [help] "Disabled — the runner skips this stage" - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopEngineView.swift:415
- [help] "Command not yet approved on this machine" - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopEngineView.swift:425
- [help] "Default stage — can't be deleted (disable it instead)" - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopEngineView.swift:431 (+1)
- [help] "Replace this stage's content with the current default (your enabled/severity/timeout choices are kept)" - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopEngineView.swift:593
- [help] "Stop the run started from" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopEngineView.swift:665
- [help] "/ in this project and install its dependencies and pytest" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopEngineView.swift:725
- [help] "These stages stop the run until approved on this machine" - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopEngineView.swift:758
- [help] "Suggested commands detected in this repo" - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopEngineView.swift:1088
- [help] "Show only warnings and errors" - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopEngineView.swift:1316
- [confirmationDialog] "Run these commands on this machine?" - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopEngineView.swift:767
- [confirmationDialog] "Set up this project's Python environment?" - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopEngineView.swift:788
- [accessibilityLabel] "Suggested commands" - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopEngineView.swift:1089
- [text] "No test tooling detected in this project, so the applied template has nothing to run. Pick another template, or add a stage manually with +." - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopEngineView.swift:524
- [text] "No stages yet. Add one with + on the left, or apply a template above." - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopEngineView.swift:528
- [text] "Update available — a newer default exists for this stage." - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopEngineView.swift:589
- [text] "This runner was already busy" - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopEngineView.swift:737
- [text] "Enter a command for this stage." - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopEngineView.swift:906
- [text] "Open a project with a cloned repo to approve or run shell-command stages." - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopEngineView.swift:910
- [text] "Checked in-app after the generate stages; a failure re-runs them with the findings." - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopEngineView.swift:931
- [text] "Input (optional) — file or folder under the repo root" - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopEngineView.swift:953 (+1)
- [text] "Output (optional) — where the skill should write its result" - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopEngineView.swift:962 (+1)
- [text] "Input and output are hints included in the skill's prompt — the skill decides how to use them via its own tool calls." - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopEngineView.swift:965
- [text] "Runs the skill as a generate step each iteration; the loop's verify stages decide pass/fail." - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopEngineView.swift:976
- [text] "Re-runs the Regression sweep (fault reports + repo checks) with repair attempted on failure." - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopEngineView.swift:979
- [text] "Timeout" - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopEngineView.swift:1001
- [text] "No test/build tooling detected in this repo." - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopEngineView.swift:1055
- [text] "Could not load this run's journal record." - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopEngineView.swift:1158
- [text] "No lines match." - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopEngineView.swift:1176
- [text] "problems" - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopEngineView.swift:1311
- [stepper] "Shell" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopNewProjectDefaultsPanel.swift:56
- [stepper] "Agent" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopNewProjectDefaultsPanel.swift:58
- [text] "A project that has already been opened in the Loop keeps its own settings — these apply the first time a project's stages are detected." - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopNewProjectDefaultsPanel.swift:23
- [text] "With no check, a repair can delete the failing test and the run will report success." - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopNewProjectDefaultsPanel.swift:46
- [text] "Default stage timeouts (minutes, 0 = no limit) — used when a stage sets none" - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopNewProjectDefaultsPanel.swift:52
- [text] "Templates" - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopNewProjectDefaultsPanel.swift:66
- [textfield] "Commit message" - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopRunChangesReview.swift:392
- [help] "Re-read git status and discard loaded diffs" - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopRunChangesReview.swift:102
- [help] "You have part of this file staged. Committing here commits the whole file, including that." - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopRunChangesReview.swift:309
- [help] "git status could not be read — see the error below" - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopRunChangesReview.swift:321
- [help] "Committed, reverted, or changed back since the run" - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopRunChangesReview.swift:326
- [text] "This run worked in a different checkout than the one open now — often an isolated worktree, which is removed when the run ends. These paths were changed there, so there is nothing to review or commit here." - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopRunChangesReview.swift:110
- [text] "Read live from git against HEAD, so it reflects the working tree now — not a snapshot taken during the run." - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopRunChangesReview.swift:115
- [text] "Could not read this diff:" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopRunChangesReview.swift:265
- [text] "git reported no textual diff against HEAD (a binary file, or a mode-only change)." - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopRunChangesReview.swift:273
- [text] "Loading diff…" - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopRunChangesReview.swift:286
- [text] "elsewhere" - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopRunChangesReview.swift:297
- [text] "partly staged" - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopRunChangesReview.swift:306
- [text] "status unavailable" - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopRunChangesReview.swift:318
- [text] "no longer modified" - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopRunChangesReview.swift:323
- [text] "Commits these files only. Anything you have staged for a different commit stays staged." - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopRunChangesReview.swift:403
- [text] "of these are partly staged — committing takes the whole file, including the part you staged." (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Loop/Views/LoopRunChangesReview.swift:409
- [button] "Save as Template" - mac/Sources/LlmIdeMac/Features/Loop/Views/NewLoopWizardView.swift:84
- [button] "Create Loop" - mac/Sources/LlmIdeMac/Features/Loop/Views/NewLoopWizardView.swift:94
- [textfield] "e.g. swift test" - mac/Sources/LlmIdeMac/Features/Loop/Views/NewLoopWizardView.swift:338
- [help] "Remove this stage" - mac/Sources/LlmIdeMac/Features/Loop/Views/NewLoopWizardView.swift:302
- [help] "Blocking: a failure triggers repair and can end the run. Advisory: recorded only — use for linters and formatters." - mac/Sources/LlmIdeMac/Features/Loop/Views/NewLoopWizardView.swift:406
- [text] "No test tooling detected in this project, so this template has nothing to run. Pick another template, or add a stage manually with +." - mac/Sources/LlmIdeMac/Features/Loop/Views/NewLoopWizardView.swift:202
- [text] "No stages yet. Pick a template on the left, or add stages one at a time with +." - mac/Sources/LlmIdeMac/Features/Loop/Views/NewLoopWizardView.swift:206
- [text] "A run stops at whichever it hits first. The time budget is checked between iterations (and never during the first one), so a long iteration can overrun it; paused time is not counted." - mac/Sources/LlmIdeMac/Features/Loop/Views/NewLoopWizardView.swift:225
- [text] "No library skills found." - mac/Sources/LlmIdeMac/Features/Loop/Views/NewLoopWizardView.swift:309
- [text] "Re-runs the fault sweep (known regressions + repo checks) against this project." - mac/Sources/LlmIdeMac/Features/Loop/Views/NewLoopWizardView.swift:355
- [text] "Lists delete-candidate tests in TEST-PRUNE.md; never deletes anything." - mac/Sources/LlmIdeMac/Features/Loop/Views/NewLoopWizardView.swift:372
- [text] "Self-Heal incident triage — picks up to" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Loop/Views/NewLoopWizardView.swift:384
- [text] "SDK Adoption diff — lists unclassified Claude Agent SDK surface into" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Loop/Views/NewLoopWizardView.swift:388
- [text] "Unsupported stage kind — kept as-is in loop.json and never run." - mac/Sources/LlmIdeMac/Features/Loop/Views/NewLoopWizardView.swift:392
