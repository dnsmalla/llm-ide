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

.PHONY: build-mac build-mac-lite build-mac-min test-mac regression test-shared-protocol

# Pin the Xcode toolchain for every Swift build/test below. git invokes the
# pre-push hook with an environment that can resolve the CommandLineTools swift
# + SDK — a DIFFERENT Swift (6.3.2) than Xcode's (6.2.1). That mismatch fails to
# compile the macOS-26 SDK's WebKit interface and to load swift-testing, which
# is why pushes used to need --no-verify even though build.sh and the app build
# fine. Forcing DEVELOPER_DIR to the system-selected Xcode (ignoring any value
# inherited from the hook env) makes the gate use the same toolchain as
# build.sh. `swift` is the /usr/bin shim, which honours DEVELOPER_DIR.
export DEVELOPER_DIR := $(shell env -u DEVELOPER_DIR xcode-select -p)
# …and pin the matching SDK. Bare `swift build` otherwise resolves the SDK via
# `xcrun --show-sdk-path`, which returns the CommandLineTools macOS SDK even when
# the compiler is Xcode's — and an Xcode-6.2.1 compiler against the CLT-6.3.2 SDK
# fails to verify the macOS-26 WebKit interface. `--sdk macosx` picks the SDK
# from the (now Xcode) DEVELOPER_DIR, keeping compiler and SDK from one install.
export SDKROOT := $(shell DEVELOPER_DIR='$(shell env -u DEVELOPER_DIR xcode-select -p)' xcrun --sdk macosx --show-sdk-path)

# Full Swift test suite for the desktop app (ChatSessionStore, etc.).
# Requires full Xcode — Command Line Tools alone lack the XCTest module.
HAS_XCTEST := $(shell test -d "$(DEVELOPER_DIR)/Platforms/MacOSX.platform/Developer/Library/Frameworks/XCTest.framework" && echo 1)

# Builds the full app only when LLMIDE_FEATURES is unset in the invoking
# shell (SwiftPM inherits it from the environment). A raw command line that
# runs a lite selection WITHOUT --manifest-cache none can poison the
# manifest cache for every build after it, including this target — the
# provided targets here are safe, but keep the flag on any hand-run command.
build-mac: ## Build the full mac app
	cd mac && GIT_CONFIG_GLOBAL=/dev/null swift build

# LLMIDE_FEATURES lists the INCLUDED features by AppFeature rawValue; this
# selection excludes every excludable feature (code_graph_3d, file_explorer,
# gantt_issues, doc_gen, terminal), keeping only the three that have no
# source-exclusion switch. --manifest-cache none is required: SwiftPM does
# not key its manifest cache on env vars, so a stale cache would silently
# keep the previous selection's target graph.
build-mac-lite: ## non-engineer build: no Explorer/Gantt/DocGen/Terminal/Graph
	cd mac && GIT_CONFIG_GLOBAL=/dev/null LLMIDE_FEATURES=agent_chat,auto_tasks,mobile_sync swift build --manifest-cache none

# Same rationale as build-mac-lite, two steps further: drops auto_tasks AND
# mobile_sync too (excludes AutoTask/, LoopEngine/, and the Mobile Control
# file-level unit — see Package.swift's `auto_tasks`/`mobile_sync` keys),
# keeping only the one feature with no source-exclusion switch (agent_chat) —
# the true minimum. --manifest-cache none for the same reason as build-mac-lite.
build-mac-min: ## Non-engineer minimum: Chat only (no Mobile/AutoTask/Loop/Graph/view features)
	cd mac && GIT_CONFIG_GLOBAL=/dev/null LLMIDE_FEATURES=agent_chat swift build --manifest-cache none

test-mac:
	cd mac && swift build --product LlmIdeMac
ifeq ($(HAS_XCTEST),1)
	cd mac && swift test
else
	@echo "⚠ Skipping mac swift test — full Xcode required (XCTest not in $$(xcode-select -p))"
endif

# SharedProtocol wire-format tests (used by mac + ios_app).
test-shared-protocol:
	cd ios_app/SharedProtocol && swift build
ifeq ($(HAS_XCTEST),1)
	cd ios_app/SharedProtocol && swift test
else
	@echo "⚠ Skipping SharedProtocol swift test — full Xcode required (XCTest not in $$(xcode-select -p))"
endif

# Pre-upgrade / pre-production regression gate. Runs the Swift suite that
# guards the fault + regression machinery. Pair with the in-app Regression
# view (re-checks every `status: fixed` fault against the current agent and
# refreshes `<project>/system/faults.csv`) before shipping an upgrade — the
# CSV's `status` column is the release checklist.
regression: test-mac build-mac-lite build-mac-min graph-gates

# The graph verification gates. These are plain executables precisely so they
# run where `swift test` cannot (a Command-Line-Tools-only toolchain has no
# XCTest): graph-layout-lab asserts the layout engine against exact N² ground
# truth and Louvain reference values; graph-engine-lab asserts generation
# invariants (containment direction, cross-link precedence, related-modules
# linking, fingerprint stability). Wired into `regression` because a gate
# nothing runs is a gate in name only — the layout gate passed a 1094%-wrong
# force calculation for exactly as long as nobody executed it.
.PHONY: graph-gates
graph-gates:
	cd mac/LocalPackages/graph-kit && swift run -c release graph-layout-lab
	cd mac/LocalPackages/graph-kit && swift run -c release graph-engine-lab

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
	$(PY) -m pytest docs/_scripts/ -q
	$(PY) docs/_scripts/check_api_coverage.py
	$(PY) docs/_scripts/check_rate_limit_mapping.py
	$(PY) docs/_scripts/check_spec_citations.py
	$(PY) docs/_scripts/check_spec_values.py
