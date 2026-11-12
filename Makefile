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

# --- desktop (Tauri) ---------------------------------------------------------

.PHONY: test-desktop test-desktop-node
# Desktop gates: node tests, capability/DOMPurify checks, generated-token drift
# check, then `cargo test --lib` when a REAL cargo exists. A toolchain counts
# only if `cargo --version` prints "cargo ..." (a broken rustup shim prints
# "rustup ..." instead); when PATH only holds the shim, fall back to the rustup
# stable toolchain's own binary so the tests are not skipped silently. The node
# steps skip if desktop/node_modules is absent. Rust is skipped with a notice,
# never failed, on a machine without it.
test-desktop-node:
	@if [ -d desktop/node_modules ]; then \
	  cd desktop && npm test && npm run -s check:security && node ../scripts/gen-design-tokens.mjs --check; \
	else echo "test-desktop: desktop/node_modules missing (cd desktop && npm ci); skipping node checks"; fi
	@if [ -d ui/kit/node_modules ]; then \
	  cd ui/kit && npm test --silent && npm run -s type-check; \
	else echo "test-desktop: ui/kit/node_modules missing (cd ui/kit && npm ci); skipping ui-kit checks"; fi
	@if [ -d web/node_modules ]; then \
	  cd web && npm test --silent && npx tsc --noEmit -p .; \
	else echo "test-desktop: web/node_modules missing (cd web && npm ci); skipping web checks"; fi

# test-desktop-node is under 2 s and is part of `make regression`; the cargo
# step compiles Tauri (minutes cold), so it stays out of the regression gate
# (desktop-ci.yml runs it).
test-desktop: test-desktop-node
	@CARGO="$$(command -v cargo || true)"; \
	if [ -z "$$CARGO" ] || ! "$$CARGO" --version 2>/dev/null | grep -q '^cargo '; then \
	  CARGO="$$(ls -d "$$HOME"/.rustup/toolchains/stable-*/bin/cargo 2>/dev/null | head -1)"; \
	fi; \
	if [ -n "$$CARGO" ] && "$$CARGO" --version 2>/dev/null | grep -q '^cargo '; then \
	  TOOLCHAIN_BIN="$$(dirname "$$CARGO")"; \
	  cd desktop/src-tauri && PATH="$$TOOLCHAIN_BIN:$$PATH" "$$CARGO" test --lib; \
	else echo "test-desktop: no working cargo (a shim that prints 'rustup ...' does not count); skipping cargo test --lib"; fi

# --- swift (iOS SharedProtocol) and gates ---------------------------------------

.PHONY: regression test-shared-protocol test-ios-app

# Pin the Xcode toolchain for the Swift builds below (SharedProtocol, the
# graph-kit labs). git invokes the pre-push hook with an environment that can
# resolve the CommandLineTools swift + SDK, a different Swift than Xcode's;
# forcing DEVELOPER_DIR to the system-selected Xcode (ignoring any inherited
# value) and SDKROOT to its macOS SDK keeps compiler and SDK from one install.
export DEVELOPER_DIR := $(shell env -u DEVELOPER_DIR xcode-select -p)
export SDKROOT := $(shell DEVELOPER_DIR='$(shell env -u DEVELOPER_DIR xcode-select -p)' xcrun --sdk macosx --show-sdk-path)

# Requires full Xcode — Command Line Tools alone lack the XCTest module.
HAS_XCTEST := $(shell test -d "$(DEVELOPER_DIR)/Platforms/MacOSX.platform/Developer/Library/Frameworks/XCTest.framework" && echo 1)

# SharedProtocol wire-format tests (used by ios_app). The sync v1 vectors are shared: the Node reference
# runner and the Swift suite both execute `devicePolicy` (stale_manifest + 90-day device lifetime), so a
# change that only one side understands fails here.
test-shared-protocol:
	node scripts/generate-host-api.mjs --check
	node scripts/sync-vectors.mjs
	node --test extension/tests/sync-policy.test.mjs
	cd ios_app/SharedProtocol && swift build
ifeq ($(HAS_XCTEST),1)
	cd ios_app/SharedProtocol && swift test
else
	@echo "⚠ Skipping SharedProtocol swift test — full Xcode required (XCTest not in $$(xcode-select -p))"
endif

# The iPhone app's own tests (composition root and event routing; needs an iOS Simulator runtime). The store and
# wire logic is covered by test-shared-protocol.
test-ios-app:
	bash scripts/test-ios-app.sh

# Pre-push / pre-release regression gate: the graph-kit pin, the contracts,
# the desktop/ui/web node suites, the agent/v2 wire and the graph-kit labs.
# graph-kit-checkout goes FIRST: it is a one-line precondition. The extension
# suite (`make test`) and cargo (`make test-desktop`) stay separate: the
# pre-push hook runs `make test` for extension/ pushes, desktop-ci runs cargo.
regression: graph-kit-checkout graphkit-pin-check contract-gates test-desktop-node agent-v2-gates graph-gates

# The graph verification gates, run from the graph-kit submodule: graph-layout-lab
# asserts the layout engine against exact N² ground truth and Louvain reference
# values; graph-engine-lab asserts generation invariants; conformance-memory.mjs
# runs BOTH the Swift and TypeScript doc tracks over one corpus and diffs them
# (llm-ide's core runs the TypeScript track, extension/graphkit/). Plain
# executables, so they run where `swift test` cannot.
.PHONY: graph-kit-checkout
graph-kit-checkout:
	@test -f graph-kit/Package.swift || { \
	  echo "graph-gates: graph-kit is not checked out. Fix with:" >&2; \
	  echo "    git submodule update --init graph-kit" >&2; \
	  exit 1; }

# The graph-kit pin is the submodule gitlink. Offline by default (it runs in
# `regression`); ONLINE=1 also checks the pinned sha exists on the graph-kit
# remote, which is what the pre-push hook runs when the gitlink changes.
# Workflow: docs/how-to/graph-kit-workflow.md.
.PHONY: graphkit-pin-check
graphkit-pin-check:
	node scripts/graphkit-pin-check.mjs $(if $(ONLINE),--online,)

# Push graph-kit, move the gitlink to its HEAD and verify. Dry run prints every
# step and changes nothing:
#   make graphkit-bump DRY_RUN=1
#   make graphkit-bump TAG=1.7.0 YES=1 COMMIT=1   (cut a release tag too)
.PHONY: graphkit-bump
graphkit-bump:
	$(if $(filter-out undefined,$(origin TAG)),$(if $(strip $(TAG)),,$(error graphkit-bump: TAG is set but empty; pass TAG=X.Y.Z or leave TAG unset)),)
	TAG="$(TAG)" DRY_RUN="$(DRY_RUN)" COMMIT="$(COMMIT)" YES="$(YES)" COAUTHOR="$(COAUTHOR)" bash scripts/graphkit-bump.sh

.PHONY: graph-gates
graph-gates: graph-kit-checkout
	cd graph-kit && swift run -c release graph-layout-lab
	cd graph-kit && swift run -c release graph-engine-lab
	cd graph-kit && node scripts/conformance-memory.mjs

# agent/v2 wire (schema/agent-v2): fixture validity, schema coverage, the
# emitter roster and the model chain. Node only.
.PHONY: agent-v2-gates
agent-v2-gates:
	node scripts/conformance-agent-v2.mjs

# Host API v1 contract (schema/host-api/v1): envelope, command registry, events
# and their fixtures. Node only and fast, so it belongs in `contract-gates`.
.PHONY: host-api-check
host-api-check:
	node scripts/conformance-host-api.mjs

# Relay v1 shared vectors (schema/relay/v1) and the node:crypto reference.
.PHONY: relay-check
relay-check:
	node scripts/relay-vectors.mjs
	node --test scripts/relay-vectors.test.mjs

# HTTP endpoint contract (schema/http): request and response shapes per route
# group, checked against the roster. Part of `regression`; fast (node only).
# The HTTP inventory gate validates ROUTE COVERAGE from the generator output
# (`--coverage`), never the committed snapshot: INVENTORY.md is generated, CI
# regenerates it, and a stale copy must not fail a push. scripts/http-inventory.test.mjs
# proves both halves of that rule.
.PHONY: contract-gates
contract-gates:
	node scripts/conformance-http.mjs
	# The bus modules load core/config.mjs; a throwaway data dir keeps this static check off the real data and clear of
	# the legacy kb/ tripwire.
	d=$$(mktemp -d) && LLMIDE_DATA_DIR="$$d" node scripts/conformance-bus.mjs; s=$$?; rm -rf "$$d"; exit $$s
	node scripts/conformance-tasks.mjs
	$(MAKE) host-api-check
	$(MAKE) relay-check
	node scripts/gen-api-types.mjs --check
	node scripts/gen-openapi.mjs --check
	node scripts/http-inventory.mjs --coverage
	node --test scripts/http-inventory.test.mjs
	node scripts/gen-design-tokens.mjs --check

# Regenerate the HTTP inventory snapshot. Not a gate and never needed for a
# push: `contract-gates` validates coverage from the generator output, and CI
# regenerates the file. Use it when you want a current snapshot in the working
# tree (e.g. while reading the caller table). `inventory-check` is the full
# drift check, for a deliberate freshness audit, not a push gate.
.PHONY: inventory inventory-check
inventory:
	node scripts/http-inventory.mjs

inventory-check:
	node scripts/http-inventory.mjs --check

# Feature matrix: every removable feature switched off, one row at a time,
# server side (feature_disabled 404s, /health features and endpoints, extension
# REQUIRED_ENDPOINTS, live contract in assert mode). Not in `regression`: it boots
# a server per row (~40 s), so the nightly job runs it (.github/workflows/feature-matrix.yml).
#   make feature-matrix                       every row
#   make feature-matrix FM_ARGS="--key doc_gen"
.PHONY: feature-matrix
feature-matrix:
	node scripts/feature-matrix.mjs $(FM_ARGS)

# Design tokens: schema/design/tokens.json -> schema/design/tokens.css (and the ui-kit copies).
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

# Token & speed gate (Phase 1 P17). NOT in `regression`: a real run spends
# tokens (one short turn per scenario on the cheapest model). Run on demand or
# nightly; `token-bench-fake` exercises the same pipeline with no model calls.
# See docs/how-to/run-the-token-bench.md.
.PHONY: token-bench token-bench-fake
token-bench:
	node scripts/token-bench.mjs

token-bench-fake:
	node scripts/token-bench.mjs --fake

# Enable the repo's git hooks (.githooks/). Run once per clone.
.PHONY: hooks
hooks:
	git config core.hooksPath .githooks
	@echo "✓ git hooks enabled (.githooks). pre-push runs the gates for what changed (see .githooks/pre-push); bypass with --no-verify."

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
	node scripts/user-needs.mjs --check
