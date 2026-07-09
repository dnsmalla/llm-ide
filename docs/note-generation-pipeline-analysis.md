# Note Generation Pipeline Analysis

## Current Architecture

### Meeting Notes
**Source:** Google Meet, live sessions
**Process:**
1. `AppShell.swift` captures transcripts
2. `MeetingSummarizationService` generates AI summary
3. `MeetingNoteGenerator.generateDocx()` creates `.docx` file
4. Saved to: `<projectRoot>/notes/` (via `notesOutputFolder`)

**File format:** `.docx` (Word document)
**Location:** `<projectRoot>/notes/YYYY-MM-DD-HHMMSS-meeting-notes.docx`

### Email Notes
**Source:** Gmail/IMAP
**Process:**
1. `EmailSource.fetch()` retrieves emails via IMAP
2. `EmailFileStore.write()` saves raw emails to `EmailInbox/YYYY/MM/`
3. `InboxGenerationPipeline.run()` processes raw files
4. `EmailSource.generateNote()` classifies and generates notes
5. `EmailFileStore.writeNote()` saves as `.md` with YAML frontmatter

**File format:** `.md` (Markdown with YAML frontmatter)
**Location:** `<notesRoot>/Email/YYYY/MM/<timestamp>-<slug>.md`

**Note structure:**
```yaml
---
source: email
platform: email
from: "sender@example.com"
date: "2026-07-08T10:00:00Z"
category: "action-required"
noteWorthy: true
sourceHash: "abc123..."
todos:
  - title: "Follow up"
    detail: "..."
    due: null
    priority: "high"
    issue: null
---
# Subject

**Summary:** ...

## To-dos
- [ ] Follow up (high)

## Original
<email body>
```

### Box Documents
**Source:** Box.com
**Process:**
1. `box.mjs` connector fetches documents
2. Extracted text obtained via Box API
3. Chunked and stored in database `sources` table with `kind='doc'`
4. **NOT saved as individual note files**

**File format:** None (database records only)
**Location:** SQLite database `kb/sources`

### Slack Messages
**Source:** Slack
**Process:**
1. `SlackSource.fetch()` retrieves messages
2. Similar to meeting notes, generates `.docx`
3. Saved to: `<notesOutputFolder>/YYYY-MM-DD-HHMMSS-slack-notes.docx`

## Directory Structure

**Current (before .llm-ide migration):**
```
<projectRoot>/
├── notes/                    # Meeting/Slack .docx files
├── Email/                    # Email .md notes
│   ├── 2026/
│   │   ├── 07/
│   │   │   └── *.md
├── EmailInbox/              # Raw email files
│   ├── 2026/
│   │   ├── 07/
│   │   │   └── *.txt
├── meetings/                # Raw meeting transcripts
└── system/
    └── index.sqlite         # Meeting index
```

**New .llm-ide structure:**
```
<projectRoot>/
├── .llm-ide/
│   ├── memory/              # Chat memory facts
│   ├── graph/               # Code graph data
│   └── cache/               # Cached data
├── notes/                   # Meeting/Slack .docx files
├── Email/                   # Email .md notes
└── ...
```

## Potential Issues

### 1. Disconnected Storage Systems
The new `.llm-ide/` storage system is **NOT integrated** with the existing note generation pipeline. Email notes still go to `Email/` not `.llm-ide/memory/`.

### 2. Box Documents Not Saved as Notes
Box documents are only stored in the database (`sources` table), not as individual note files. This might be why "note generation is not working correctly" for Box.

### 3. Multiple Storage Locations
Notes are scattered across:
- `<projectRoot>/notes/` (meetings, slack)
- `<projectRoot>/Email/` (emails)
- Database (box documents)

This makes it hard to find and manage all notes in one place.

### 4. No Unified Note Interface
Each source has its own format and location:
- `.docx` for meetings/slack
- `.md` for emails
- Database records for box

## Recommendations

### Option A: Migrate to Unified .llm-ide Structure
Move all note generation to use `.llm-ide/`:
```
.llm-ide/
├── notes/
│   ├── meetings/         # .docx files
│   ├── emails/           # .md files
│   ├── documents/        # Box/other docs
│   └── index.json        # Unified index
```

### Option B: Create Unified Note Service
Add a `NoteService` that:
- Abstracts storage location
- Provides unified query interface
- Handles all note types (meetings, emails, documents)
- Integrates with existing `.llm-ide/` storage

### Option C: Fix Box Note Generation
Add note file generation for Box documents:
1. After fetching from Box, generate `.md` note files
2. Save to `.llm-ide/notes/documents/` or existing `Email/` structure
3. Include document metadata in YAML frontmatter

## Root Cause Assessment

The user's complaint "note generation is not working correctly" likely refers to:

1. **Box documents**: Only stored in DB, not as note files
2. **Scattered storage**: Notes in multiple locations, hard to find
3. **No integration**: New `.llm-ide/` system not connected to note generation
4. **Missing unified interface**: No single place to view all notes

The fix requires:
1. Decide on unified storage strategy (`.llm-ide/notes/` vs current scattered approach)
2. Add note file generation for Box/documents
3. Create unified note service or indexer
4. Ensure all sources write to consistent location
