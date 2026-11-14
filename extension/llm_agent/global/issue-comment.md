---
name: issue-comment
kind: write
confirmation: editable-sheet
schema:
  provider:
    type: string
    required: true
    enum: [github, gitlab]
  repo:
    type: string
    required: true
    maxLength: 200
  number:
    type: number
    required: true
    description: issue number (GitHub) or iid (GitLab)
  body:
    type: string
    required: true
    maxLength: 20000
    description: comment body as plain Markdown
---

# issue-comment

Comment on an existing issue that is already on your Issues board. Use it for progress updates, verdicts and links; it replaces composing the same comment through a prompt.

The call is refused when the issue is not on the board, the token is missing, or the provider refuses the write.

Result: `{ ok, provider, repo, number, url }`.
