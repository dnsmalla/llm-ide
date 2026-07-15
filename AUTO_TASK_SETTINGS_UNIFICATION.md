# Auto Task Settings Unification Plan

## Overview

I've created a unified `AutoTaskSettings` model that acts as the **single source of truth** for all auto task configuration across the entire app.

**Goal:** One setting location that automatically updates everywhere (Settings UI, Menu Bar, Auto Code Service, etc.)

---

## Architecture

```
┌─────────────────────────────────────────┐
│     AutoTaskSettings (Single Truth)     │ ← Centralized @ObservableObject
│     • 20+ @Published properties         │
│     • Auto-saves to UserDefaults        │
│     • Broadcasts changes via Combine    │
└─────────────────────────────────────────┘
            ↓
    ┌───────┴────────┬─────────────┬──────────────┐
    ↓                ↓             ↓              ↓
Settings UI    Menu Bar       Auto Tasks     Other Views
(reactive)     (reactive)     Service        (reactive)
    ↑                ↑             ↑              ↑
    └────────────────┴─────────────┴──────────────┘
         All watch the same @EnvironmentObject
         Changes propagate automatically
```

---

## Key Features

### 1. **Single Source of Truth**
```swift
@StateObject private var autoTaskSettings = AutoTaskSettings()
    .environmentObject(autoTaskSettings)  // Pass to entire tree
```

### 2. **Automatic Reactivity**
```swift
@Published var enabled: Bool {
    didSet { save("autoCodeUpdateEnabled", enabled) }
}
// Any view binding changes → automatically saved + all views notified
```

### 3. **Batch Updates** (optional)
```swift
autoTaskSettings.batchUpdate { settings in
    settings.enabled = true
    settings.intervalMinutes = 30
    settings.runReviewCode = true
}
```

### 4. **Smart Computed Properties**
```swift
// Menu bar can show this without separate queries
autoTaskSettings.menuBarSummary  // "Auto Tasks: 3 enabled"

// Settings UI can show localized descriptions
autoTaskSettings.lookbackDescription  // "Last 5 meetings"
autoTaskSettings.intervalDescription  // "every hour"
```

### 5. **External Change Detection**
```swift
// If user changes settings via System Prefs, iCloud sync, etc.
// → automatically reloaded and all views notified
```

---

## Migration Path

### Step 1: Wire into App
In `LlmIdeMacApp.swift`:

```swift
@StateObject private var autoTaskSettings = AutoTaskSettings()

var body: some Scene {
    Window(...) {
        ContentView(api: api)
            .environmentObject(autoTaskSettings)
            // ... other environment objects
    }
}
```

### Step 2: Update AutoCodeSettingsSection

**Before:**
```swift
struct AutoCodeSettingsSection: View {
    @EnvironmentObject private var config: AppConfig
    
    Toggle(isOn: Binding(
        get: { config.autoCodeUpdateEnabled },
        set: { enabled in
            config.autoCodeUpdateEnabled = enabled
            if enabled { autoCodeUpdate.start() }
        }
    )) { Text("Enabled") }
}
```

**After:**
```swift
struct AutoCodeSettingsSection: View {
    @EnvironmentObject private var settings: AutoTaskSettings
    @EnvironmentObject private var autoCodeUpdate: AutoCodeUpdateService
    
    Toggle(isOn: Binding(
        get: { settings.enabled },
        set: { enabled in
            settings.enabled = enabled
            if enabled { autoCodeUpdate.start() }
        }
    )) { Text("Enabled") }
}
```

### Step 3: Create Menu Bar Component

New file: `MenuBarAutoTaskView.swift`

```swift
struct MenuBarAutoTaskView: View {
    @EnvironmentObject private var settings: AutoTaskSettings
    @EnvironmentObject private var autoCodeUpdate: AutoCodeUpdateService
    
    var body: some View {
        Menu {
            Section("Status") {
                Label(
                    settings.enabled ? "Enabled" : "Disabled",
                    systemImage: autoCodeUpdate.isRunning ? "ellipsis" : "checkmark"
                )
                if !autoCodeUpdate.isRunning, let date = autoCodeUpdate.lastRunDate {
                    Text("Last run: \(date.formatted())")
                        .font(.caption)
                }
            }
            
            Section("Settings") {
                Label(settings.menuBarSummary, systemImage: "gearshape")
                Label(settings.lookbackDescription, systemImage: "calendar")
                Label(settings.intervalDescription, systemImage: "timer")
            }
            
            Divider()
            
            Button("Run Now") { autoCodeUpdate.runNow() }
                .disabled(!settings.enabled || autoCodeUpdate.isRunning)
            
            Button("Stop") { autoCodeUpdate.cancel() }
                .disabled(!autoCodeUpdate.isRunning)
            
            Divider()
            
            Button("Open Settings") {
                NSApp.windows.first?.makeKeyAndOrderFront(nil)
            }
        } label: {
            Text("⚙️ Auto Tasks")
        }
        .menuStyle(.automatic)
    }
}
```

### Step 4: Update AutoCodeUpdateService

Replace direct `config` access with injected `AutoTaskSettings`:

```swift
@MainActor
final class AutoCodeUpdateService: ObservableObject {
    private let settings: AutoTaskSettings  // ← Add this
    
    init(
        settings: AutoTaskSettings,  // ← Add parameter
        registry: ProcessedActionsRegistry,
        ...
    ) {
        self.settings = settings
        // Subscribe to changes
        settings.$enabled
            .dropFirst()
            .sink { [weak self] enabled in
                if enabled { self?.start() } else { self?.stop() }
            }
            .store(in: &cancellables)
    }
    
    private func run() async {
        // Use self.settings.lookbackMeetingCount instead of config.autoCodeUpdateLookbackCount
        let rows = try index.list()
        let recentRows: [MeetingIndex.Row]
        if settings.lookbackByDays {
            let cutoffMs = Self.lookbackCutoffMs(now: Date(), days: settings.lookbackDays)
            recentRows = sortedRows.filter { $0.startedAt >= cutoffMs }
        } else {
            recentRows = Array(sortedRows.prefix(settings.lookbackMeetingCount))
        }
        // ... rest of pipeline uses settings instead of config
    }
}
```

### Step 5: Deprecate Config Auto Task Properties (Optional)

Once AutoTaskSettings is wired everywhere, you can either:

**Option A: Keep Config as passthrough** (safer, backward compatible)
```swift
extension AppConfig {
    var autoTaskSettings: AutoTaskSettings {
        AutoTaskSettings()  // Return the shared instance
    }
}
```

**Option B: Remove from Config** (cleaner, but breaks existing code)
```swift
// Remove these from AppConfig.swift:
// @Published var autoCodeUpdateEnabled: Bool
// @Published var autoCodeIntervalMinutes: Int
// ... etc
```

---

## Benefits

| Aspect | Before | After |
|--------|--------|-------|
| **Settings update** | Changes only in Settings | Changes in Settings → Menu Bar → Service all update |
| **Menu Bar sync** | Must manually query config | Automatically reflects settings |
| **Service sync** | Service polls config periodically | Service reacts to changes via Combine |
| **Code complexity** | Bindings spread across views | Single @EnvironmentObject everywhere |
| **External changes** | Not detected (no iCloud sync) | Automatically reloaded |
| **Testability** | Hard to mock (AppConfig singleton) | Easy: `AutoTaskSettings(defaults: testDefaults)` |

---

## Implementation Checklist

- [ ] Wire `AutoTaskSettings` into `LlmIdeMacApp.swift`
- [ ] Update `AutoCodeSettingsSection.swift` to use `@EnvironmentObject` instead of direct config
- [ ] Create `MenuBarAutoTaskView.swift` for menu bar display
- [ ] Update `AutoCodeUpdateService` to accept `AutoTaskSettings` injection
- [ ] Replace all `config.autoCodeUpdateEnabled` with `settings.enabled` in service
- [ ] Replace all `config.autoCodeIntervalMinutes` with `settings.intervalMinutes` in service
- [ ] Add `.onChange` handlers in service for reactive reschedule
- [ ] Test Settings → Menu Bar update propagation
- [ ] Test Menu Bar → Settings update propagation
- [ ] Verify service reacts to all setting changes
- [ ] Clean up AppConfig (either keep as passthrough or remove)

---

## Usage Examples

### Settings UI (reactive binding)
```swift
Toggle(isOn: $settings.enabled) { Text("Enabled") }
// User toggles → settings.enabled updated → @Published notifies → all views refresh
```

### Menu Bar (computed property)
```swift
Text(settings.menuBarSummary)
// "Auto Tasks: 3 enabled" automatically updates when task toggles change
```

### Service (injected dependency)
```swift
let intervalMinutes = settings.intervalMinutes
// Service can watch: settings.$intervalMinutes.sink { ... rescheduleTimer() }
```

### Multiple Components
```swift
// All these update automatically when ONE setting changes:
// 1. Settings UI toggle reflects new value
// 2. Menu bar summary shows "3 enabled" vs "2 enabled"
// 3. Service reschedules timer
// 4. Status message in both places updates
```

---

## File Locations

- **New file:** `/Users/dinesh.malla/llm-ide/mac/Sources/LlmIdeMac/Models/AutoTaskSettings.swift` ✅ (created)
- **Modify:** `/Users/dinesh.malla/llm-ide/mac/Sources/LlmIdeMac/LlmIdeMacApp.swift`
- **Modify:** `/Users/dinesh.malla/llm-ide/mac/Sources/LlmIdeMac/Views/Settings/AutoCodeSettingsSection.swift`
- **New file:** `/Users/dinesh.malla/llm-ide/mac/Sources/LlmIdeMac/Views/Shell/MenuBarAutoTaskView.swift`
- **Modify:** `/Users/dinesh.malla/llm-ide/mac/Sources/LlmIdeMac/Services/AutoCodeUpdateService.swift`

---

## Next Steps

1. Ready to integrate `AutoTaskSettings` into `LlmIdeMacApp.swift`?
2. Ready to refactor `AutoCodeSettingsSection` to use the new settings?
3. Ready to create the Menu Bar component?

Let me know which steps you'd like me to implement next!
