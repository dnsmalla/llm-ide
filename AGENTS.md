# Agent Guidelines — Moved

The content of this file has been split into two locations in the docs site:

- **Operational rules — "do not regress these fixes":** [docs/explanation/invariants.md](docs/explanation/invariants.md)
- **Decisions and rationale:** [docs/decisions/](docs/decisions/) (ADRs 0001–0016)
- **Caption-scraper philosophy and history:** [docs/explanation/caption-capture.md](docs/explanation/caption-capture.md)
- **Skills for Claude / Cursor / Codex / …:** [docs/how-to/install-central-skills.md](docs/how-to/install-central-skills.md) — kit lives in the `.skills` submodule

If you are an automated agent looking for the "do not change these things" list, [invariants.md](docs/explanation/invariants.md) is what you want.

**GitLab auth:** one path only — LLM-IDE Settings → GitLab. Terminal agents use [`scripts/gitlab.sh`](scripts/gitlab.sh); see [`.cursor/rules/gitlab-single-auth.mdc`](.cursor/rules/gitlab-single-auth.mdc). Never ask for separate `glab auth login`.

Process skills are **not** edited in this repo. Author them in [dnsmalla/skills](https://github.com/dnsmalla/skills), bump `.skills`, then run `bash scripts/install-skills.sh`.
