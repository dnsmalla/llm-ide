## extensions: 50/204 Swift labels exact in desktop code (25%), 8 only inside a longer sentence, 146 missing

Swift files scanned: 35. Shortcuts in Swift (not machine-matched): 3.

| kind | total | missing |
|---|---|---|
| accessibilityLabel | 16 | 11 |
| alert | 4 | 2 |
| button | 31 | 17 |
| confirmationDialog | 4 | 4 |
| help | 12 | 9 |
| label | 29 | 18 |
| link | 1 | 1 |
| menu | 3 | 3 |
| picker | 2 | 0 |
| progressview | 2 | 2 |
| section | 1 | 0 |
| text | 82 | 68 |
| textfield | 13 | 10 |
| toggle | 4 | 1 |

### Missing

- [button] "Retry" - mac/Sources/LlmIdeMac/Features/Extensions/Views/ClaudePluginImportSheet.swift:92 (+5)
- [button] "Import" - mac/Sources/LlmIdeMac/Features/Extensions/Views/ClaudePluginImportSheet.swift:268 (+1)
- [textfield] "Filter plugins\\u{2026}" - mac/Sources/LlmIdeMac/Features/Extensions/Views/ClaudePluginImportSheet.swift:59 (+1)
- [progressview] "Scanning Claude Code plugins\\u{2026}" - mac/Sources/LlmIdeMac/Features/Extensions/Views/ClaudePluginImportSheet.swift:82
- [text] "Import from Claude Code" - mac/Sources/LlmIdeMac/Features/Extensions/Views/ClaudePluginImportSheet.swift:121
- [text] "Browse and import plugins from your Claude Code installation" - mac/Sources/LlmIdeMac/Features/Extensions/Views/ClaudePluginImportSheet.swift:123
- [text] "\\u{00B7}" - mac/Sources/LlmIdeMac/Features/Extensions/Views/ClaudePluginImportSheet.swift:196 (+5)
- [progressview] "Scanning Codex plugins\\u{2026}" - mac/Sources/LlmIdeMac/Features/Extensions/Views/CodexPluginImportSheet.swift:81
- [text] "Import from Codex" - mac/Sources/LlmIdeMac/Features/Extensions/Views/CodexPluginImportSheet.swift:120
- [text] "Browse and import plugins from your Codex CLI installation" - mac/Sources/LlmIdeMac/Features/Extensions/Views/CodexPluginImportSheet.swift:122
- [button] "Trust and allow its MCP servers" - mac/Sources/LlmIdeMac/Features/Extensions/Views/ExtensionTrustSettingsCards.swift:55
- [toggle] "Trusted" - mac/Sources/LlmIdeMac/Features/Extensions/Views/ExtensionTrustSettingsCards.swift:32
- [label] "Enforcement is off on this server, so every folder behaves as trusted. The switches below are saved but have no effect until the operator turns it back on." - mac/Sources/LlmIdeMac/Features/Extensions/Views/ExtensionTrustSettingsCards.swift:16
- [confirmationDialog] "Trust this folder?" - mac/Sources/LlmIdeMac/Features/Extensions/Views/ExtensionTrustSettingsCards.swift:51
- [accessibilityLabel] "Trust" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Extensions/Views/ExtensionTrustSettingsCards.swift:38
- [accessibilityLabel] "Source to allow" - mac/Sources/LlmIdeMac/Features/Extensions/Views/ExtensionTrustSettingsCards.swift:89
- [text] "Your additions" - mac/Sources/LlmIdeMac/Features/Extensions/Views/ExtensionTrustSettingsCards.swift:106
- [button] "Install from URL" - mac/Sources/LlmIdeMac/Features/Extensions/Views/ExtensionsCatalogView.swift:171
- [button] "Show in Installed" - mac/Sources/LlmIdeMac/Features/Extensions/Views/ExtensionsCatalogView.swift:411
- [textfield] "Search the cached catalog" - mac/Sources/LlmIdeMac/Features/Extensions/Views/ExtensionsCatalogView.swift:430
- [label] "The extension catalog is off on this server (LLMIDE_EXT_CATALOG=off). Install, update and refresh are unavailable; installed items can still be viewed." - mac/Sources/LlmIdeMac/Features/Extensions/Views/ExtensionsCatalogView.swift:103
- [label] "The installed record could not be read, so this list may be incomplete. Nothing was changed." - mac/Sources/LlmIdeMac/Features/Extensions/Views/ExtensionsCatalogView.swift:133
- [link] "Open repository" - mac/Sources/LlmIdeMac/Features/Extensions/Views/ExtensionsCatalogView.swift:519
- [help] "Asks GitHub for the newest commit of each installed item. Downloads nothing." - mac/Sources/LlmIdeMac/Features/Extensions/Views/ExtensionsCatalogView.swift:127
- [help] "Verifies the stored files and re-downloads them at the pinned commit if they are damaged." - mac/Sources/LlmIdeMac/Features/Extensions/Views/ExtensionsCatalogView.swift:253
- [help] "Fetches the indexes from GitHub and the MCP registry (user-initiated; cached for 6 hours)." - mac/Sources/LlmIdeMac/Features/Extensions/Views/ExtensionsCatalogView.swift:447
- [confirmationDialog] "Roll back \\(model.pendingRollback?.name ??" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Extensions/Views/ExtensionsCatalogView.swift:47
- [confirmationDialog] "Remove \\(model.pendingUninstall?.name ??" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Extensions/Views/ExtensionsCatalogView.swift:57
- [confirmationDialog] "Install \\(model.pendingBrowseInstall?.name ??" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Extensions/Views/ExtensionsCatalogView.swift:455
- [accessibilityLabel] "Extensions view" - mac/Sources/LlmIdeMac/Features/Extensions/Views/ExtensionsCatalogView.swift:81
- [accessibilityLabel] "member" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Extensions/Views/ExtensionsCatalogView.swift:279
- [accessibilityLabel] "GitHub repository URL" - mac/Sources/LlmIdeMac/Features/Extensions/Views/ExtensionsCatalogView.swift:351
- [accessibilityLabel] "Folder inside the repository, optional" - mac/Sources/LlmIdeMac/Features/Extensions/Views/ExtensionsCatalogView.swift:355
- [accessibilityLabel] "Dismiss install result" - mac/Sources/LlmIdeMac/Features/Extensions/Views/ExtensionsCatalogView.swift:387
- [accessibilityLabel] "Search the cached catalog" - mac/Sources/LlmIdeMac/Features/Extensions/Views/ExtensionsCatalogView.swift:432
- [accessibilityLabel] "Filter by kind" - mac/Sources/LlmIdeMac/Features/Extensions/Views/ExtensionsCatalogView.swift:439
- [accessibilityLabel] "Allow" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Extensions/Views/ExtensionsCatalogView.swift:573
- [accessibilityLabel] "Extensions: browse and manage" - mac/Sources/LlmIdeMac/Features/Extensions/Views/ExtensionsCatalogView.swift:681
- [text] "Deletes the item, its switches and every stored version for your account." - mac/Sources/LlmIdeMac/Features/Extensions/Views/ExtensionsCatalogView.swift:65
- [text] "Couldn't read the installed list:" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Extensions/Views/ExtensionsCatalogView.swift:139
- [text] "Nothing installed from the catalog yet" - mac/Sources/LlmIdeMac/Features/Extensions/Views/ExtensionsCatalogView.swift:166
- [text] "Browse the cached catalog or install from a GitHub URL. Installed items stay off until you switch them on." - mac/Sources/LlmIdeMac/Features/Extensions/Views/ExtensionsCatalogView.swift:167
- [text] "What it can do" - mac/Sources/LlmIdeMac/Features/Extensions/Views/ExtensionsCatalogView.swift:283
- [text] "Scan warnings (advisory, not a safety verdict)" - mac/Sources/LlmIdeMac/Features/Extensions/Views/ExtensionsCatalogView.swift:290
- [text] ") more" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Extensions/Views/ExtensionsCatalogView.swift:331
- [text] "Install from a GitHub URL" - mac/Sources/LlmIdeMac/Features/Extensions/Views/ExtensionsCatalogView.swift:346
- [text] "Only https://github.com/owner/repo is accepted, and only repositories on the server's allowed list. Installing downloads the repository at one pinned commit and scans it. Nothing is run, and the item stays off until you switch it on." - mac/Sources/LlmIdeMac/Features/Extensions/Views/ExtensionsCatalogView.swift:347
- [text] ") pinned at" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Extensions/Views/ExtensionsCatalogView.swift:389
- [text] "The scan found nothing to warn about (it is a heuristic, not a verdict)." - mac/Sources/LlmIdeMac/Features/Extensions/Views/ExtensionsCatalogView.swift:396
- [text] "Couldn't read the catalog:" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Extensions/Views/ExtensionsCatalogView.swift:471
- [text] ". Narrow the search to see more." (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Extensions/Views/ExtensionsCatalogView.swift:482
- [text] "Indexes" - mac/Sources/LlmIdeMac/Features/Extensions/Views/ExtensionsCatalogView.swift:538
- [text] "Switching it on lets the following run on this Mac, for the pinned commit" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Extensions/Views/ExtensionsCatalogView.swift:562
- [text] "The list is truncated." - mac/Sources/LlmIdeMac/Features/Extensions/Views/ExtensionsCatalogView.swift:626
- [text] "No new warnings (advisory heuristic)." - mac/Sources/LlmIdeMac/Features/Extensions/Views/ExtensionsCatalogView.swift:630
- [text] "It is on now. It will be switched off after the update unless you consent to the code it can run." - mac/Sources/LlmIdeMac/Features/Extensions/Views/ExtensionsCatalogView.swift:636
- [text] "Browse & manage" - mac/Sources/LlmIdeMac/Features/Extensions/Views/ExtensionsCatalogView.swift:676
- [button] "Catalog unavailable" - mac/Sources/LlmIdeMac/Features/Extensions/Views/ExtensionsLibrarySections.swift:375
- [button] "No servers found in ~/.claude.json" - mac/Sources/LlmIdeMac/Features/Extensions/Views/ExtensionsLibrarySections.swift:398
- [button] "Rescan" - mac/Sources/LlmIdeMac/Features/Extensions/Views/ExtensionsLibrarySections.swift:407 (+1)
- [button] "No servers found in ~/.codex/config.toml" - mac/Sources/LlmIdeMac/Features/Extensions/Views/ExtensionsLibrarySections.swift:411
- [button] "Add manually…" - mac/Sources/LlmIdeMac/Features/Extensions/Views/ExtensionsLibrarySections.swift:423
- [menu] "Add from catalog…" - mac/Sources/LlmIdeMac/Features/Extensions/Views/ExtensionsLibrarySections.swift:373
- [menu] "Add from Claude Code…" - mac/Sources/LlmIdeMac/Features/Extensions/Views/ExtensionsLibrarySections.swift:396
- [menu] "Add from Codex…" - mac/Sources/LlmIdeMac/Features/Extensions/Views/ExtensionsLibrarySections.swift:409
- [label] "Install from .zip…" - mac/Sources/LlmIdeMac/Features/Extensions/Views/ExtensionsLibrarySections.swift:63
- [label] "Install from Git URL…" - mac/Sources/LlmIdeMac/Features/Extensions/Views/ExtensionsLibrarySections.swift:66
- [label] "Add marketplace…" - mac/Sources/LlmIdeMac/Features/Extensions/Views/ExtensionsLibrarySections.swift:69
- [label] "Import from Claude Code…" - mac/Sources/LlmIdeMac/Features/Extensions/Views/ExtensionsLibrarySections.swift:72
- [label] "Import from Codex…" - mac/Sources/LlmIdeMac/Features/Extensions/Views/ExtensionsLibrarySections.swift:75
- [label] "Update all (" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Extensions/Views/ExtensionsLibrarySections.swift:90
- [label] "Reveal plugin folder" - mac/Sources/LlmIdeMac/Features/Extensions/Views/ExtensionsLibrarySections.swift:97
- [label] "Check for plugin updates" - mac/Sources/LlmIdeMac/Features/Extensions/Views/ExtensionsLibrarySections.swift:100
- [label] "Reload from disk" - mac/Sources/LlmIdeMac/Features/Extensions/Views/ExtensionsLibrarySections.swift:105
- [label] "Add LLM source…" - mac/Sources/LlmIdeMac/Features/Extensions/Views/ExtensionsLibrarySections.swift:261
- [help] "Add an LLM source" - mac/Sources/LlmIdeMac/Features/Extensions/Views/ExtensionsLibrarySections.swift:275
- [help] "Add an MCP plugin" - mac/Sources/LlmIdeMac/Features/Extensions/Views/ExtensionsLibrarySections.swift:434
- [alert] "Plugin install" - mac/Sources/LlmIdeMac/Features/Extensions/Views/ExtensionsLibrarySections.swift:155
- [alert] "Plugin already installed" - mac/Sources/LlmIdeMac/Features/Extensions/Views/ExtensionsLibrarySections.swift:163
- [text] "Couldn't read the plugin list:" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Extensions/Views/ExtensionsLibrarySections.swift:21
- [text] "A plugin with this name is already installed. Replace it with this version?" - mac/Sources/LlmIdeMac/Features/Extensions/Views/ExtensionsLibrarySections.swift:176
- [button] "Choose…" - mac/Sources/LlmIdeMac/Features/Extensions/Views/LlmSourceAddSheet.swift:54
- [textfield] "main" - mac/Sources/LlmIdeMac/Features/Extensions/Views/LlmSourceAddSheet.swift:44 (+2)
- [textfield] "/path/to/repo" - mac/Sources/LlmIdeMac/Features/Extensions/Views/LlmSourceAddSheet.swift:52
- [textfield] "Display name" - mac/Sources/LlmIdeMac/Features/Extensions/Views/LlmSourceAddSheet.swift:60
- [text] "Add LLM source" - mac/Sources/LlmIdeMac/Features/Extensions/Views/LlmSourceAddSheet.swift:25
- [text] "Public HTTPS URL only. Cloned shallowly on the server." - mac/Sources/LlmIdeMac/Features/Extensions/Views/LlmSourceAddSheet.swift:33
- [text] "Git URL" - mac/Sources/LlmIdeMac/Features/Extensions/Views/LlmSourceAddSheet.swift:36 (+2)
- [text] "Branch or tag (optional)" - mac/Sources/LlmIdeMac/Features/Extensions/Views/LlmSourceAddSheet.swift:43 (+2)
- [text] "A local directory containing registry.yaml; .claude-plugin/plugin.json + skills/; an agents/ dir; or a hooks manifest." - mac/Sources/LlmIdeMac/Features/Extensions/Views/LlmSourceAddSheet.swift:49
- [text] "Name (optional)" - mac/Sources/LlmIdeMac/Features/Extensions/Views/LlmSourceAddSheet.swift:59
- [button] "Apply to Project" - mac/Sources/LlmIdeMac/Features/Extensions/Views/LlmSourceDetailView.swift:303 (+1)
- [label] "Selection changed — not yet applied to the project." - mac/Sources/LlmIdeMac/Features/Extensions/Views/LlmSourceDetailView.swift:295
- [label] "Local folder — Rescan picks up changes made on disk." - mac/Sources/LlmIdeMac/Features/Extensions/Views/LlmSourceDetailView.swift:325
- [label] "Couldn't check for updates\\(st.message.map {" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Extensions/Views/LlmSourceDetailView.swift:331
- [text] "Source not found — it may have been removed." - mac/Sources/LlmIdeMac/Features/Extensions/Views/LlmSourceDetailView.swift:77
- [text] ".count) of" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Extensions/Views/LlmSourceDetailView.swift:168
- [text] "New" - mac/Sources/LlmIdeMac/Features/Extensions/Views/LlmSourceDetailView.swift:189
- [text] "Hooks (" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Extensions/Views/LlmSourceDetailView.swift:213
- [text] "Listed for visibility only — hooks from a registered source are never executed." - mac/Sources/LlmIdeMac/Features/Extensions/Views/LlmSourceDetailView.swift:214
- [text] "MCP servers (" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Extensions/Views/LlmSourceDetailView.swift:236
- [text] "Listed for visibility only — this app never connects to or spawns a source's MCP servers." - mac/Sources/LlmIdeMac/Features/Extensions/Views/LlmSourceDetailView.swift:237
- [help] "A newer version is available — open the source and press Update" - mac/Sources/LlmIdeMac/Features/Extensions/Views/LlmSourceRow.swift:29
- [text] "not installed" - mac/Sources/LlmIdeMac/Features/Extensions/Views/LlmSourceRow.swift:32
- [textfield] "my-server" - mac/Sources/LlmIdeMac/Features/Extensions/Views/McpAddSheet.swift:98
- [textfield] "npx -y @modelcontextprotocol/server-memory" - mac/Sources/LlmIdeMac/Features/Extensions/Views/McpAddSheet.swift:110
- [textfield] "https://mcp.example.com/mcp" - mac/Sources/LlmIdeMac/Features/Extensions/Views/McpAddSheet.swift:117
- [text] "Local (stdio)" - mac/Sources/LlmIdeMac/Features/Extensions/Views/McpAddSheet.swift:102
- [text] "Hosted (http)" - mac/Sources/LlmIdeMac/Features/Extensions/Views/McpAddSheet.swift:103
- [text] "Hosted (sse)" - mac/Sources/LlmIdeMac/Features/Extensions/Views/McpAddSheet.swift:104
- [text] "Split on spaces — the first word is the command, the rest its arguments." - mac/Sources/LlmIdeMac/Features/Extensions/Views/McpAddSheet.swift:113
- [text] "Servers behind OAuth sign in through the CLI (`claude mcp login <name>`) — no token needed here." - mac/Sources/LlmIdeMac/Features/Extensions/Views/McpAddSheet.swift:120
- [button] "Save Credential" - mac/Sources/LlmIdeMac/Features/Extensions/Views/McpPluginDetailView.swift:123
- [button] "Re-sync from \\(p.source ==" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Extensions/Views/McpPluginDetailView.swift:190
- [text] "Plugin not found — it may have been removed." - mac/Sources/LlmIdeMac/Features/Extensions/Views/McpPluginDetailView.swift:52
- [text] "— this server will fail to authenticate." (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Extensions/Views/McpPluginDetailView.swift:116
- [text] "Consent before enabling — an enabled-but-unconsented server is never offered to the agent." - mac/Sources/LlmIdeMac/Features/Extensions/Views/McpPluginDetailView.swift:141
- [text] "Once enabled it is offered to the agent as mcp__" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Extensions/Views/McpPluginDetailView.swift:144
- [text] "Version" - mac/Sources/LlmIdeMac/Features/Extensions/Views/McpPluginDetailView.swift:169
- [text] "Could not look up the latest version:" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Extensions/Views/McpPluginDetailView.swift:172
- [help] "A newer version is available: \\(versionUpdate?.latest ??" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Extensions/Views/McpPluginRow.swift:37
- [label] "— not run while native plugin loading is off (Settings → Preferences)" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Extensions/Views/PluginDetailView.swift:262
- [label] "— unsupported, ignored" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Extensions/Views/PluginDetailView.swift:266
- [text] "Plugin not found — it may have been uninstalled." - mac/Sources/LlmIdeMac/Features/Extensions/Views/PluginDetailView.swift:66
- [text] "Imported from Claude Code" - mac/Sources/LlmIdeMac/Features/Extensions/Views/PluginDetailView.swift:147
- [text] "About" - mac/Sources/LlmIdeMac/Features/Extensions/Views/PluginDetailView.swift:183
- [text] "Slash commands (" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Extensions/Views/PluginDetailView.swift:192
- [text] "Subagents (" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Extensions/Views/PluginDetailView.swift:214
- [text] "Components" - mac/Sources/LlmIdeMac/Features/Extensions/Views/PluginDetailView.swift:248
- [text] "Enable the plugin first — its hooks and scripts only run for an enabled plugin." - mac/Sources/LlmIdeMac/Features/Extensions/Views/PluginDetailView.swift:305
- [text] "Install plugin from Git URL" - mac/Sources/LlmIdeMac/Features/Extensions/Views/PluginGitInstallSheet.swift:17
- [text] "Public HTTPS or git@ URL. The repo is cloned shallowly, packaged, and validated server-side before install." - mac/Sources/LlmIdeMac/Features/Extensions/Views/PluginGitInstallSheet.swift:19
- [help] "An update is available" - mac/Sources/LlmIdeMac/Features/Extensions/Views/PluginLibraryRow.swift:47
- [text] "Claude" - mac/Sources/LlmIdeMac/Features/Extensions/Views/PluginLibraryRow.swift:31
- [button] "Choose another…" - mac/Sources/LlmIdeMac/Features/Extensions/Views/PluginMarketplaceSheet.swift:54
- [textfield] "https://github.com/owner/marketplace" - mac/Sources/LlmIdeMac/Features/Extensions/Views/PluginMarketplaceSheet.swift:89
- [textfield] "Filter" - mac/Sources/LlmIdeMac/Features/Extensions/Views/PluginMarketplaceSheet.swift:108
- [help] "Replace the installed copy with this marketplace's version" - mac/Sources/LlmIdeMac/Features/Extensions/Views/PluginMarketplaceSheet.swift:137
- [text] "A marketplace is a public repo with a .claude-plugin/marketplace.json listing its plugins. It is cloned locally — nothing is fetched by the server." - mac/Sources/LlmIdeMac/Features/Extensions/Views/PluginMarketplaceSheet.swift:83
- [text] "Not installable here —" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Extensions/Views/PluginMarketplaceSheet.swift:152
- [button] "Accept and update" - mac/Sources/LlmIdeMac/Features/Extensions/Views/PluginUpdateConfirmSheet.swift:52
- [text] "Command" - mac/Sources/LlmIdeMac/Features/Extensions/Views/PluginUpdateConfirmSheet.swift:23
- [button] "Replace from file…" - mac/Sources/LlmIdeMac/Features/Extensions/Views/PluginUpdateSection.swift:104
- [text] "Installed from a file — choose a newer .zip to replace it." - mac/Sources/LlmIdeMac/Features/Extensions/Views/PluginUpdateSection.swift:62
- [text] "Checking for updates…" - mac/Sources/LlmIdeMac/Features/Extensions/Views/PluginUpdateSection.swift:67
- [text] "No update reported for v" (interpolated; longest fragment) - mac/Sources/LlmIdeMac/Features/Extensions/Views/PluginUpdateSection.swift:74
