// eslint.config.js
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const noRandom = {
  object: 'Math',
  property: 'random',
  message: 'Use an injectable randomness source.',
};
const noNow = {
  object: 'Date',
  property: 'now',
  message: 'Use an injectable clock.',
};

export default tseslint.config(
  {
    ignores: ['dist/', 'node_modules/', 'output/', 'docs/'],
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
      // Defensive checks on untrusted input look "unnecessary" to the type system.
      '@typescript-eslint/no-unnecessary-condition': 'off',
      // Async functions are kept where a port or interface demands a Promise (errors become rejections).
      '@typescript-eslint/require-await': 'off',
      // Records are deleted by computed key on purpose (null-prototype records, Object.hasOwn guarded).
      '@typescript-eslint/no-dynamic-delete': 'off',
      // Async store implementations extend the synchronous MemoryStore on purpose.
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { inheritedMethods: false } }],
      '@typescript-eslint/unified-signatures': 'off',
      'no-restricted-properties': ['error', noRandom, noNow],
    },
  },
  {
    files: ['**/*.test.ts', 'packages/testing/**'],
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
    files: ['apps/**'],
    rules: {
      'no-restricted-properties': ['error', noRandom],
    },
  },
  {
    files: ['**/*.config.{js,mjs,cjs,ts,mts,cts}'],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
