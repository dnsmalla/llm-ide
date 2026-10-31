# ui/screens

Screen code for the Tauri desktop app (Phase 3), consumed from source by `desktop/` through the
alias `@llmide/screens/<name>` (Vite alias + tsconfig `paths`). One folder per screen, one owner per
folder (see `docs/superpowers/plans/2026-10-31-tauri-phase3-plan.md` section 8):

| Folder | Slice |
|---|---|
| `shell/` | S-A shell and navigation |
| `chat/` (`chat/approvals/` for S-G) | S-B chat core |
| `explorer/` | S-C Explorer, tree, tabs, Monaco |
| `library/` | S-E, S-I, S-J |
| `settings/` | S-F |

Rules:

- Shared look and components come from `@llmide/ui-kit` only. A missing kit component is requested
  from the kit owner (add it under the screen folder meanwhile), never copied into the kit by a screen slice.
- Screens talk to the Node core over HTTP/SSE (`schema/http`, agent/v2 stream contract) and to the Rust host
  through typed command wrappers; no screen reads files or secrets directly.
- Untrusted output (model text, notes, file contents) never goes through `dangerouslySetInnerHTML`;
  no remote images or fonts (see `ui/kit/README.md`).
- Big projects are a requirement, not a nice-to-have: virtualised lists and trees, lazy loading,
  bounded memory, cancellation on unmount, no whole-history or whole-tree renders.
- Logic that can be tested without a DOM lives in plain `.ts` modules next to the component and is tested with
  `node --test` (`--experimental-strip-types`); components are tested with server rendering as in `ui/kit/tests`.
