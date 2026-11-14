---
name: issue-create
kind: write
confirmation: editable-sheet
schema:
  provider:
    type: string
    required: true
    enum: [github, gitlab]
    description: hosted provider; only a repository on your Issues board is allowed
  repo:
    type: string
    required: true
    maxLength: 200
    description: owner/name (GitHub) or group/project (GitLab)
  title:
    type: string
    required: true
    maxLength: 255
    description: issue title
  body:
    type: string
    required: false
    maxLength: 20000
    description: issue body as plain Markdown
---

# issue-create

Create one issue on a repository that is already on your Issues board. Use it instead of pasting an issue body into chat or re-describing it in a prompt. The provider token comes from the vault; the tool never returns it.

The call is refused when the repository is not on the board, the provider token is missing, or the provider refuses the write.

Result: `{ ok, provider, repo, number, url, deduped }`.
