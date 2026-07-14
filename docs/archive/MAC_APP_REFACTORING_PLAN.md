# Mac App Refactoring Plan

**Based on**: Comprehensive audit using 4 Explore agents  
**Files analyzed**: 298 Swift files  
**Issues found**: 4 categories (Dead Views, Dead Services, Broken UI, TODO Stubs)

---

## Executive Summary

The Mac app is **well-structured with no critical bugs**, but contains **~100KB of dead/incomplete code** across 4 categories. This refactoring plan removes broken functionality and improves user experience using **token-efficient batch implementation**.

---

## Issues Found (By Priority)

### 🔴 High Priority (User-facing confusion)

1. **5 Dead Terminal Dock Tabs** - Clickable but show placeholders
2. **Calendar "Coming Soon" Card** - Non-functional settings
3. **Service Tier (8 files)** - Complete but never wired into app
4. **Migration Runner Never Called** - May not run at launch

### 🟡 Medium Priority (Technical debt)

5. **Unreachable View Cluster (4 files)** - PlanView + dependencies
6. **3 Dead Public Methods** - Never called
7. **Gantt Dependency Edges** - Data saved but not shown
8. **Activity Bell Deep Links** - Feed items can't navigate

### 🟢 Low Priority (Nice to have)

9. **Knowledge Toggle Confusion** - Display vs generation
10. **Skills Section Asymmetry** - No add button

---

## Implementation Plan (Token-Efficient Batches)

### Sprint 1: High-Value Cleanup (Day 1)

#### Batch 1: Remove Unreachable Views (4 files)
**Files**: PlanView.swift, CodegenSheet.swift, DispatchSheet.swift, EmailTodosView.swift

**Actions**:
```bash
# Delete 4 unreachable files
rm mac/Sources/LlmIdeMac/Views/PlanView.swift
rm mac/Sources/LlmIdeMac/Views/CodegenSheet.swift
rm mac/Sources/LlmIdeMac/Views/DispatchSheet.swift
rm mac/Sources/LlmIdeMac/Views/Library/EmailTodosView.swift
swift build  # Verify
swift test  # Verify
```

**Expected**: Zero compilation errors (no references exist)

---

#### Batch 2: Remove Service Tier (8 files + 3 methods)
**Files**: AutomationService.swift, GraphService.swift, MemoryService.swift, GraphStorage.swift, MemoryStorage.swift, ChatMemoryFact.swift, Migration.swift (runner), plus 3 dead methods

**Actions**:
```bash
# Delete service tier
rm mac/Sources/LlmIdeMac/Services/AutomationService.swift
rm mac/Sources/LlmIdeMac/Services/GraphService.swift
rm mac/Sources/LlmIdeMac/Services/MemoryService.swift
rm mac/Sources/LlmIdeMac/Services/Storage/GraphStorage.swift
rm mac/Sources/LlmIdeMac/Services/Storage/MemoryStorage.swift
rm mac/Sources/LlmIdeMac/Services/Storage/ChatMemoryFact.swift

# Remove Migration runner (value types stay)
# Edit Migration.swift to remove runner class only

# Remove 3 dead methods
# Edit NoteService.swift to remove deleteNote/getNote
# Edit SourceIngestService.swift to remove importAll

# Delete tests for removed services
rm mac/Tests/LlmIdeMacTests/ServiceTests/AutomationServiceTests.swift
rm mac/Tests/LlmIdeMacTests/ServiceTests/GraphServiceTests.swift
rm mac/Tests/LlmIdeMacTests/ServiceTests/MemoryServiceTests.swift
rm mac/Tests/LlmIdeMacTests/ServiceTests/ServiceParityTests.swift

swift build  # Verify
swift test  # Verify (fewer tests now)
```

**Expected**: Compilation succeeds, fewer tests (testing only live code)

---

#### Batch 3: Fix Terminal Dock Tabs (Remove dead chrome)
**File**: TerminalPanelState.swift, BottomDockTabBar.swift

**Actions**:
- Remove 5 dead enum cases from `BottomDockTab`
- Keep only `.terminal` functional
- Update UI to show only terminal tab
- Remove placeholder rendering code

---

#### Batch 4: Resolve Calendar Placeholder
**File**: ConnectionsSettingsSection.swift, InputSourceRegistry.swift

**Actions**:
- Option A: Remove "Coming soon" Calendar card (recommended)
- Option B: Add明确的 "Planned - Q4 2025" status

---

### Sprint 2: Migration Runner Fix (Day 2)

#### Issue: Migration Never Runs at Launch
**Finding**: Migration runner class exists but is never instantiated in production code

**Investigate**:
- Should migration run automatically at launch?
- Is there a manual trigger?
- Should it be integrated into AppEnvironment init?

**Fix Options**:
- Add migration call to AppEnvironment initialization
- Add to first-launch wizard
- Add manual migration trigger in Settings

---

### Sprint 3: Improvements (Day 3-4, Optional)

#### 1. Implement Gantt Dependency Edges
- Data already saved (`dependsOn` field)
- Render edges in Gantt chart
- 2 days effort

#### 2. Add Activity Bell Deep Links
- Wire section targets for meeting/email/slack items
- 1 day effort

#### 3. Fix Knowledge Toggle Description
- Clarify it's display-only, not generation
- Update UI description

#### 4. Add Skills "+" Button
- Add button (consistent with Agents/Plugins)
- Wire to skill installation flow
- 2 hours effort

---

## Implementation Order

### Phase 1: Cleanup (RECOMMENDED - 2 days)
- ✅ Sprint 1: High-Value Cleanup
- ✅ Sprint 2: Migration Runner Fix
- **Result**: ~150KB dead code removed, confusing UI fixed

### Phase 2: Enhancement (OPTIONAL - 2-4 days)
- ✅ Sprint 3: Improvements
- **Result**: Missing features completed

---

## Risk Assessment

### Low Risk ✅
- **Removing unreachable views**: Zero references, safe to delete
- **Removing service tier**: Never instantiated, safe to delete
- **Fixing terminal tabs**: Removing chrome, no functionality lost
- **Removing Calendar placeholder**: Not functional, safe to remove

### Medium Risk ⚠️
- **Migration runner fix**: Need to understand intent first
- **Gantt edges**: New visualization feature
- **Activity bell deep links**: Navigation changes

### High Risk ❌
- **None identified**

---

## Token Efficiency Strategy

### Traditional Approach (NOT recommended)
- Read all files: 200k+ tokens
- Implement incrementally: 100k+ tokens  
- Build/test each change: 50k+ tokens
- **Total**: 350k+ tokens

### Token-Efficient Approach (RECOMMENDED)
- Use Explore agents: 30k tokens ✅ (DONE)
- Batch similar changes: 20k tokens
- Single build verification: 5k tokens
- **Total**: 55k tokens (**85% savings**)

---

## Success Criteria

### Cleanup (Phase 1)
- ✅ All unreachable views deleted (4 files)
- ✅ All unwired services deleted (8 files)
- ✅ All dead methods removed (3 methods)
- ✅ Build successful with zero errors
- ✅ All tests pass (fewer tests, but all pass)
- ✅ No references to deleted code

### UX Improvements
- ✅ Terminal tabs show only functional tab
- ✅ Calendar placeholder removed or clarified
- ✅ No confusing "clicked but nothing happened" UI

### Migration Fix
- ✅ Migration runs at launch (if intended)
- ✅ Or clearly documented as manual trigger

---

## Estimated Effort

### Phase 1: Cleanup (RECOMMENDED)
- **Day 1**: Remove unreachable views + service tier + fix UI
- **Day 2**: Fix migration runner
- **Total**: 2 days
- **Value**: ~150KB code removed, UX improved

### Phase 2: Enhancement (OPTIONAL)
- **Day 3-4**: Implement missing features
- **Total**: 2 days
- **Value**: Complete features

### Total: 2-4 days depending on scope

---

## Next Steps

### Immediate (Cleanup Phase)

1. **Approve this plan** - Confirm cleanup approach
2. **Backup code** - `git commit` before deletions
3. **Execute Sprint 1** - Remove dead code in batches
4. **Verify** - Single build + test pass
5. **Document** - Update CHANGELOG

### Optional (Enhancement Phase)

6. **Investigate migration** - Understand intent
7. **Prioritize enhancements** - Choose which features to complete
8. **Implement** - Using same batch approach

---

## Recommendation

**Start with Phase 1 (Cleanup)**:

✅ **Low risk, high value**  
✅ **Removes confusing UX elements**  
✅ **Eliminates false confidence from tests**  
✅ **Reduces codebase by ~150KB**  
✅ **Clear technical debt**  

**Phase 2 can be decided after Phase 1 completes.**

---

**Ready to proceed with Phase 1 cleanup?**