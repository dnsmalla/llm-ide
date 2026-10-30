# Maintain the changelog

`CHANGELOG.md` follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and is written from the
Conventional Commit history. Every release gets one section; work not yet released lives under `## [Unreleased]`.

## Where each commit goes

The commit type and scope decide the entry:

| Commit | Changelog heading |
|---|---|
| `feat(...)` | Added |
| `fix(...)` | Fixed |
| `refactor`, `perf`, behaviour changes | Changed |
| anything that closes a vulnerability or a data exposure | Security |
| `docs`, `test`, `chore`, `style`, `build`, `ci` | usually omitted |

Scopes map to a surface: `mac` is Mac, `server`, `kb`, `api`, `agent`, `extensions` are Server, `extension` is
Extension, `desktop` is Desktop, `ios` is Mobile. The Unreleased section carries a "by surface" summary with one
subsection per surface (Mac, Server, Extension, Desktop, Mobile) so a reader can find their own surface quickly.

## Routine

1. List what is new: `git log --format='%s' <last-tag>..HEAD | grep -E '^(feat|fix)'`.
2. Write one entry per user-visible change, not per commit. Say what the user sees, then the API version or
   migration number when the wire format changed.
3. Put each entry under the right heading and, in the summary, under the right surface.
4. Add a downgrade note when a file written by the new build cannot be read by an older one.
5. At release time rename `## [Unreleased]` to `## [x.y.z] - YYYY-MM-DD` and start a new empty Unreleased.

## Format rules

- Wrap prose at about 120 columns; one blank line between entries; no trailing spaces.
- Bold lead phrase for entries that need a name; plain bullets otherwise.
- Never paste commit hashes or internal task ids as the only description.
- The file is not part of the mkdocs site, so markdownlint does not run on it. Keep it lint-clean anyway.
