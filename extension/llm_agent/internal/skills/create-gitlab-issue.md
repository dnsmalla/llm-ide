---
name: create-gitlab-issue
kind: write
confirmation: editable-sheet
schema:
  title:
    type: string
    required: true
    maxLength: 200
    description: short, imperative issue title
  description:
    type: string
    required: true
    maxLength: 50000
    description: markdown body — explain the problem and any context
  labels:
    type: "string[]"
    required: false
    description: e.g. ["enhancement", "ui"]
  assignee:
    type: string
    required: false
    description: GitLab username, no leading @
---

# create-gitlab-issue

Propose a new GitLab issue in the user's active project. The user
reviews the title, description, labels, and assignee in an editable
sheet before anything is filed.

## When to use

The user explicitly asks for an issue / ticket / bug report. Use the
active GitLab project from the System context block — do not ask the
user which project.

If the System context says `Active project: (none configured)`,
do not call this tool. Tell the user to add a project in Settings →
GitLab.

## Call shape

<<<TOOL_CALL>>>
{"name": "create-gitlab-issue", "arguments": {
  "title": "Make sidebar icons colourful",
  "description": "Currently the icons in the sidebar are monochrome. The user wants per-section colour to match the existing accent palette ...",
  "labels": ["enhancement", "ui"]
}}
<<<END_TOOL_CALL>>>

## Examples

- User: "Can you create an issue to make sidebar icons colourful?"
  → title: "Make sidebar icons colourful"
    description: "<a paragraph or two restating the request and any context>"
    labels: ["enhancement", "ui"]

- User: "File a bug — login is broken on Safari."
  → title: "Login broken on Safari"
    description: "<restate the symptom; if the user gave specifics, include them>"
    labels: ["bug"]
