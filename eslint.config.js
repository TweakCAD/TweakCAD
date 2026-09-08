/**
 * ESLint flat config for the CAD app.
 *
 * Self-contained on purpose: this repo is published standalone, so it can't
 * rely on the `eslint.config.js` that sits in the dev workspace root (which
 * was never runnable anyway — eslint was in no package.json until now).
 *
 * Type-aware rules are deliberately NOT enabled (`strictTypeChecked` /
 * `projectService`). `tsc --noEmit` already runs over the same sources in
 * `pnpm build` and `pnpm typecheck`, so the type-aware lint pass would mostly
 * duplicate it at several times the runtime. This config exists to catch what
 * the compiler doesn't: unused code, `any` creeping in, stray `console.log`,
 * `eval`, `var`.
 */
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.strict,
  // The codebase already carries eslint-disable-next-line comments for these
  // rules, written before eslint was ever installed.
  reactHooks.configs.flat['recommended-latest'],
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-non-null-assertion': 'warn',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },
  {
    // Tests legitimately reach for non-null assertions on fixtures they just
    // built, and log diagnostics while a gap is being chased down.
    files: ['**/*.test.ts', '**/*.test.tsx'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-console': 'off',
    },
  },
  {
    ignores: ['dist/**', 'node_modules/**', 'public/**', '**/*.js', '**/*.cjs', '**/*.mjs'],
  },
);
