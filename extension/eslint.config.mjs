import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

// ---------------------------------------------------------------------------
// Module layering boundaries — the allowOnly() calls below ARE the layer
// diagram in CLAUDE.md "Module Boundaries"; edit the two together.
//
// Enforced with no-restricted-imports regex patterns, anchored to RELATIVE
// specifiers ('./…', '../…') so npm package subpaths that happen to contain a
// layer-named segment (e.g. '@scope/core/tokens') can't false-positive.
// This is a RATCHET at zero violations — never add per-file exemptions;
// refactor the offending edge instead.
// Note: the core rule does not see dynamic import() — best-effort by design.
// ---------------------------------------------------------------------------

// Every internal layer directory (plus src, the browser bundle).
const LAYERS = ['core', 'kb', 'server', 'providers', 'routes', 'agents', 'llm_agent', 'connectors', 'graphkit', 'guardrails', 'plugins', 'llm-sources', 'mcp', 'src'];

// Matches only relative specifiers, at any ../ depth.
const REL = '^(\\./|(\\.\\./)+)';

const ROUTE_MODULES = {
  // Nothing imports a route module — including a server-lib importing a
  // sibling route file ('./auth-routes.mjs', no directory in the specifier).
  regex: `${REL}(.*/)?(routes/.+|(ai|auth|export)-routes\\.mjs$|control-plane\\.mjs$)`,
  message: 'Route modules are the top layer — nothing imports them. Move the shared helper into a library module.',
};

// Claude-linker boundary: the Agent SDK package is imported ONLY inside
// llm_agent/sdk/ (the server-side Claude linker), so an SDK update touches
// the linker and nothing else. See docs/explanation/claude-linker.md.
const CLAUDE_SDK_IMPORT = {
  regex: '^@anthropic-ai/claude-agent-sdk',
  message: 'The Claude Agent SDK may only be imported inside llm_agent/sdk/ (the Claude linker) — call its exports instead. See docs/explanation/claude-linker.md.',
};

const forbidLayers = (layers, { allowClaudeSdk = false } = {}) => ({
  'no-restricted-imports': ['error', {
    patterns: [
      {
        regex: `${REL}(${layers.join('|')})/`,
        message: `This layer must not import from: ${layers.join(', ')} (see CLAUDE.md "Module Boundaries").`,
      },
      ROUTE_MODULES,
      ...(allowClaudeSdk ? [] : [CLAUDE_SDK_IMPORT]),
    ],
  }],
});

// The block's files may import ONLY the named layers (plus npm packages,
// node built-ins, and same-directory siblings). Forbid = complement, so a
// newly added layer directory is forbidden everywhere until explicitly
// allowed — additions to LAYERS ratchet automatically.
const allowOnly = (...allowed) => forbidLayers(LAYERS.filter((l) => !allowed.includes(l)));

// llm_agent's allow-list, shared by the llm_agent block and its llm_agent/sdk
// override so the two can never drift apart.
const LLM_AGENT_ALLOWED = ['core', 'kb', 'server', 'providers', 'graphkit', 'plugins', 'llm-sources', 'mcp'];

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Backend Node ESM (server, agents, kb, connectors, …). Provides Node
    // globals so `process`/`Buffer`/`fetch`/timers aren't flagged no-undef,
    // and turns off no-control-regex (the fence/redaction sanitizers use
    // \x00 ranges deliberately).
    files: ['**/*.mjs'],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
      }],
      'no-control-regex': 'off',
    },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
      }],
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'prefer-const': 'error',
      'no-var': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },
  {
    files: ['tests/**/*.mjs', 'server.mjs', 'scripts/**/*.mjs'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },

  // --- Layering boundaries (see header comment) ----------------------------
  // Claude-linker catch-all FIRST: files no layer block matches (server.mjs,
  // scripts/, root-level .mjs) still must not import the Agent SDK. The layer
  // blocks below override this rule wholesale for their files — each carries
  // CLAUDE_SDK_IMPORT itself, and llm_agent/sdk/ deliberately drops it. Tests
  // are the one exemption (they pin SDK behavior directly).
  {
    files: ['**/*.mjs'],
    ignores: ['tests/**'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [CLAUDE_SDK_IMPORT] }],
    },
  },
  // L0–L2
  { files: ['core/**/*.mjs'],      rules: allowOnly('core') },
  { files: ['kb/**/*.mjs'],        rules: allowOnly('core', 'kb') },
  { files: ['server/**/*.mjs'],    rules: allowOnly('core', 'kb', 'server') },
  { files: ['providers/**/*.mjs'], rules: allowOnly('core', 'kb', 'server', 'providers') },
  // L3 — leaf libraries reach only downward…
  {
    files: ['graphkit/**/*.mjs', 'guardrails/**/*.mjs', 'plugins/**/*.mjs', 'llm-sources/**/*.mjs', 'mcp/**/*.mjs'],
    rules: allowOnly('core', 'kb', 'providers'),
  },
  // …connectors additionally read credentials via server/vault (L2 — legal)…
  { files: ['connectors/**/*.mjs'], rules: allowOnly('core', 'kb', 'server', 'providers') },
  // …and the two agent systems orchestrate designated L3 peers.
  { files: ['agents/**/*.mjs'],    rules: allowOnly('core', 'kb', 'server', 'providers', 'connectors', 'graphkit', 'guardrails') },
  { files: ['llm_agent/**/*.mjs'], rules: allowOnly(...LLM_AGENT_ALLOWED) },
  // …of which llm_agent/sdk/ is the Claude linker — the ONE place allowed to
  // import the Agent SDK package (same layer allowances otherwise).
  {
    files: ['llm_agent/sdk/**/*.mjs'],
    rules: forbidLayers(
      LAYERS.filter((l) => !LLM_AGENT_ALLOWED.includes(l)),
      { allowClaudeSdk: true },
    ),
  },
  // Browser code must stay browser-only — no Node-side layer may leak in.
  { files: ['src/**/*.{ts,tsx}'],  rules: allowOnly('src') },
  {
    // Routes layer (L4): may import any Node layer, but never the browser
    // bundle — and no ROUTE_MODULES pattern here, since router.mjs mounts its
    // route modules. The server/ route files need this block to override the
    // server-libs block above.
    files: ['routes/**/*.mjs', 'server/ai-routes.mjs', 'server/auth-routes.mjs', 'server/export-routes.mjs', 'server/control-plane.mjs'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          regex: `${REL}(.*/)?src/`,
          message: 'Server-side code must not import browser code (src/).',
        }, CLAUDE_SDK_IMPORT],
      }],
    },
  },
  // No grandfathered violations — every cross-layer edge found when this
  // ratchet was introduced has been refactored away (provider-layer
  // extraction, core/redact-object.mjs, core/skills-repo.mjs). Keep it that
  // way: never add per-file exemptions.
  {
    ignores: ['dist/', 'node_modules/', '*.d.ts'],
  },
);
