import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

// ---------------------------------------------------------------------------
// Module layering boundaries (CLAUDE.md "Module Boundaries" + RESTRUCTURE_PLAN.md §4.1)
//
//   L0 core        → nothing internal
//   L1 kb          → core                       (data access only)
//   L2 server libs → core, kb                   (auth/vault/jwt/rate-limit/…)
//   L3 agents, llm_agent, connectors, graphkit, guardrails, plugins,
//      llm-sources, mcp → L0–L2 (agents may also use graphkit/guardrails/connectors)
//   L4 routes      → anything; NOTHING imports a route module
//
// Enforced with no-restricted-imports regex patterns. This is a RATCHET:
// current violations are grandfathered in per-file overrides below — do not
// add new files to those lists; Phase 2 of RESTRUCTURE_PLAN.md removes them.
// Note: the core rule does not see dynamic import() — best-effort by design.
// ---------------------------------------------------------------------------
const ROUTE_MODULES = {
  regex: '(^|/)(kb/router\\.mjs|kb/routes/|server/(ai|auth|export)-routes\\.mjs|server/control-plane\\.mjs)',
  message: 'Route modules are the top layer — nothing imports them. Move the shared helper into a library module.',
};
const forbidLayers = (layers) => ({
  'no-restricted-imports': ['error', {
    patterns: [
      {
        regex: `(^|/)(${layers.join('|')})/`,
        message: `This layer must not import from: ${layers.join(', ')} (see CLAUDE.md "Module Boundaries").`,
      },
      ROUTE_MODULES,
    ],
  }],
});

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
  {
    files: ['core/**/*.mjs'],
    rules: forbidLayers(['kb', 'server', 'agents', 'llm_agent', 'connectors', 'graphkit', 'guardrails', 'plugins', 'llm-sources', 'mcp', 'src']),
  },
  {
    files: ['kb/**/*.mjs'],
    rules: forbidLayers(['server', 'agents', 'llm_agent', 'connectors', 'graphkit', 'guardrails', 'plugins', 'llm-sources', 'mcp', 'src']),
  },
  {
    files: ['server/**/*.mjs'],
    rules: forbidLayers(['agents', 'llm_agent', 'connectors', 'graphkit', 'guardrails', 'plugins', 'llm-sources', 'mcp', 'src']),
  },
  {
    files: ['connectors/**/*.mjs', 'graphkit/**/*.mjs', 'guardrails/**/*.mjs', 'plugins/**/*.mjs', 'llm-sources/**/*.mjs', 'mcp/**/*.mjs'],
    rules: forbidLayers(['server', 'agents', 'llm_agent', 'src']),
  },
  {
    files: ['agents/**/*.mjs'],
    rules: forbidLayers(['llm_agent', 'plugins', 'llm-sources', 'mcp', 'src']),
  },
  {
    files: ['llm_agent/**/*.mjs'],
    rules: forbidLayers(['agents', 'src']),
  },
  {
    // Browser code must stay browser-only — no Node-side layer may leak in.
    files: ['src/**/*.{ts,tsx}'],
    rules: forbidLayers(['core', 'kb', 'server', 'agents', 'llm_agent', 'connectors', 'graphkit', 'guardrails', 'plugins', 'llm-sources', 'mcp']),
  },
  {
    // Routes layer (L4): may import anything; nothing imports it (enforced
    // above via ROUTE_MODULES).
    files: ['kb/router.mjs', 'kb/routes/**/*.mjs', 'server/ai-routes.mjs', 'server/auth-routes.mjs', 'server/export-routes.mjs', 'server/control-plane.mjs'],
    rules: { 'no-restricted-imports': 'off' },
  },
  {
    // GRANDFATHERED violations — the Phase-2 ratchet (RESTRUCTURE_PLAN.md).
    // Do NOT add files here; each entry dies when its edge is refactored:
    //  - kb/activity.mjs → server/audit.mjs        (redact belongs in core/)
    //  - kb/install-project-skills.mjs → llm_agent/skills/skill-library.mjs
    //  - llm_agent/runtime/{route,memory-extract}.mjs,
    //    llm_agent/runtime/handlers/{fetch-url,web-search}.mjs → agents/*
    //    (dies when the shared provider layer is extracted)
    //  - llm-sources/registry.mjs ↔ llm_agent/skills/skill-library.mjs
    //    (real import CYCLE — resolveCentralSkillsRepo must move down a layer)
    files: [
      'kb/activity.mjs',
      'kb/install-project-skills.mjs',
      'llm_agent/runtime/route.mjs',
      'llm_agent/runtime/memory-extract.mjs',
      'llm_agent/runtime/handlers/fetch-url.mjs',
      'llm_agent/runtime/handlers/web-search.mjs',
      'llm-sources/registry.mjs',
    ],
    rules: { 'no-restricted-imports': 'off' },
  },
  {
    ignores: ['dist/', 'node_modules/', '*.d.ts'],
  },
);
