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

.PHONY: build-mac build-mac-lite build-mac-min build-mac-mobile-only test-mac regression test-shared-protocol

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
# selection includes only agent_chat, auto_tasks, and mobile_sync, excluding
# code_graph_3d, file_explorer, gantt_issues, doc_gen, and terminal.
# --manifest-cache none is required: SwiftPM does not key its manifest cache
# on env vars, so a stale cache would silently keep the previous selection's
# target graph.
# Each feature selection gets its OWN --scratch-path: sharing mac/.build made
# every variant flip the compile flags of the one before it, so `make
# regression` recompiled the whole app four times on every run (10+ min per
# push even for a one-line change). Separate caches stay warm (~1-2 GB each).
build-mac-lite: ## non-engineer build: no Explorer/Gantt/DocGen/Terminal/Graph
	cd mac && GIT_CONFIG_GLOBAL=/dev/null LLMIDE_FEATURES=agent_chat,auto_tasks,mobile_sync swift build --manifest-cache none --scratch-path .build-lite

# Same rationale as build-mac-lite, two steps further: drops auto_tasks AND
# mobile_sync too (excludes AutoTask/, LoopEngine/, and the Mobile Control
# file-level unit — see Package.swift's `auto_tasks`/`mobile_sync` keys),
# keeping only agent_chat. The true minimum. --manifest-cache none for the
# same reason as build-mac-lite.
build-mac-min: ## Chat only: excludes all 7 excludable features
	cd mac && GIT_CONFIG_GLOBAL=/dev/null LLMIDE_FEATURES=agent_chat swift build --manifest-cache none --scratch-path .build-min

# The mirror quadrant of build-mac-min: mobile_sync compiled IN, auto_tasks
# compiled OUT. Guards the bridge seam the other quadrant can't see — with
# AutoTask absent, MobileFeatureBridge's dynamic-downgrade path
# (replyFeatureUnavailable) is what stands between the phone and a crash, not
# just a hidden toggle. --manifest-cache none for the same reason as
# build-mac-lite.
build-mac-mobile-only: ## Build with Chat + Mobile only (no AutoTask/Loop — guards the bridge seam)
	cd mac && GIT_CONFIG_GLOBAL=/dev/null LLMIDE_FEATURES=agent_chat,mobile_sync swift build --manifest-cache none --scratch-path .build-mobile

test-mac:
	cd mac && swift build --product LlmIdeMac
ifeq ($(HAS_XCTEST),1)
	# memory keychain: tests must never touch (or prompt for) the login keychain — see KeychainStore.backend
	cd mac && LLMIDE_KEYCHAIN_BACKEND=memory swift test
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
# graph-kit-checkout goes FIRST: it is a one-line precondition, and failing it
# after four Mac builds (many minutes in) is the wrong place to learn about it.
regression: graph-kit-checkout feature-gates contract-gates test-mac build-mac-lite build-mac-min build-mac-mobile-only graph-gates chat-gates generation-gates loop-gates api-gates

.PHONY: feature-gates
# Enforces the layering rule: Shell -> Features -> Core. Swift has no
# intra-target boundary enforcement, so this is a textual check over the
# symbol declarations/references in mac/Sources/LlmIdeMac. Runs first in
# `regression` (~30s) because failing fast beats failing after four Swift
# builds.
feature-gates:
	cd mac && ./Scripts/feature-boundaries.sh

# The graph verification gates. These are plain executables precisely so they
# run where `swift test` cannot (a Command-Line-Tools-only toolchain has no
# XCTest): graph-layout-lab asserts the layout engine against exact N² ground
# truth and Louvain reference values; graph-engine-lab asserts generation
# invariants (containment direction, cross-link precedence, related-modules
# linking, fingerprint stability). conformance-memory.mjs runs BOTH the Swift
# and TypeScript doc tracks over one corpus and diffs them — schema/fixtures
# only prove a graph decodes, never that the two engines AGREE, which is how
# the port silently dropped graph-only/related-modules, scanned fenced code
# blocks, and id'd symlinked paths differently. Wired into `regression` because a gate
# nothing runs is a gate in name only — the layout gate passed a 1094%-wrong
# force calculation for exactly as long as nobody executed it.
# The gates need the graph-kit SUBMODULE checked out. The Mac BUILD no longer
# does (mac/Package.swift fetches graph-kit by URL), so a fresh clone that
# skipped `git submodule update` builds fine and then dies here: from an empty
# submodule dir `swift run` walks up to mac/Package.swift and still runs the
# labs, but conformance-memory.mjs exists only in the submodule's scripts/ —
# the failure was a bare Node MODULE_NOT_FOUND stack trace naming no cause.
.PHONY: graph-kit-checkout
graph-kit-checkout:
	@test -f mac/LocalPackages/graph-kit/Package.swift || { \
	  echo "graph-gates: mac/LocalPackages/graph-kit is not checked out. The Mac build no longer" >&2; \
	  echo "  needs the submodule, but the graph gates run from it. Fix with:" >&2; \
	  echo "    git submodule update --init mac/LocalPackages/graph-kit" >&2; \
	  exit 1; }

.PHONY: graph-gates
graph-gates: graph-kit-checkout
	cd mac/LocalPackages/graph-kit && swift run -c release graph-layout-lab
	cd mac/LocalPackages/graph-kit && swift run -c release graph-engine-lab
	cd mac/LocalPackages/graph-kit && node scripts/conformance-memory.mjs

.PHONY: api-gates
# Decodes every 2xx HTTP contract fixture with the Mac's Codable models and
# fails on a decode error or an unallowlisted dropped key (Phase 1 P12).
api-gates:
	cd mac && GIT_CONFIG_GLOBAL=/dev/null swift run api-contract-lab

# The Chat slice's assertion gate. An executable for the same reason the graph
# labs are: this toolchain has no XCTest, so `test-mac` above skips `swift test`
# entirely — pure logic lifted out of ChatEngine would otherwise have no gate at
# all. Wired into `regression` because a gate nothing runs is a gate in name only.
.PHONY: chat-gates
chat-gates:
	cd mac && GIT_CONFIG_GLOBAL=/dev/null swift run chat-contract-lab
	node scripts/conformance-agent-v2.mjs

# HTTP endpoint contract (schema/http): request and response shapes per route
# group, checked against the roster. Part of `regression` (Phase 1 P16) and
# run by the pre-push hook for mac/ pushes through `regression`; it is fast
# (node only), so it runs right after feature-gates, before the Swift builds.
.PHONY: contract-gates
contract-gates:
	node scripts/conformance-http.mjs
	node scripts/gen-api-types.mjs --check
	node scripts/gen-openapi.mjs --check
	node scripts/http-inventory.mjs --check
	node scripts/gen-design-tokens.mjs --check
	$(MAKE) os-view-check

# System view (ui/os-view): the React page the Mac app shows in a web view. The
# build writes the committed bundle to mac/Sources/LlmIdeMac/Resources/os-view
# (Monaco precedent). Fixed file names, no hashes, so rebuilds are deterministic.
.PHONY: os-view
os-view:
	cd ui/os-view && { test -d node_modules || npm ci; } && npm run build

# Rebuilds the System view into a temp dir and fails when the committed bundle is stale.
.PHONY: os-view-check
os-view-check:
	cd ui/os-view && { test -d node_modules || npm ci; }
	rm -rf ui/os-view/.bundle-check && \
	(cd ui/os-view && OS_VIEW_OUT="$$PWD/.bundle-check" npm run build >/dev/null) && \
	if diff -r ui/os-view/.bundle-check mac/Sources/LlmIdeMac/Resources/os-view >/dev/null; then \
		rm -rf ui/os-view/.bundle-check; echo "os-view-check: ok"; \
	else \
		diff -rq ui/os-view/.bundle-check mac/Sources/LlmIdeMac/Resources/os-view; \
		rm -rf ui/os-view/.bundle-check; echo "os-view-check: committed bundle is stale; run make os-view"; exit 1; \
	fi

# Design tokens: schema/design/tokens.json -> Mac ThemeTokens.swift and schema/design/tokens.css.
# Regenerate after editing tokens.json; `contract-gates` fails while the outputs are stale.
.PHONY: design-tokens
design-tokens:
	node scripts/gen-design-tokens.mjs

# Generated TypeScript types for the HTTP contract (extension/src/lib/api-types.ts).
# Regenerate after changing schema/http; `contract-gates` fails while it is stale.
.PHONY: api-types
api-types:
	node scripts/gen-api-types.mjs

# Generated OpenAPI 3.1 document (docs/reference/api/openapi.yaml) from schema/http,
# merged with docs/reference/api/openapi.overlay.json. Regenerate after changing
# schema/http or the overlay; `contract-gates` fails while it is stale.
.PHONY: openapi
openapi:
	node scripts/gen-openapi.mjs

# Doc Gen / Visual: the template-surface marker, which decides which menu a
# user's template appears in and round-trips through a file on their disk.
.PHONY: generation-gates
generation-gates:
	cd mac && GIT_CONFIG_GLOBAL=/dev/null swift run generation-contract-lab

# The Loop feature's stale-default-command reconciliation, plus the exit-127
# "command not found" message. Same rationale as chat-gates: this toolchain
# has no XCTest, so pure logic in LoopStageDetector/StageOutputParser would
# otherwise have no gate at all.
.PHONY: loop-gates
loop-gates:
	cd mac && GIT_CONFIG_GLOBAL=/dev/null swift run loop-contract-lab

# Token & speed gate (Phase 1 P17). NOT in `regression`: a real run spends
# tokens (one short turn per scenario on the cheapest model). Run on demand or
# nightly; `token-bench-fake` exercises the same pipeline with no model calls.
# See docs/how-to/run-the-token-bench.md.
.PHONY: token-bench token-bench-fake
token-bench:
	node scripts/token-bench.mjs

token-bench-fake:
	node scripts/token-bench.mjs --fake

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
