import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import tseslint from 'typescript-eslint';

// Node 18-safe (import.meta.dirname is Node 20.11+).
const rootDir = dirname(fileURLToPath(import.meta.url));

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      '*.config.ts',
      '*.config.js',
      'eslint.config.js',
    ],
  },
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: rootDir },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
    },
  },
  // Layering (docs/ARCHITECTURE.md §2): dependencies point inward only.
  // domain imports nothing outward.
  {
    files: ['src/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: ['**/app/**', '**/adapters/**', '**/infra/**', '**/cli/**'] },
      ],
    },
  },
  // app composes domain only; the single composition root (wire.ts) is the lone exception.
  {
    files: ['src/app/**/*.ts'],
    ignores: ['src/app/wire.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: ['**/adapters/**', '**/infra/**', '**/cli/**'] },
      ],
    },
  },
);
