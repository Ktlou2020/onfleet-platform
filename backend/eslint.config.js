'use strict';

const js = require('@eslint/js');
const globals = require('globals');

// Node/CommonJS half of the lint setup. See frontend/eslint.config.js for why
// this exists at all.
//
// The rule that earns its keep here is the same one: `no-undef`. The test
// suite covers a great deal, but a typo on a rarely-taken branch — an error
// path, a migration script run once a year — is exactly what it does not
// reach, and is exactly what this catches for free.
//
// Errors are reserved for "this is broken". Style and tidiness are warnings:
// a lint run that fails a deploy over an unused variable gets switched off,
// and then it catches nothing at all.

module.exports = [
  { ignores: ['node_modules/**', 'coverage/**', 'uploads/**'] },
  {
    files: ['**/*.js', '**/*.cjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      ...js.configs.recommended.rules,
      'no-undef': 'error',
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-empty': ['warn', { allowEmptyCatch: true }],
      // Escaping more than strictly necessary in a regex is harmless, and
      // several here are deliberate for readability.
      'no-useless-escape': 'warn',
      // Stripping control characters from spreadsheet text and CSV uploads is
      // the job, so matching them is not a mistake.
      'no-control-regex': 'off',
    },
  },
  {
    files: ['tests/**/*.js'],
    languageOptions: { sourceType: 'module', globals: { ...globals.node } },
  },
];
