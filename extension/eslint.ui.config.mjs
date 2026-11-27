import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

// Hook-bug gate for the React/TypeScript trees outside extension/ (ui/screens,
// ui/kit/src, desktop/src, web/src). Run from the repo root by
// scripts/ui-lint-ratchet.mjs (`make lint-ui`). Deliberately tiny: only the two
// Rules-of-Hooks rules, no stylistic or type-aware rules, no autofix.
export default [
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { 'react-hooks': reactHooks },
    // Existing `eslint-disable-next-line react-hooks/exhaustive-deps` comments
    // stay as they are; do not turn the ones that match nothing into errors.
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
];
