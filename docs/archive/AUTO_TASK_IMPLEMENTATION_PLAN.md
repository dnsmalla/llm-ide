# Auto Task Enhancement Implementation Plan

## Overview
Add 3 new auto tasks and improve the auto task menu UI/UX based on analysis findings.

## Phase 1: Core Auto Task Additions (3 new tasks)

### Task 1.1: Generate Documentation (`generateDoc`)
**Files to Modify:**
- `/mac/Sources/LlmIdeMac/Views/AutoCode/AutoCodeView.swift`
- `/mac/Sources/LlmIdeMac/Models/Config.swift`
- `/mac/Sources/LlmIdeMac/Services/AutoCodeUpdateService.swift`

**Implementation Steps:**
1. Add `generateDoc` case to `AutoTask` enum
2. Add configuration properties in `AppConfig`:
   - `autoCodeRunGenerateDoc: Bool` (default: true)
   - `autoTaskTemplateGenerateDoc: String` (with default template)
3. Update `AutoCodeUpdateService` to handle documentation generation
4. Add default template in `AppConfig.defaultTemplateGenerateDoc`

### Task 1.2: Update Issues (`updateIssues`) 
**Files to Modify:**
- `/mac/Sources/LlmIdeMac/Views/AutoCode/AutoCodeView.swift`
- `/mac/Sources/LlmIdeMac/Models/Config.swift`
- `/mac/Sources/LlmIdeMac/Services/AutoCodeUpdateService.swift`

**Implementation Steps:**
1. Add `updateIssues` case to `AutoTask` enum
2. Add configuration properties in `AppConfig`:
   - `autoCodeRunUpdateIssues: Bool` (default: false - opt-in)
   - `autoTaskTemplateUpdateIssues: String` (with default template)
3. Update `AutoCodeUpdateService` to integrate with issue tracker APIs
4. Add error handling for API failures and missing credentials

### Task 1.3: Update Plan Status (`updatePlanStatus`)
**Files to Modify:**
- `/mac/Sources/LlmIdeMac/Views/AutoCode/AutoCodeView.swift`
- `/mac/Sources/LlmIdeMac/Models/Config.swift`
- `/mac/Sources/LlmIdeMac/Services/AutoCodeUpdateService.swift`

**Implementation Steps:**
1. Add `updatePlanStatus` case to `AutoTask` enum
2. Add configuration properties in `AppConfig`:
   - `autoCodeRunUpdatePlanStatus: Bool` (default: false)
3. Mark as structural task (no editable template)
4. Update `AutoCodeUpdateService` to call existing `/kb/outcomes/refresh` endpoint

## Phase 2: UI/UX Improvements

### Task 2.1: Fix Section Label Confusion
**Files to Modify:**
- `/mac/Sources/LlmIdeMac/Services/ShellState.swift`

**Implementation Steps:**
1. Update `ShellState.Section.plans.label` from "Review Doc" to "Plans"
2. Keep "Review Doc" as an auto task name (separate concern)
3. Update any references that assume plans section = review doc

### Task 2.2: Organize Tasks into Categories
**Files to Modify:**
- `/mac/Sources/LlmIdeMac/Views/AutoCode/AutoCodeView.swift`

**Implementation Steps:**
1. Add category grouping in UI:
   - **Review Tasks**: Code, Docs, Conflicts
   - **Automation Tasks**: Issues, Plan Status, Documentation
   - **Maintenance Tasks**: Regression, Knowledge
2. Add category headers in left pane
3. Update UI layout to show grouped sections

### Task 2.3: Enhanced Task Status Display
**Files to Modify:**
- `/mac/Sources/LlmIdeMac/Views/AutoCode/AutoCodeView.swift`
- `/mac/Sources/LlmIdeMac/Services/AutoCodeUpdateService.swift`

**Implementation Steps:**
1. Add per-task status indicators:
   - Last run timestamp
   - Success/failure/pending status
   - Output summary (findings count, issues created, etc.)
2. Add individual "Run Now" buttons per task
3. Show configuration status (enabled/disabled)
4. Display error messages inline

### Task 2.4: Enhanced Configuration Options
**Files to Modify:**
- `/mac/Sources/LlmIdeMac/Models/Config.swift`
- `/mac/Sources/LlmIdeMac/Views/Settings/AutoCodeSettingsSection.swift`

**Implementation Steps:**
1. Add per-task scheduling options:
   - Use global interval vs custom interval
   - Different frequencies per task type
2. Add task-specific configuration panel
3. Improve template editor with better UX
4. Add reset to default confirmation

## Phase 3: Backend Integration

### Task 3.1: Documentation Generation Backend
**Files to Modify:**
- `/extension/kb/routes/*` (if needed)
- `/extension/agents/*` (if needed)

**Implementation Steps:**
1. Ensure DocGen integration works with auto task system
2. Add proper error handling and logging
3. Integrate with existing documentation services

### Task 3.2: Issue Tracker Integration
**Files to Modify:**
- `/extension/kb/routes/*` 
- `/extension/providers.mjs`

**Implementation Steps:**
1. Ensure issue creation APIs are accessible
2. Add credential validation
3. Implement rate limiting and error handling
4. Add support for both GitHub and GitLab

### Task 3.3: Plan Status Refresh Integration  
**Files to Modify:**
- `/extension/kb/routes/agent.mjs` (outcomes refresh)

**Implementation Steps:**
1. Ensure existing `/kb/outcomes/refresh` endpoint works reliably
2. Add proper error handling for provider API failures
3. Update status persistence

## Phase 4: Testing & Validation

### Task 4.1: Unit Tests
**Files to Create:**
- `/mac/Tests/LlmIdeMacTests/AutoTaskGenerateDocTests.swift`
- `/mac/Tests/LlmIdeMacTests/AutoTaskUpdateIssuesTests.swift`
- `/mac/Tests/LlmIdeMacTests/AutoTaskUpdatePlanStatusTests.swift`

**Implementation Steps:**
1. Test each new auto task independently
2. Test configuration persistence
3. Test error handling scenarios
4. Test UI state management

### Task 4.2: Integration Tests
**Files to Create:**
- `/mac/Tests/LlmIdeMacTests/AutoTaskIntegrationTests.swift`

**Implementation Steps:**
1. Test full auto task pipeline
2. Test interaction with existing tasks
3. Test credential and API integration
4. Test concurrent task execution

### Task 4.3: UI Tests
**Implementation Steps:**
1. Test task category display
2. Test enable/disable toggles
3. Test template editor functionality
4. Test status display updates

## Phase 5: Documentation & Migration

### Task 5.1: Update Documentation
**Files to Modify:**
- `/README.md`
- `/docs/` (if exists)
- Change logs

**Implementation Steps:**
1. Document new auto tasks
2. Update configuration guide
3. Add migration notes for existing users
4. Update examples and templates

### Task 5.2: Default Templates
**Implementation Steps:**
1. Create well-crafted default templates for new tasks
2. Ensure templates are customizable
3. Add template validation
4. Document template variables

## Implementation Order & Dependencies

### Sprint 1: Core Functionality (Week 1)
1. Task 1.1: Generate Documentation
2. Task 1.3: Update Plan Status (simpler, uses existing APIs)
3. Task 2.1: Fix section label confusion

### Sprint 2: Advanced Integration (Week 2)  
1. Task 1.2: Update Issues (more complex API integration)
2. Task 2.2: Organize tasks into categories
3. Task 2.3: Enhanced status display

### Sprint 3: Polish & Testing (Week 3)
1. Task 2.4: Enhanced configuration
2. Task 3.1-3.3: Backend integration validation
3. Task 4.1-4.3: Comprehensive testing

### Sprint 4: Documentation & Release (Week 4)
1. Task 5.1-5.2: Documentation and templates
2. Final integration testing
3. Performance optimization
4. Release preparation

## Success Criteria

### Functional Requirements
- ✅ All 3 new auto tasks work correctly
- ✅ Existing auto tasks remain functional  
- ✅ Configuration persists correctly
- ✅ Error handling works gracefully
- ✅ UI improvements enhance usability

### Non-Functional Requirements
- ✅ Performance doesn't degrade
- ✅ Memory usage remains acceptable
- ✅ Token usage is optimized
- ✅ User experience is intuitive
- ✅ Documentation is comprehensive

### Risk Mitigation
- ✅ Opt-in defaults for risky operations (Update Issues)
- ✅ Clear error messages and recovery paths
- ✅ Backward compatibility maintained
- ✅ Existing workflows not disrupted
- ✅ Credential security maintained

## Estimated Effort

- **Phase 1**: 3-4 days (core auto task additions)
- **Phase 2**: 2-3 days (UI/UX improvements)  
- **Phase 3**: 2-3 days (backend integration)
- **Phase 4**: 2-3 days (testing & validation)
- **Phase 5**: 1-2 days (documentation & migration)

**Total**: 10-15 days across 4 sprints

## Next Steps

1. Review and approve this plan
2. Set up development branches
3. Begin Sprint 1 implementation
4. Regular progress check-ins
5. Continuous testing and validation