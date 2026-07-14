# Unified Note Storage — Implementation Progress

## ✅ Completed

### 1. Architecture Design
- **Clear separation established:**
  - Raw data sources: `meetings/`, `EmailInbox/`, `Documents/`
  - Generated notes: `notes/meetings/`, `notes/emails/`, `notes/documents/`

### 2. TypeScript Implementation
**File:** `extension/graphkit/services/note-service.ts`

**Features:**
- ✅ Unified `NoteService` class
- ✅ Save notes by type (meeting, email, document)
- ✅ Query notes with filters (type, date, tags, source)
- ✅ Unified index (`notes/index.json`)
- ✅ Raw file tracking (metadata links to source)
- ✅ Cross-platform consistency

**Tests:** 8/8 passing
- ✅ Directory structure
- ✅ Save operations (meeting, email, document)
- ✅ Raw file tracking
- ✅ Query by type and date
- ✅ Unified index building

### 3. Swift Implementation
**File:** `mac/Sources/LlmIdeMac/Services/NoteService.swift`

**Features:**
- ✅ Mirror of TypeScript implementation
- ✅ Public API for note operations
- ✅ Actor-isolated for thread safety
- ✅ Same directory structure
- ✅ Cross-platform parity

**Tests:** 7/7 passing
- ✅ All core operations tested
- ✅ Consistent with TS behavior

## 🎯 Current Structure

```
<projectRoot>/
├── meetings/              # RAW transcripts (keep as-is)
│   └── YYYY-MM/
├── EmailInbox/            # RAW emails (keep as-is)
│   └── YYYY-MM/
├── Documents/             # RAW documents (new - for Box)
│   └── YYYY-MM/
└── notes/                 # UNIFIED generated notes ✅
    ├── meetings/          # AI-generated meeting notes (.docx)
    │   └── YYYY-MM/
    ├── emails/            # AI-generated email notes (.md)
    │   └── YYYY-MM/
    ├── documents/         # AI-generated document notes (.md)
    │   └── YYYY-MM/
    └── index.json         # Unified note index ✅
```

## 🔄 Data Flow

```
┌─────────────────┐
│  RAW DATA       │
│  meetings/      │───┐
│  EmailInbox/    │───┤
│  Documents/     │───┤
└─────────────────┘   │
                     │
        ┌────────────▼────────────┐
        │  NoteService             │
        │  - saveNote()            │
        │  - queryNotes()          │
        │  - loadIndex()           │
        └────────────┬────────────┘
                     │
        ┌────────────▼────────────┐
        │  GENERATED NOTES        │
        │  notes/meetings/        │
        │  notes/emails/          │
        │  notes/documents/       │
        └─────────────────────────┘
```

## 🚧 Next Steps

### Immediate (High Priority)

1. **Update Email Generation**
   - Modify `EmailSource.swift` to save to `notes/emails/`
   - Track raw file path in metadata
   - Test with real email data

2. **Update Meeting Generation**
   - Modify `AppShell.swift` to save to `notes/meetings/`
   - Update `notesOutputFolder` path
   - Test with real meetings

3. **Add Box Document Processing**
   - Modify `box.mjs` to save raw files to `Documents/`
   - Generate notes to `notes/documents/`
   - Include document metadata

### Follow-up (Medium Priority)

4. **Create Migration Logic**
   - Move existing notes from scattered locations
   - Update file references
   - Handle conflicts

5. **Update Library View**
   - Scan unified `notes/` directory
   - Support filtering by note type
   - Display unified note list

6. **Integration Testing**
   - End-to-end tests for each source
   - Verify data flow
   - Performance testing

## 📊 Progress Summary

| Component | Status | Tests |
|-----------|--------|-------|
| Architecture Design | ✅ Complete | — |
| TypeScript NoteService | ✅ Complete | 8/8 ✅ |
| Swift NoteService | ✅ Complete | 7/7 ✅ |
| Email Generator Update | ⏳ Pending | — |
| Meeting Generator Update | ⏳ Pending | — |
| Box Document Generator | ⏳ Pending | — |
| Migration Logic | ⏳ Pending | — |
| Library View Update | ⏳ Pending | — |
| Integration Tests | ⏳ Pending | — |

## 🎉 Success Criteria

- [x] Unified note structure designed
- [x] NoteService implemented (TS + Swift)
- [x] Tests passing for both platforms
- [x] Raw file tracking working
- [x] Cross-platform consistency verified
- [ ] All generators using new structure
- [ ] Migration from legacy storage
- [ ] Library view scanning unified notes
- [ ] End-to-end integration verified

## 📝 Key Design Decisions

1. **Separation of Concerns:** Raw data stays in source folders, generated notes in unified location
2. **No Duplication:** Each note tracks its source via `rawFile` path
3. **Regeneration Support:** Can delete notes and regenerate from raw data
4. **Unified Query Interface:** Single service for all note types
5. **Atomic Writes:** Crash-safe file operations
6. **Cross-Platform Parity:** Identical behavior on TypeScript and Swift

## 🔗 Related Files

### TypeScript
- `extension/graphkit/services/note-service.ts` — Main service
- `extension/graphkit/services/index.ts` — Barrel export
- `extension/graphkit/tests/note-service.test.ts` — Tests

### Swift
- `mac/Sources/LlmIdeMac/Services/NoteService.swift` — Main service
- `mac/Tests/LlmIdeMacTests/NoteServiceTests.swift` — Tests

### Documentation
- `docs/unified-note-storage-architecture.md` — Architecture
- `docs/unified-note-storage-plan.md` — Implementation plan

---

**Status:** Foundation complete, ready for integration with existing generators.
