## library: 27/88 Swift labels exact in desktop code (31%), 1 only inside a longer sentence, 60 missing

Swift files scanned: 36. Shortcuts in Swift (not machine-matched): 4.

| kind | total | missing |
|---|---|---|
| accessibilityLabel | 2 | 0 |
| alert | 1 | 1 |
| button | 13 | 4 |
| confirmationDialog | 1 | 1 |
| disclosuregroup | 2 | 2 |
| help | 9 | 7 |
| label | 17 | 13 |
| link | 1 | 1 |
| text | 32 | 24 |
| textfield | 10 | 7 |

### Missing

- [button] "Open Box Developer Console…" - mac/Sources/LlmIdeMac/Features/Library/Views/BoxSourceSheet.swift:99
- [textfield] "My Box folder (optional)" - mac/Sources/LlmIdeMac/Features/Library/Views/BoxSourceSheet.swift:45
- [textfield] "Box app client ID" - mac/Sources/LlmIdeMac/Features/Library/Views/BoxSourceSheet.swift:49
- [textfield] "Box folder ID" - mac/Sources/LlmIdeMac/Features/Library/Views/BoxSourceSheet.swift:94
- [help] "Remove this source and delete the stored client secret." - mac/Sources/LlmIdeMac/Features/Library/Views/BoxSourceSheet.swift:130
- [text] "Catalog unavailable — the server didn't return any connectors." - mac/Sources/LlmIdeMac/Features/Library/Views/ConnectorAddSheet.swift:22
- [text] "Removing a connector later keeps its fetched data and notes — selection controls visibility only." - mac/Sources/LlmIdeMac/Features/Library/Views/ConnectorAddSheet.swift:36
- [text] "Add a connector" - mac/Sources/LlmIdeMac/Features/Library/Views/ConnectorAddSheet.swift:48
- [text] "Connectors you add appear in Settings → Connections. Meetings and Email are always available and aren't listed here." - mac/Sources/LlmIdeMac/Features/Library/Views/ConnectorAddSheet.swift:49
- [text] "soon" - mac/Sources/LlmIdeMac/Features/Library/Views/ConnectorAddSheet.swift:98
- [link] "Provider documentation" - mac/Sources/LlmIdeMac/Features/Library/Views/ConnectorDetailView.swift:92
- [text] "Connector not found — it may have been removed from the catalog." - mac/Sources/LlmIdeMac/Features/Library/Views/ConnectorDetailView.swift:45
- [text] "Configure credentials and what to ingest in Settings → Connections." - mac/Sources/LlmIdeMac/Features/Library/Views/ConnectorDetailView.swift:96
- [text] "Selected connectors show a card in Settings → Connections. This one's fetch pipeline lands in an upcoming update — nothing is ingested yet." - mac/Sources/LlmIdeMac/Features/Library/Views/ConnectorDetailView.swift:99
- [text] "Not currently added." - mac/Sources/LlmIdeMac/Features/Library/Views/ConnectorDetailView.swift:113
- [text] "Removing hides this connector's card. Files, notes, and credentials it already produced are kept." - mac/Sources/LlmIdeMac/Features/Library/Views/ConnectorDetailView.swift:116
- [button] "Open Google App Passwords…" - mac/Sources/LlmIdeMac/Features/Library/Views/EmailSourceSheet.swift:172
- [textfield] "My inbox (optional)" - mac/Sources/LlmIdeMac/Features/Library/Views/EmailSourceSheet.swift:88
- [textfield] "you@example.com" - mac/Sources/LlmIdeMac/Features/Library/Views/EmailSourceSheet.swift:127
- [textfield] "sender@example.com (optional)" - mac/Sources/LlmIdeMac/Features/Library/Views/EmailSourceSheet.swift:234
- [disclosuregroup] "Advanced: IMAP settings, App Password, or your own Google OAuth client" - mac/Sources/LlmIdeMac/Features/Library/Views/EmailSourceSheet.swift:109
- [help] "Remove this source and delete the stored credentials." - mac/Sources/LlmIdeMac/Features/Library/Views/EmailSourceSheet.swift:264
- [text] "Your own Google OAuth client" - mac/Sources/LlmIdeMac/Features/Library/Views/EmailSourceSheet.swift:134
- [confirmationDialog] "\" from the library?" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Library/Views/LibraryFileRow.swift:34
- [text] "The file will be deleted from the project folder. Files in external referenced folders are never deleted." - mac/Sources/LlmIdeMac/Features/Library/Views/LibraryFileRow.swift:43
- [label] "Re-summarize" - mac/Sources/LlmIdeMac/Features/Library/Views/LibraryRow.swift:105 (+1)
- [label] "Remove from List" - mac/Sources/LlmIdeMac/Features/Library/Views/LibraryRow.swift:125
- [text] "Summarizing…" - mac/Sources/LlmIdeMac/Features/Library/Views/LibraryRow.swift:38
- [button] "Retry" - mac/Sources/LlmIdeMac/Features/Library/Views/LibraryView.swift:667 (+3)
- [label] "Add File" - mac/Sources/LlmIdeMac/Features/Library/Views/LibraryView.swift:574
- [label] "Add Folder" - mac/Sources/LlmIdeMac/Features/Library/Views/LibraryView.swift:579
- [label] "Connect a source…" - mac/Sources/LlmIdeMac/Features/Library/Views/LibraryView.swift:592
- [label] "Reveal Folder in Finder" - mac/Sources/LlmIdeMac/Features/Library/Views/LibraryView.swift:598
- [label] "Couldn't Load Library" - mac/Sources/LlmIdeMac/Features/Library/Views/LibraryView.swift:663
- [label] "Add from catalog…" - mac/Sources/LlmIdeMac/Features/Library/Views/LibraryView.swift:777
- [label] "Configure in Settings…" - mac/Sources/LlmIdeMac/Features/Library/Views/LibraryView.swift:786
- [label] "Remove All" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Library/Views/LibraryView.swift:874
- [help] "Add a connector" - mac/Sources/LlmIdeMac/Features/Library/Views/LibraryView.swift:797
- [alert] "Connector" - mac/Sources/LlmIdeMac/Features/Library/Views/LibraryView.swift:799
- [text] "Press ⌘N or click **Record** to capture your first meeting." - mac/Sources/LlmIdeMac/Features/Library/Views/LibraryView.swift:651
- [label] "Select a Meeting" - mac/Sources/LlmIdeMac/Features/Library/Views/MeetingDetailView.swift:62
- [label] "Couldn't Open Meeting" - mac/Sources/LlmIdeMac/Features/Library/Views/MeetingDetailView.swift:77
- [label] "Summarize" - mac/Sources/LlmIdeMac/Features/Library/Views/MeetingDetailView.swift:142
- [help] "Re-summarize this meeting (⌘R)" - mac/Sources/LlmIdeMac/Features/Library/Views/MeetingDetailView.swift:192
- [help] "Export as Markdown (⌘E)" - mac/Sources/LlmIdeMac/Features/Library/Views/MeetingDetailView.swift:199
- [text] "Choose a meeting from the list to view its summary and transcript." - mac/Sources/LlmIdeMac/Features/Library/Views/MeetingDetailView.swift:64
- [text] "Generating summary…" - mac/Sources/LlmIdeMac/Features/Library/Views/MeetingDetailView.swift:120
- [text] "Transcript available — no summary yet." - mac/Sources/LlmIdeMac/Features/Library/Views/MeetingDetailView.swift:136
- [text] "Auto-capture when a meeting app is frontmost" - mac/Sources/LlmIdeMac/Features/Library/Views/Settings/ConnectionsSettingsSection.swift:210
- [text] "Not installed" - mac/Sources/LlmIdeMac/Features/Library/Views/Settings/ConnectionsSettingsSection.swift:225
- [text] "Enable Auto-Tasks in Workspace" - mac/Sources/LlmIdeMac/Features/Library/Views/Settings/ConnectionsSettingsSection.swift:229
- [text] "Poll interval" - mac/Sources/LlmIdeMac/Features/Library/Views/Settings/ConnectionsSettingsSection.swift:243
- [text] "ms — how often the scraper reads each meeting app's caption panel. Applies on next launch." (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Library/Views/Settings/ConnectionsSettingsSection.swift:246
- [text] "Pipeline lands in an upcoming update — your selection is saved." - mac/Sources/LlmIdeMac/Features/Library/Views/Settings/ConnectionsSettingsSection.swift:434
- [button] "Select None" - mac/Sources/LlmIdeMac/Features/Library/Views/SlackSourceSheet.swift:209
- [textfield] "My workspace (optional)" - mac/Sources/LlmIdeMac/Features/Library/Views/SlackSourceSheet.swift:65
- [disclosuregroup] "Advanced: paste a token manually" - mac/Sources/LlmIdeMac/Features/Library/Views/SlackSourceSheet.swift:87
- [help] "Remove this source and delete the stored Slack credentials." - mac/Sources/LlmIdeMac/Features/Library/Views/SlackSourceSheet.swift:156
- [help] "Previously selected — not in the current channel list (may need a broader Slack permission)." - mac/Sources/LlmIdeMac/Features/Library/Views/SlackSourceSheet.swift:253
- [text] "No detailed notes yet." - mac/Sources/LlmIdeMac/Features/Library/Views/SummarySections.swift:127
