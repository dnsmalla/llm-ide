## shell: 29/77 Swift labels exact in desktop code (38%), 4 only inside a longer sentence, 44 missing

Swift files scanned: 25. Shortcuts in Swift (not machine-matched): 6.

| kind | total | missing |
|---|---|---|
| accessibilityLabel | 5 | 3 |
| button | 22 | 7 |
| confirmationDialog | 1 | 0 |
| help | 7 | 4 |
| label | 9 | 3 |
| picker | 1 | 1 |
| progressview | 2 | 1 |
| section | 1 | 1 |
| text | 28 | 23 |
| textfield | 1 | 1 |

### Missing

- [label] "Couldn't Open LLM Doc Folder" - mac/Sources/LlmIdeMac/Shell/AppShell.swift:257 (+1)
- [label] "pending approval\\(count == 1 ?" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Shell/AppShell.swift:303
- [progressview] "Loading settings…" - mac/Sources/LlmIdeMac/Shell/AppShell.swift:268
- [help] "Back to projects" - mac/Sources/LlmIdeMac/Shell/AppShell.swift:282
- [help] "chat\\(count == 1 ?" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Shell/AppShell.swift:314
- [accessibilityLabel] "Back to projects" - mac/Sources/LlmIdeMac/Shell/AppShell.swift:283
- [accessibilityLabel] "pending approval\\(count == 1 ?" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Shell/AppShell.swift:315
- [text] "is currently disabled" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Shell/AppShell.swift:1331
- [text] "Crash Report" - mac/Sources/LlmIdeMac/Shell/Chrome/CrashReportBanner.swift:66
- [button] "Sign out and disconnect all accounts" - mac/Sources/LlmIdeMac/Shell/Chrome/HeaderAccountMenu.swift:58
- [text] "Signing out clears your session and local chat history. Your GitHub / GitLab tokens and saved repositories stay on this Mac unless you choose to disconnect all accounts." - mac/Sources/LlmIdeMac/Shell/Chrome/HeaderAccountMenu.swift:67
- [button] "Export Project Data…" - mac/Sources/LlmIdeMac/Shell/Chrome/ProjectSwitcher.swift:47
- [button] "Export Plans…" - mac/Sources/LlmIdeMac/Shell/Chrome/ProjectSwitcher.swift:68
- [section] "Recent" - mac/Sources/LlmIdeMac/Shell/Chrome/ProjectSwitcher.swift:25
- [textfield] "Switch project — type to filter" - mac/Sources/LlmIdeMac/Shell/Chrome/QuickSwitcherSheet.swift:33
- [text] "No other recent projects yet. Open one via the sidebar chip." - mac/Sources/LlmIdeMac/Shell/Chrome/QuickSwitcherSheet.swift:44
- [text] "No matches." - mac/Sources/LlmIdeMac/Shell/Chrome/QuickSwitcherSheet.swift:50
- [label] "Server out of date" - mac/Sources/LlmIdeMac/Shell/Chrome/StatusBar.swift:39
- [help] "Toggle Terminal  (⌃`)" - mac/Sources/LlmIdeMac/Shell/Chrome/StatusBar.swift:72
- [picker] "Graph page" - mac/Sources/LlmIdeMac/Shell/GraphSectionView.swift:54
- [accessibilityLabel] "Graph page" - mac/Sources/LlmIdeMac/Shell/GraphSectionView.swift:64
- [text] "Registration is closed on this server. Ask your admin for an account." - mac/Sources/LlmIdeMac/Shell/LoginView.swift:120
- [text] "The local server isn't running yet — start it to sign in." - mac/Sources/LlmIdeMac/Shell/LoginView.swift:189
- [text] "Starting server…" - mac/Sources/LlmIdeMac/Shell/LoginView.swift:210 (+1)
- [text] "Server is running but the API is too old — update the backend checkout, then restart." - mac/Sources/LlmIdeMac/Shell/LoginView.swift:220
- [text] "Server is running — try signing in." - mac/Sources/LlmIdeMac/Shell/LoginView.swift:230
- [text] "Start Server" - mac/Sources/LlmIdeMac/Shell/LoginView.swift:240 (+1)
- [text] "Configure the backend path in Settings → Backend first." - mac/Sources/LlmIdeMac/Shell/LoginView.swift:262 (+1)
- [text] "Can’t reach the server" - mac/Sources/LlmIdeMac/Shell/ReconnectView.swift:56
- [text] "The LLM-IDE server isn’t responding. You’re still signed in — start the server or retry." - mac/Sources/LlmIdeMac/Shell/ReconnectView.swift:59
- [text] "Server is running but the API is too old — update the backend checkout." - mac/Sources/LlmIdeMac/Shell/ReconnectView.swift:133
- [text] "Server is running — retrying…" - mac/Sources/LlmIdeMac/Shell/ReconnectView.swift:143
- [button] "Don't ask again" - mac/Sources/LlmIdeMac/Shell/Recovery/LegacyExportPromptView.swift:19
- [button] "Skip for now" - mac/Sources/LlmIdeMac/Shell/Recovery/LegacyExportPromptView.swift:21
- [button] "Export now" - mac/Sources/LlmIdeMac/Shell/Recovery/LegacyExportPromptView.swift:22
- [text] "Export legacy meetings?" - mac/Sources/LlmIdeMac/Shell/Recovery/LegacyExportPromptView.swift:12
- [text] "Meetings stored from before the new file-based system can be exported to your LLM Doc folder as .md files. This runs once." - mac/Sources/LlmIdeMac/Shell/Recovery/LegacyExportPromptView.swift:14
- [button] "Recover" - mac/Sources/LlmIdeMac/Shell/Recovery/RecoveryPromptView.swift:19
- [text] "Unfinished recording found" - mac/Sources/LlmIdeMac/Shell/Recovery/RecoveryPromptView.swift:13
- [text] "). Recover and finalize, or dismiss to leave the partial file in place." (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Shell/Recovery/RecoveryPromptView.swift:14
- [help] "How LLM-IDE works — capture, notes, projects" - mac/Sources/LlmIdeMac/Shell/Welcome/WelcomeView.swift:34
- [text] "Meeting intelligence & project control. Each project lives in its own folder — meetings, notes, plans, and code, side by side." - mac/Sources/LlmIdeMac/Shell/Welcome/WelcomeView.swift:64
- [text] "A project keeps **source/**, **llm-doc/**, and **code/** together with its own settings. Choose an empty folder to start, an existing project to resume, or a cloned code repo — LLM-IDE adds what it needs without overwriting your files." - mac/Sources/LlmIdeMac/Shell/Welcome/WelcomeView.swift:111
- [text] ". Your project folders are untouched — reopen them with “Open Folder”." (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Shell/Welcome/WelcomeView.swift:165
