# Design: Library CODE section as a true nested tree

Date: 2026-06-16
Status: Approved

## Problem

The Library's CODE section flattens structure and shows duplicates:

- `externalFolderItems` assigns `folderOrigin = <repo name>` to **every** file
  regardless of depth, so a repo collapses into one flat list — `Sources/`,
  `Tests/`, etc. are lost.
- The canonical `code/` scan groups only by the *immediate* parent dir, and
  files directly in `code/` render loose.
- A project that has both a flat `code/` copy and an external reference of the
  same repo shows every file twice (different absolute paths, so the existing
  path-based dedup misses them).

Goal: CODE shows a real nested directory tree, one node per repo/root.

## Scope

- Nested tree applies to **CODE only**. Notes/Data keep the existing
  one-level `plainFileTreeSection`; Meetings keeps `sourcesSection`.
- Folder imports already reference code in place (`addFolder` →
  `externalCodeFolders`); single-file `add(url:.code)` keeps copying a lone
  file into `code/` (harmless — shows as a top-level leaf).
- Duplicate **data** (a flat `code/` copy that overlaps an external repo) is
  NOT auto-deleted. It's a project-setup decision left to the user; the tree
  makes the two sources legible.

## Data model

`LibraryItem` gains:

```swift
/// Directory components from the CODE-section root down to (not including)
/// the file, used to build the nested code tree. nil for non-code items.
/// e.g. <repo>/Sources/App/Foo.swift → ["InfiniteBrain", "Sources", "App"];
/// a file directly in the project's code/ → [].
var treePath: [String]? = nil
```

Populated in `LibraryItemStore`:
- canonical `code/` scan: components of the file relative to `<root>/code`,
  minus the filename.
- external repo scan: `[<repo folder name>] + (components relative to the repo
  root, minus the filename)`.

A shared helper `relativeDirComponents(of:under:)` computes the between-root
directory components.

## Rendering

A new `codeTreeSection(.code)` (dispatched from `fileTreeSection`):
- Builds a tree of `CodeEntry { id, name, item?, children? }` from the code
  items' `treePath` (files are leaves with `item != nil`; directories have
  `children`).
- Renders with SwiftUI `OutlineGroup(roots, children: \.children)` — recursion
  and expand/collapse handled by the framework. File rows reuse
  `LibraryFileRow` and carry the `.file(url)` selection tag; directory rows
  show a tinted folder glyph + name.
- Empty state unchanged ("No code files yet").
- Trade-off: swipe-to-delete is dropped inside the code tree (OutlineGroup
  isn't a ForEach); acceptable since code files are in-place repo references.

## Testing

- Unit-test the tree builder: flat files → top-level leaves; nested repo paths
  → correct parent/child nesting; mixed roots → separate top nodes.
- Unit-test `relativeDirComponents(of:under:)` for root-relative paths and the
  not-under-root guard.
