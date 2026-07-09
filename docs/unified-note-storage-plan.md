# Unified Note Storage Implementation Plan

## Goal
Create a unified `.llm-ide/notes/` directory structure to consolidate all notes from meetings, emails, and documents into a single, organized location.

## Architecture

### New Directory Structure
```
<projectRoot>/
└── .llm-ide/
    └── notes/
        ├── meetings/          # Meeting & Slack .docx files
        │   └── YYYY-MM/
        │       └── YYYY-MM-DD-HHMMSS-[id]-meeting-notes.docx
        ├── emails/            # Email .md notes
        │   └── YYYY-MM/
        │       └── YYYY-MM-DD-HHMMSS-[slug].md
        ├── documents/         # Box & other document notes
        │   └── YYYY-MM/
        │       └── YYYY-MM-DD-HHMMSS-[doc-name].md
        ├── index.json         # Unified note index
        └── metadata/          # Additional metadata
```

### Unified Note Index
```json
{
  "version": 1,
  "updated": "2026-07-08T10:00:00Z",
  "notes": [
    {
      "id": "email-abc123",
      "type": "email",
      "source": "email",
      "title": "Project Update",
      "date": "2026-07-08T10:00:00Z",
      "path": ".llm-ide/notes/emails/2026-07/2026-07-08-100000-project-update.md",
      "hash": "sha256:...",
      "tags": ["action-required", "project"]
    },
    {
      "id": "meeting-xyz789",
      "type": "meeting",
      "source": "google-meet",
      "title": "Team Standup",
      "date": "2026-07-08T09:00:00Z",
      "path": ".llm-ide/notes/meetings/2026-07/2026-07-08-090000-abc12345-meeting-notes.docx",
      "participants": ["Alice", "Bob"],
      "tags": ["standup", "team"]
    },
    {
      "id": "doc-def456",
      "type": "document",
      "source": "box",
      "title": "Requirements Doc",
      "date": "2026-07-07T14:00:00Z",
      "path": ".llm-ide/notes/documents/2026-07/2026-07-07-140000-requirements-doc.md",
      "tags": ["requirements"]
    }
  ]
}
```

## Implementation Tasks

### Task 1: Create Unified Note Service (TypeScript)
**File:** `extension/graphkit/services/note-service.ts`

**Responsibilities:**
- Abstract storage operations for all note types
- Provide unified query interface
- Handle note indexing
- Support migration from scattered storage

**Key Methods:**
```typescript
class NoteService {
  // Save a note (unified interface)
  saveNote(note: Note): Promise<NoteMetadata>

  // Query notes by type, date, tags
  queryNotes(filter: NoteFilter): Promise<NoteMetadata[]>

  // Get note by ID
  getNote(id: string): Promise<Note | null>

  // Delete note
  deleteNote(id: string): Promise<void>

  // Rebuild index
  rebuildIndex(): Promise<void>

  // Migrate from scattered storage
  migrateFromLegacy(): Promise<MigrationResult>
}
```

### Task 2: Update Email Note Generation
**File:** `mac/Sources/LlmIdeMac/Sources/EmailSource.swift`

**Changes:**
- Update `EmailFileStore` to use `.llm-ide/notes/emails/` instead of `Email/`
- Keep YAML frontmatter structure
- Add note ID generation
- Register with unified index

### Task 3: Update Meeting Note Generation
**File:** `mac/Sources/LlmIdeMac/Views/AppShell.swift`

**Changes:**
- Update `notesOutputFolder` to use `.llm-ide/notes/meetings/`
- Keep `.docx` generation
- Register with unified index

### Task 4: Add Box Document Note Generation
**File:** `extension/connectors/box.mjs`

**Changes:**
- After fetching Box document, generate `.md` note
- Save to `.llm-ide/notes/documents/`
- Include document metadata in YAML frontmatter
- Register with unified index

**Note Template:**
```yaml
---
source: box
platform: box
documentId: "123456789"
title: "Requirements Doc"
date: "2026-07-07T14:00:00Z"
category: "document"
noteWorthy: true
sourceHash: "sha256:..."
tags: ["requirements", "planning"]
---
# Requirements Doc

## Summary
<AI-generated summary>

## Content
<document content>

## Metadata
- **Box ID:** 123456789
- **Author:** John Doe
- **Modified:** 2026-07-07
```

### Task 5: Create Migration Logic
**File:** `mac/Sources/LlmIdeMac/Services/Storage/NoteMigration.swift`

**Responsibilities:**
- Scan legacy locations (`Email/`, `notes/`, database)
- Move files to `.llm-ide/notes/`
- Update file names to follow unified convention
- Build unified index
- Handle conflicts and duplicates

### Task 6: Update Library View
**Files:** Various Library view files

**Changes:**
- Update to scan `.llm-ide/notes/` instead of multiple locations
- Support filtering by note type
- Display unified note list

### Task 7: Add Tests
**Files:** Test files for each component

**Coverage:**
- NoteService operations
- Email note generation
- Meeting note generation
- Box document note generation
- Migration logic
- Index building and querying

## Migration Strategy

### Phase 1: Implement New System (Non-breaking)
1. Create `NoteService` alongside existing code
2. Implement new note generation using `.llm-ide/notes/`
3. Keep old system working

### Phase 2: Migrate Existing Notes
1. Run migration to move existing notes
2. Verify all notes migrated correctly
3. Keep backups of old locations

### Phase 3: Switch Over
1. Update all code to use new unified system
2. Remove old scattered storage code
3. Clean up legacy locations

### Phase 4: Cleanup
1. Remove migration code after successful transition
2. Update documentation
3. Remove old directory handling

## Error Handling

### Write Failures
- Log errors but don't fail the entire operation
- Keep partial writes (atomic per-file)
- Report failures in UI

### Migration Conflicts
- If note already exists at target, keep both with suffix
- Log conflicts for manual review
- Never delete source without successful copy

### Index Corruption
- Validate index on load
- Rebuild if corrupted
- Keep backup of previous index

## Testing

### Unit Tests
- NoteService operations
- Individual note generators
- Migration logic
- Index operations

### Integration Tests
- End-to-end note generation
- Migration flow
- Query operations
- Conflict resolution

### Manual Testing
- Generate notes from each source
- Verify files in correct locations
- Check index accuracy
- Test migration with real data

## Rollback Plan

If issues arise:
1. Keep old directories intact until migration verified
2. Can revert code to use old locations
3. Re-run migration after fixes
4. Data never deleted without successful copy

## Success Criteria

1. ✅ All note types save to `.llm-ide/notes/`
2. ✅ Unified index covers all notes
3. ✅ Migration completes without data loss
4. ✅ All existing notes accessible in new location
5. ✅ New notes generated correctly
6. ✅ Library view shows all notes
7. ✅ No performance degradation
