## docgen: 23/65 Swift labels exact in desktop code (35%), 4 only inside a longer sentence, 38 missing

Swift files scanned: 17. Shortcuts in Swift (not machine-matched): 0.

| kind | total | missing |
|---|---|---|
| button | 10 | 5 |
| confirmationDialog | 3 | 2 |
| help | 7 | 6 |
| label | 3 | 2 |
| text | 37 | 20 |
| textfield | 4 | 2 |
| toggle | 1 | 1 |

### Missing

- [toggle] "Use the server for Doc Gen files (beta)" - mac/Sources/LlmIdeMac/Features/Generation/Views/DocGenServerStoreCard.swift:11
- [text] "Doc Gen's template and command files in a project's templates/ and commands/ folders are listed, saved and deleted through the server. Symlinked template folders are still listed from this Mac. If the server cannot answer, the Mac uses its own copy of the files. Reopen the project to apply a change." - mac/Sources/LlmIdeMac/Features/Generation/Views/DocGenServerStoreCard.swift:12
- [button] "Add" - mac/Sources/LlmIdeMac/Features/Generation/Views/DocTemplateManagerSheet.swift:163
- [button] "Save" - mac/Sources/LlmIdeMac/Features/Generation/Views/DocTemplateManagerSheet.swift:196
- [textfield] "Add section…" - mac/Sources/LlmIdeMac/Features/Generation/Views/DocTemplateManagerSheet.swift:159
- [confirmationDialog] "Delete this template?" - mac/Sources/LlmIdeMac/Features/Generation/Views/DocTemplateManagerSheet.swift:181
- [text] "Templates live in your project's `templates/` folder." - mac/Sources/LlmIdeMac/Features/Generation/Views/DocTemplateManagerSheet.swift:42
- [text] "Select a template" - mac/Sources/LlmIdeMac/Features/Generation/Views/DocTemplateManagerSheet.swift:90
- [text] "Built-in template — duplicate to customize, or open a project to edit `templates/` on disk." - mac/Sources/LlmIdeMac/Features/Generation/Views/DocTemplateManagerSheet.swift:107
- [text] "Saved as `templates/" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Generation/Views/DocTemplateManagerSheet.swift:111
- [button] "Reveal" - mac/Sources/LlmIdeMac/Features/Generation/Views/GenerationEditorPanel.swift:236
- [help] "Preview renders the markdown; Raw shows the exact text that gets saved." - mac/Sources/LlmIdeMac/Features/Generation/Views/GenerationEditorPanel.swift:157
- [text] "\" with Claude…" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Generation/Views/GenerationEditorPanel.swift:408
- [text] "Read-only" - mac/Sources/LlmIdeMac/Features/Generation/Views/GenerationEditorPanel.swift:462
- [text] "Generation Failed" - mac/Sources/LlmIdeMac/Features/Generation/Views/GenerationEditorPanel.swift:569
- [button] "Discard & Start Another" - mac/Sources/LlmIdeMac/Features/Generation/Views/GenerationPromptBar.swift:155
- [textfield] "Describe the change (e.g. \"Add a risks section\")" - mac/Sources/LlmIdeMac/Features/Generation/Views/GenerationPromptBar.swift:261
- [text] "Document ready" - mac/Sources/LlmIdeMac/Features/Generation/Views/GenerationPromptBar.swift:126
- [text] "This document has not been saved. Starting another discards it." - mac/Sources/LlmIdeMac/Features/Generation/Views/GenerationPromptBar.swift:160
- [text] "Save" - mac/Sources/LlmIdeMac/Features/Generation/Views/GenerationPromptBar.swift:211
- [text] "Apply Edit" - mac/Sources/LlmIdeMac/Features/Generation/Views/GenerationPromptBar.swift:294
- [button] "Choose…" - mac/Sources/LlmIdeMac/Features/Generation/Views/GenerationSetupSection.swift:96
- [help] "Use the project's llm-doc/generated/ folder" - mac/Sources/LlmIdeMac/Features/Generation/Views/GenerationSetupSection.swift:111
- [help] "Could not read this file" - mac/Sources/LlmIdeMac/Features/Generation/Views/GenerationSourceTree.swift:225
- [text] ") files in Library yet" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Generation/Views/GenerationSourceTree.swift:92
- [label] "Delete Template…" - mac/Sources/LlmIdeMac/Features/Generation/Views/GenerationTemplateSection.swift:210
- [label] "Delete Command" - mac/Sources/LlmIdeMac/Features/Generation/Views/GenerationTemplateSection.swift:312
- [help] "Import a .md template" - mac/Sources/LlmIdeMac/Features/Generation/Views/GenerationTemplateSection.swift:131
- [help] "Delete template" - mac/Sources/LlmIdeMac/Features/Generation/Views/GenerationTemplateSection.swift:415
- [confirmationDialog] "Delete “" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Generation/Views/GenerationTemplateSection.swift:214
- [text] "Manage" - mac/Sources/LlmIdeMac/Features/Generation/Views/GenerationTemplateSection.swift:56
- [text] "Import .md template" - mac/Sources/LlmIdeMac/Features/Generation/Views/GenerationTemplateSection.swift:148
- [text] "Select a Markdown file to use as your document template" - mac/Sources/LlmIdeMac/Features/Generation/Views/GenerationTemplateSection.swift:151
- [text] "Imports into `templates/<name>/template.md` in your project." - mac/Sources/LlmIdeMac/Features/Generation/Views/GenerationTemplateSection.swift:156
- [text] "Project" - mac/Sources/LlmIdeMac/Features/Generation/Views/GenerationTemplateSection.swift:375
- [text] "Built-in" - mac/Sources/LlmIdeMac/Features/Generation/Views/GenerationTemplateSection.swift:382
- [text] "View Image" - mac/Sources/LlmIdeMac/Features/Generation/Visual/Views/VisualCenterPanel.swift:93
- [help] "Reveal in Finder" - mac/Sources/LlmIdeMac/Features/Generation/Visual/Views/VisualView.swift:204
