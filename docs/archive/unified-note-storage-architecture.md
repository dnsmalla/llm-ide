# Unified Note Storage Architecture (Revised)

## Clear Separation: Raw Data vs Generated Notes

### Raw Data Sources (Input)
```
<projectRoot>/
├── meetings/              # RAW meeting transcripts
│   └── YYYY-MM/
│       └── *.md          # Original transcripts
├── EmailInbox/            # RAW email files
│   └── YYYY-MM/
│       └── *.txt         # Original email data
├── Documents/             # RAW document files
│   └── YYYY-MM/
│       └── *.*           # Original documents
└── [other sources]/       # Other raw data sources
```

### Generated Notes (Output)
```
<projectRoot>/
└── notes/                 # UNIFIED generated notes
    ├── meetings/          # Generated meeting notes
    │   └── YYYY-MM/
    │       └── YYYY-MM-DD-HHMMSS-[id]-meeting-notes.docx
    ├── emails/            # Generated email notes
    │   └── YYYY-MM/
    │       └── YYYY-MM-DD-HHMMSS-[slug].md
    ├── documents/         # Generated document notes
    │   └── YYYY-MM/
    │       └── YYYY-MM-DD-HHMMSS-[doc-name].md
    └── index.json         # Unified note index
```

## Data Flow

```
┌─────────────────┐
│  RAW DATA       │
│  (Source)       │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  GENERATE       │
│  (Process)      │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  GENERATED      │
│  NOTES          │
│  (Output)       │
└─────────────────┘
```

## Implementation

### 1. Raw Data Sources (Keep as-is)
- **meetings/** — Raw transcripts from Google Meet, live sessions
- **EmailInbox/** — Raw email files from IMAP
- **Documents/** — Raw documents from Box, etc.

### 2. Generated Notes Folder Structure
Create unified `notes/` with proper subdirectories:

```typescript
// Note storage structure
interface NoteStorage {
  root: URL;  // <projectRoot>/notes/

  // Meeting notes (.docx)
  meetingsDir: URL;  // root/meetings/

  // Email notes (.md)
  emailsDir: URL;    // root/emails/

  // Document notes (.md)
  documentsDir: URL; // root/documents/

  // Unified index
  indexPath: URL;    // root/index.json
}
```

### 3. Generation Pipeline

**Meetings:**
```
meetings/2026-07/transcript.md
     ↓ (AI summary + template)
notes/meetings/2026-07/2026-07-08-090000-abc123-meeting-notes.docx
```

**Emails:**
```
EmailInbox/2026-07/raw-email.txt
     ↓ (Classification + todo extraction)
notes/emails/2026-07/2026-07-08-100000-project-update.md
```

**Documents:**
```
Documents/2026-07/original.pdf
     ↓ (Text extraction + summary)
notes/documents/2026-07/2026-07-07-140000-requirements-doc.md
```

### 4. Note Tracking

To track which raw file generated which note:

```yaml
---
# In notes/emails/2026-07/project-update.md
source: email
platform: email
rawFile: "EmailInbox/2026-07/2026-07-08-100000-raw-email.txt"
sourceHash: "sha256:..."
generatedAt: "2026-07-08T10:05:00Z"
---
```

## Benefits

1. **Clear separation** — Raw data stays pure, generated notes separate
2. **Easy to find** — All generated notes in one place
3. **Can regenerate** — Delete notes and regenerate from raw data
4. **Backup friendly** — Can backup raw data and notes separately
5. **No duplication** — Raw data in source, generated output in notes/

## Migration Path

### Current → Target Structure

**Current (scattered):**
```
notes/               # Some meeting notes
Email/               # Some email notes
<database>           # Box documents
```

**Target (unified):**
```
meetings/            # Keep raw transcripts
EmailInbox/          # Keep raw emails
Documents/           # Keep raw docs
notes/               # ALL generated notes here
  ├── meetings/
  ├── emails/
  └── documents/
```

### Migration Steps

1. **Keep raw data where it is**
   - meetings/ stays
   - EmailInbox/ stays
   - Add Documents/ for Box raw files

2. **Create unified notes/ structure**
   - Create notes/meetings/
   - Create notes/emails/
   - Create notes/documents/

3. **Move existing generated notes**
   - From notes/ → notes/meetings/
   - From Email/ → notes/emails/
   - Export DB documents → notes/documents/

4. **Update generation code**
   - All generators write to notes/ subdirectories
   - Add raw file tracking in metadata

5. **Build unified index**
   - Scan notes/ directory
   - Create index.json

This approach keeps your raw data sources clean and puts all generated notes in a unified, well-organized location!
