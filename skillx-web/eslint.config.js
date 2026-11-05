// eslint.config.js
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const noRandom = {
  object: 'Math',
  property: 'random',
  message: 'Use an injectable randomness source (RandomPort).',
};
const noNow = {
  object: 'Date',
  property: 'now',
  message: 'Use an injectable clock (ClockPort).',
};

export default tseslint.config(
  {
    ignores: ['dist/', 'node_modules/'],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      eqeqeq: ['error', 'always'],
      'no-var': 'error',
      'prefer-const': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/ban-ts-comment': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true },
      ],
      '@typescript-eslint/no-confusing-void-expression': 'off',
      // Defensive checks on untrusted input (relay responses, localStorage) look "unnecessary" to the type system.
      '@typescript-eslint/no-unnecessary-condition': 'off',
      // Async functions are kept where a port or interface demands a Promise (errors become rejections).
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/unified-signatures': 'off',
      'no-restricted-properties': ['error', noRandom, noNow],
    },
  },
  {
    files: ['**/*.test.ts'],
    rules: {
      'no-restricted-properties': ['error', noRandom],
      '@typescript-eslint/no-floating-promises': [
        'error',
        { allowForKnownSafeCalls: [{ from: 'package', package: 'node:test', name: ['test', 'it', 'describe', 'suite'] }] },
      ],
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
      '@typescript-eslint/unbound-method': 'off',
      '@typescript-eslint/switch-exhaustiveness-check': 'off',
    },
  },
  {
    // The one file allowed to touch the real clock, for the injectable ClockPort it implements.
    files: ['src/browser-ports.ts'],
    rules: {
      'no-restricted-properties': ['error', noRandom],
    },
  },
  {
    // Selective projections over the 21 protocol event types, not state machines:
    // each switch intentionally reacts to a handful of types and has a `default: break;` for the rest.
    files: ['src/project.ts'],
    rules: {
      '@typescript-eslint/switch-exhaustiveness-check': 'off',
    },
  },
  {
    // A plain Node script (no browser DOM, not part of the tsconfig'd app).
    files: ['serve.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        URL: 'readonly',
      },
    },
  },
  {
    files: ['**/*.config.{js,mjs,cjs,ts,mts,cts}', 'serve.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
