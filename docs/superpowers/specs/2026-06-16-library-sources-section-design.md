# Design: Library "MEETINGS" → "SOURCES" section with Meetings/Mail sub-groups

Date: 2026-06-16
Status: Approved

## Problem

The macOS app's Library has a top-level file-tree section labeled **MEETINGS**
(`fileTreeSection(.meetings)` in `LibraryView.swift`). Ingested email already
lands in this section (emails are turned into meeting notes and stored in
`meetings/`), but it reads as "Meetings" only. We want the section to read as
**SOURCES** and to visibly separate the input types it contains — Meetings and
Mail now, Slack later.

## Scope

**Changes**
- The `fileTreeSection(.meetings)` section header becomes **SOURCES**.
- Its contents are sub-grouped into **Meetings** and **Mail**, each with its own
  count and empty state. Both sub-groups are always visible.

**Explicitly unchanged**
- The activity-bar **Sources** destination (`SourcesView`) — the connect-cards
  config hub — is untouched.
- The top date-grouped "Today / This Week / …" meeting-summaries section in
  `LibraryView` is left as-is.
- On-disk layout: emails continue to land in `meetings/` via the existing
  meeting pipeline. No folder migration.

## Classification

Each meeting `.md` records `platform` in its frontmatter
(`MeetingFrontmatter.platform`): `"email"` for ingested mail,
`"meet" | "teams" | "zoom" | "mic"` for captured meetings
(`SourceIngestService` writes `platform: "email"`).

Derive a `SourceKind` during the existing `meetings/` scan:
- `platform == "email"` → `.mail`
- otherwise → `.meeting`

This requires no migration: existing email files already carry
`platform: "email"`.

Rejected alternative — routing email ingest to a separate `mail/` folder: more
invasive (changes `SourceIngestService`, breaks the deliberate
"email-looks-like-a-meeting" design and `MeetingIndex` assumptions, needs
migration of existing files).

## Data model

- Add `enum LibraryItem.SourceKind { case meeting, mail }`.
- Add `var sourceKind: LibraryItem.SourceKind?` to `LibraryItem` (nil for
  non-`.meetings` categories).
- `LibraryItemStore` populates `sourceKind` when scanning the `meetings/`
  folder by reading the `.md` frontmatter `platform` (best-effort; defaults to
  `.meeting` when frontmatter is absent/unreadable).
- Keep `LibraryItem.Category.meetings` and its Codable `rawValue` ("Meetings")
  unchanged — `rawValue` is persisted. Add a display-only
  `Category.sectionTitle` that returns "Sources" for `.meetings`, else
  `rawValue`.

## Rendering

`fileTreeSection` special-cases `.meetings`:
- Header uses `category.sectionTitle` ("SOURCES") with total count.
- Body renders two sub-groups (reusing the existing `DisclosureGroup` pattern
  used for folder groups):
  - **Meetings** — items whose `sourceKind != .mail`.
  - **Mail** — items whose `sourceKind == .mail`.
  - Each sub-group shows its count and, when empty, a muted empty state
    ("No meeting files yet" / "No mail yet").
- Loose-file vs folder-group handling within each sub-group is preserved.
- All other categories (`.code`, `.data`, `.notes`) render unchanged.

Slack: the sub-group structure leaves room for a third entry; it is **not**
shown until a Slack ingest path exists.

## Testing

- Unit test `SourceKind` derivation from `platform` (email → mail; meet/teams/
  zoom/mic/empty → meeting).
- Verify the Library renders a SOURCES header with Meetings and Mail sub-groups
  via a build + app launch (manual/preview), since the sub-grouping is view
  logic.
