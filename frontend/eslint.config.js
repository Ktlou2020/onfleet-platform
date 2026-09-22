import js from '@eslint/js';
import globals from 'globals';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';

// What this exists to catch.
//
// Two production outages came from mistakes a linter finds in under a second
// and `vite build` cannot find at all:
//
//   - The admin Workshop tab went blank for days because
//     workshopGuideContent.js used six lucide icons and imported none of
//     them. A bare identifier is valid syntax and bundles happily; it only
//     throws when a browser evaluates the module. That is `no-undef`.
//   - The GPS Tracking page went blank because hooks sat below an early
//     `if (loading) return`, so the hook count changed between renders. That
//     is `react-hooks/rules-of-hooks`.
//
// Both are errors here. Everything else is a warning on purpose: this is a
// running product, not a greenfield, and a lint run that fails the build over
// an unused variable would just get switched off.

export default [
  { ignores: ['dist/**', 'node_modules/**', '.harness/**', 'public/**'] },

  {
    files: ['**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.es2021 },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    settings: { react: { version: 'detect' } },
    plugins: { react, 'react-hooks': reactHooks },
    rules: {
      ...js.configs.recommended.rules,

      // The two that have actually cost us a working page.
      'no-undef': 'error',
      'react-hooks/rules-of-hooks': 'error',

      // Real, but not worth blocking a deploy over.
      'react-hooks/exhaustive-deps': 'warn',
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-empty': ['warn', { allowEmptyCatch: true }],

      // JSX counts as using a variable — without these, every component
      // imported for markup reads as unused.
      'react/jsx-uses-vars': 'error',
      'react/jsx-uses-react': 'error',
    },
  },

  // Service worker: its own globals, and it is not a module.
  {
    files: ['public/**/*.js', '**/sw.js'],
    languageOptions: { globals: { ...globals.serviceworker, ...globals.browser } },
  },
];
