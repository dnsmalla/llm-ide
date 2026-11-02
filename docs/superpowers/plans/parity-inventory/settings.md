## settings: 76/186 Swift labels exact in desktop code (41%), 10 only inside a longer sentence, 100 missing

Swift files scanned: 27. Shortcuts in Swift (not machine-matched): 3.

| kind | total | missing |
|---|---|---|
| accessibilityLabel | 26 | 16 |
| button | 44 | 19 |
| confirmationDialog | 6 | 5 |
| help | 6 | 6 |
| label | 2 | 1 |
| picker | 8 | 3 |
| stepper | 2 | 1 |
| text | 79 | 41 |
| textfield | 5 | 4 |
| toggle | 8 | 4 |

### Missing

- [button] "Turn off at next launch" - mac/Sources/LlmIdeMac/Features/Settings/Views/AgentHistorySettingsCard.swift:152
- [button] "Done" - mac/Sources/LlmIdeMac/Features/Settings/Views/AgentHistorySettingsCard.swift:271
- [picker] "Chat archive mode" - mac/Sources/LlmIdeMac/Features/Settings/Views/AgentHistorySettingsCard.swift:124
- [picker] "Age" - mac/Sources/LlmIdeMac/Features/Settings/Views/AgentHistorySettingsCard.swift:293
- [accessibilityLabel] "Chat archive mode" - mac/Sources/LlmIdeMac/Features/Settings/Views/AgentHistorySettingsCard.swift:134
- [accessibilityLabel] "Which history to delete by age" - mac/Sources/LlmIdeMac/Features/Settings/Views/AgentHistorySettingsCard.swift:300
- [text] "Couldn't load agent history:" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Settings/Views/AgentHistorySettingsCard.swift:24
- [text] "Last cleaned" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Settings/Views/AgentHistorySettingsCard.swift:73
- [text] "rows were dropped by the write queue since the store was created." (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Settings/Views/AgentHistorySettingsCard.swift:98
- [text] "The store was reset after damage on" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Settings/Views/AgentHistorySettingsCard.swift:101
- [text] "The agent history store is down. Restart the backend to reopen it." - mac/Sources/LlmIdeMac/Features/Settings/Views/AgentHistorySettingsCard.swift:109
- [text] "This session is still running with" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Settings/Views/AgentHistorySettingsCard.swift:139
- [text] "Raw rows" - mac/Sources/LlmIdeMac/Features/Settings/Views/AgentHistorySettingsCard.swift:194
- [text] "Everything" - mac/Sources/LlmIdeMac/Features/Settings/Views/AgentHistorySettingsCard.swift:195
- [text] "This cannot be undone. Runs still in progress are kept." - mac/Sources/LlmIdeMac/Features/Settings/Views/AgentHistorySettingsCard.swift:344
- [button] "Update and restart the backend" - mac/Sources/LlmIdeMac/Features/Settings/Views/AgentSdkSettingsSection.swift:104
- [confirmationDialog] "Restart the backend?" - mac/Sources/LlmIdeMac/Features/Settings/Views/AgentSdkSettingsSection.swift:109
- [text] "Couldn't check for updates:" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Settings/Views/AgentSdkSettingsSection.swift:46
- [text] "Updating — downloading can take a few minutes…" - mac/Sources/LlmIdeMac/Features/Settings/Views/AgentSdkSettingsSection.swift:74
- [text] "The backend restarts when the update is installed, which stops any chat still running. The update is refused while a chat turn is in progress." - mac/Sources/LlmIdeMac/Features/Settings/Views/AgentSdkSettingsSection.swift:107
- [text] "Any chat reply or Loop run still in progress is stopped and has to be started again." - mac/Sources/LlmIdeMac/Features/Settings/Views/AgentSdkSettingsSection.swift:113
- [button] "Relaunch Now" - mac/Sources/LlmIdeMac/Features/Settings/Views/BackendSettingsSection.swift:66
- [button] "Save paths" - mac/Sources/LlmIdeMac/Features/Settings/Views/BackendSettingsSection.swift:175
- [toggle] "Auto-scroll" - mac/Sources/LlmIdeMac/Features/Settings/Views/BackendSettingsSection.swift:296
- [text] "Relaunch LLM-IDE to connect to the new server." - mac/Sources/LlmIdeMac/Features/Settings/Views/BackendSettingsSection.swift:64
- [text] "· pid" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Settings/Views/BackendSettingsSection.swift:243
- [text] "lines" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Settings/Views/BackendSettingsSection.swift:292
- [button] "Rebuild" - mac/Sources/LlmIdeMac/Features/Settings/Views/FeatureProfileSettingsView.swift:337
- [button] "Restart & Install" - mac/Sources/LlmIdeMac/Features/Settings/Views/FeatureProfileSettingsView.swift:341
- [button] "Apply & Rebuild (remove disabled code)" - mac/Sources/LlmIdeMac/Features/Settings/Views/FeatureProfileSettingsView.swift:372
- [picker] "Home opens" - mac/Sources/LlmIdeMac/Features/Settings/Views/FeatureProfileSettingsView.swift:99
- [confirmationDialog] "Rebuild and replace this app?" - mac/Sources/LlmIdeMac/Features/Settings/Views/FeatureProfileSettingsView.swift:285
- [help] "Close help" - mac/Sources/LlmIdeMac/Features/Settings/Views/HelpGuideView.swift:72
- [text] "No graph or memory generated for this project yet. In builds that include Code Graph, open that view and generate a Code Graph / InfiniteBrain to populate it." - mac/Sources/LlmIdeMac/Features/Settings/Views/MemorySettingsSection.swift:20
- [text] "Agent memory files (system/memory)" - mac/Sources/LlmIdeMac/Features/Settings/Views/MemorySettingsSection.swift:33
- [button] "Make Standard the default" - mac/Sources/LlmIdeMac/Features/Settings/Views/ModelRoutingSection.swift:274
- [help] "New chats and every role on this Mac left on Standard use this tier" - mac/Sources/LlmIdeMac/Features/Settings/Views/ModelRoutingSection.swift:157
- [text] "(catalog)" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Settings/Views/ModelRoutingSection.swift:186
- [text] "(unavailable)" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Settings/Views/ModelRoutingSection.swift:193
- [button] "Turn on the session router" - mac/Sources/LlmIdeMac/Features/Settings/Views/ModelRoutingSwitches.swift:51
- [accessibilityLabel] "Move" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Settings/Views/ModelRoutingSwitches.swift:120
- [accessibilityLabel] ") down" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Settings/Views/ModelRoutingSwitches.swift:123
- [text] "Couldn't load the provider settings:" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Settings/Views/ModelRoutingSwitches.swift:34
- [help] "Delete the downloaded copy. Diagrams show as code until it is installed again." - mac/Sources/LlmIdeMac/Features/Settings/Views/OptionalComponentsSettingsSection.swift:39
- [text] "Diagrams (mermaid" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Settings/Views/OptionalComponentsSettingsSection.swift:27
- [text] "Show menu-bar chat icon" - mac/Sources/LlmIdeMac/Features/Settings/Views/PreferencesSettingsSection.swift:49
- [text] "\" button closes the whole app — use this to hide just the icon, and to bring it back without restarting." (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Settings/Views/PreferencesSettingsSection.swift:52
- [text] "Claude-format plugins are loaded by the agent engine itself, which then runs their hooks (and background monitors, language servers and bin/ commands) as their author wrote them. Their skills, commands and agents are offered through LLM-IDE's own paths either way. Turn this off to fall back to LLM-IDE's own hook handling. Either way, those parts only run once you trust the plugin, and its MCP servers still need your consent." - mac/Sources/LlmIdeMac/Features/Settings/Views/PreferencesSettingsSection.swift:110
- [toggle] "This is on my own network (localhost or a private address)" - mac/Sources/LlmIdeMac/Features/Settings/Views/ProviderForms.swift:81
- [textfield] "Base URL (https://host/v1)" - mac/Sources/LlmIdeMac/Features/Settings/Views/ProviderForms.swift:77
- [textfield] "Short name (letters and digits, optional; names a second endpoint)" - mac/Sources/LlmIdeMac/Features/Settings/Views/ProviderForms.swift:79
- [textfield] "glm-4, glm-3.5-turbo" - mac/Sources/LlmIdeMac/Features/Settings/Views/ProviderForms.swift:195
- [accessibilityLabel] "Connection type" - mac/Sources/LlmIdeMac/Features/Settings/Views/ProviderForms.swift:26
- [accessibilityLabel] "Catalog provider" - mac/Sources/LlmIdeMac/Features/Settings/Views/ProviderForms.swift:74
- [accessibilityLabel] "Remove model" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Settings/Views/ProviderForms.swift:206
- [text] "Z.AI GLM: https://api.z.ai/api/anthropic · DeepSeek: https://api.deepseek.com/anthropic · Ollama: http://localhost:11434. The Claude engine runs the provider through this URL." - mac/Sources/LlmIdeMac/Features/Settings/Views/ProviderForms.swift:181
- [text] "This URL uses plain http to a non-local host: your API key would be sent unencrypted. Use https." - mac/Sources/LlmIdeMac/Features/Settings/Views/ProviderForms.swift:213
- [button] "Discard unreadable list (backup kept)" - mac/Sources/LlmIdeMac/Features/Settings/Views/ProvidersSection.swift:49
- [button] "Discard (backup kept)" - mac/Sources/LlmIdeMac/Features/Settings/Views/ProvidersSection.swift:99
- [button] "Save URL" - mac/Sources/LlmIdeMac/Features/Settings/Views/ProvidersSection.swift:243
- [button] "Move to catalog" - mac/Sources/LlmIdeMac/Features/Settings/Views/ProvidersSection.swift:289
- [button] "Clear key" - mac/Sources/LlmIdeMac/Features/Settings/Views/ProvidersSection.swift:295
- [toggle] "Has tools" - mac/Sources/LlmIdeMac/Features/Settings/Views/ProvidersSection.swift:369
- [textfield] "Base URL, e.g. https://openrouter.ai/api/v1" - mac/Sources/LlmIdeMac/Features/Settings/Views/ProvidersSection.swift:240
- [label] "Add provider" - mac/Sources/LlmIdeMac/Features/Settings/Views/ProvidersSection.swift:64
- [help] "Confirm this provider's CLI is installed; your CLI login (subscription) is used when it runs, no key needed" - mac/Sources/LlmIdeMac/Features/Settings/Views/ProvidersSection.swift:276
- [help] "Copy this entry into the catalog. The key is copied on the server; the old entry is kept." - mac/Sources/LlmIdeMac/Features/Settings/Views/ProvidersSection.swift:291
- [help] "Mark this model as able (or not) to call tools. Your choice overrides the catalog." - mac/Sources/LlmIdeMac/Features/Settings/Views/ProvidersSection.swift:373
- [confirmationDialog] "Discard the unreadable provider list?" - mac/Sources/LlmIdeMac/Features/Settings/Views/ProvidersSection.swift:97
- [accessibilityLabel] "API key stored" - mac/Sources/LlmIdeMac/Features/Settings/Views/ProvidersSection.swift:214
- [accessibilityLabel] "API key missing" - mac/Sources/LlmIdeMac/Features/Settings/Views/ProvidersSection.swift:216
- [accessibilityLabel] "API key for" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Settings/Views/ProvidersSection.swift:254
- [accessibilityLabel] "Save key for" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Settings/Views/ProvidersSection.swift:262
- [accessibilityLabel] "Check the CLI for" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Settings/Views/ProvidersSection.swift:277
- [accessibilityLabel] "\\(showModels ?" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Settings/Views/ProvidersSection.swift:281
- [accessibilityLabel] "to the catalog" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Settings/Views/ProvidersSection.swift:292
- [accessibilityLabel] "Clear the key for" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Settings/Views/ProvidersSection.swift:297
- [accessibilityLabel] "has tools" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Settings/Views/ProvidersSection.swift:374
- [text] ". Entries stored on this Mac are shown below; one that is also connected in the catalog may appear twice until it loads." (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Settings/Views/ProvidersSection.swift:34
- [text] "The custom provider list is unreadable (a backup was kept). Adding, editing and deleting custom providers is off so the stored list is not overwritten." - mac/Sources/LlmIdeMac/Features/Settings/Views/ProvidersSection.swift:46
- [text] "Its stored API key is removed too. Other entries are not affected." - mac/Sources/LlmIdeMac/Features/Settings/Views/ProvidersSection.swift:95
- [text] "A copy is saved first. Your custom providers will need to be re-added from that backup." - mac/Sources/LlmIdeMac/Features/Settings/Views/ProvidersSection.swift:102
- [text] "An older key for this provider is also stored. It is kept, not deleted." - mac/Sources/LlmIdeMac/Features/Settings/Views/ProvidersSection.swift:158
- [button] "Discard" - mac/Sources/LlmIdeMac/Features/Settings/Views/SelfHealProposalSheet.swift:33 (+1)
- [button] "Apply to this checkout" - mac/Sources/LlmIdeMac/Features/Settings/Views/SelfHealProposalSheet.swift:46
- [confirmationDialog] "Discard this proposal?" - mac/Sources/LlmIdeMac/Features/Settings/Views/SelfHealProposalSheet.swift:34
- [text] "Self-Heal proposal" - mac/Sources/LlmIdeMac/Features/Settings/Views/SelfHealProposalSheet.swift:22
- [text] "Its worktree and the changes in it are deleted. This cannot be undone." - mac/Sources/LlmIdeMac/Features/Settings/Views/SelfHealProposalSheet.swift:42
- [button] "Review…" - mac/Sources/LlmIdeMac/Features/Settings/Views/SelfHealSettingsSection.swift:30
- [button] "Ignore" - mac/Sources/LlmIdeMac/Features/Settings/Views/SelfHealSettingsSection.swift:68
- [toggle] "Record errors and propose fixes" - mac/Sources/LlmIdeMac/Features/Settings/Views/SelfHealSettingsSection.swift:16
- [stepper] "Incidents per scheduled run:" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Settings/Views/SelfHealSettingsSection.swift:17
- [text] "The Self-Heal loop runs on the Loop schedule, fixes in an isolated worktree, and never changes this checkout until you apply a proposal." - mac/Sources/LlmIdeMac/Features/Settings/Views/SelfHealSettingsSection.swift:18
- [text] "Proposed fix ·" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Settings/Views/SelfHealSettingsSection.swift:27
- [text] "No incidents recorded." - mac/Sources/LlmIdeMac/Features/Settings/Views/SelfHealSettingsSection.swift:37
- [text] "To turn it on, run `rtk init -g` in Terminal and restart Claude Code. Note: rtk then lets the commands it rewrites run without asking you, including `git push`." - mac/Sources/LlmIdeMac/Features/Settings/Views/TokenSavingSettingsSection.swift:34
- [confirmationDialog] "Revoke every tool permission?" - mac/Sources/LlmIdeMac/Features/Settings/Views/ToolApprovalsSettingsSection.swift:112
- [text] "Allowed" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Settings/Views/ToolApprovalsSettingsSection.swift:138
- [text] "Check for updates automatically" - mac/Sources/LlmIdeMac/Features/Settings/Views/UpdatesSettingsSection.swift:45
- [text] "Bundle ID" - mac/Sources/LlmIdeMac/Features/Settings/Views/UpdatesSettingsSection.swift:87
