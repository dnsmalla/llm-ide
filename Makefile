# --- extension ---------------------------------------------------------------

.PHONY: lint format test build clean

lint:
	cd extension && npm run lint && npm run format:check

format:
	cd extension && npm run format && npm run lint:fix

test:
	cd extension && npm test

build:
	cd extension && npm run build

clean:
	rm -rf extension/dist extension/extension-v*.zip

# --- mac app -----------------------------------------------------------------

.PHONY: test-mac regression

# Full Swift test suite for the desktop app (faults model, MemoryStore,
# RegressionRunner, CSV export, on-disk migration, etc.).
test-mac:
	cd mac && swift build && swift test

# Pre-upgrade / pre-production regression gate. Runs the Swift suite that
# guards the fault + regression machinery. Pair with the in-app Regression
# view (re-checks every `status: fixed` fault against the current agent and
# refreshes `<project>/system/faults.csv`) before shipping an upgrade — the
# CSV's `status` column is the release checklist.
regression: test-mac

# Enable the repo's git hooks (.githooks/). The pre-push hook runs the
# regression gate before any push that touches mac/. Run once per clone.
.PHONY: hooks
hooks:
	git config core.hooksPath .githooks
	@echo "✓ git hooks enabled (.githooks). pre-push runs 'make regression' for mac/ changes and 'make test' for extension/ changes; bypass with --no-verify."

# --- docs --------------------------------------------------------------------

VENV_DOCS := .venv-docs
PY        := $(VENV_DOCS)/bin/python
MKDOCS    := $(VENV_DOCS)/bin/mkdocs

.PHONY: docs-deps docs-serve docs-build docs-lint docs-refresh-reference docs-check

docs-deps:
	python3 -m venv $(VENV_DOCS)
	$(VENV_DOCS)/bin/pip install --upgrade pip
	$(VENV_DOCS)/bin/pip install -r docs-requirements.txt

docs-serve:
	$(MKDOCS) serve -a 127.0.0.1:8000

docs-build:
	$(MKDOCS) build --strict

docs-lint:
	@command -v markdownlint-cli2 >/dev/null || { echo "Install: npm i -g markdownlint-cli2"; exit 1; }
	@command -v lychee            >/dev/null || { echo "Install: brew install lychee or cargo install lychee"; exit 1; }
	markdownlint-cli2 "docs/**/*.md" "!docs/superpowers/**"
	lychee --no-progress --max-retries 3 --retry-wait-time 2 \
	  --exclude-path docs/superpowers \
	  --exclude '^https://github\.com/ORG/REPO' \
	  'docs/**/*.md' README.md
	$(PY) docs/_scripts/check_frontmatter.py

docs-refresh-reference:
	$(PY) docs/_scripts/extract_env_vars.py
	$(PY) docs/_scripts/extract_schema.py
	$(PY) docs/_scripts/extract_error_codes.py
	$(PY) docs/_scripts/extract_guardrails.py
	$(PY) docs/_scripts/extract_messages.py
	$(PY) docs/_scripts/extract_rate_limit.py
	$(PY) docs/_scripts/extract_agent_skills.py

docs-check:
	python3 -m pytest docs/_scripts/ -q
	python3 docs/_scripts/check_api_coverage.py
	python3 docs/_scripts/check_rate_limit_mapping.py
	python3 docs/_scripts/check_spec_citations.py
	python3 docs/_scripts/check_spec_values.py
