const { defineConfig } = require('vitest/config');

module.exports = defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./tests/setup.js'],
    // Every test file gets its own module registry (and so its own :memory: db.js
    // instance) — required for DB isolation between files, see tests/setup.js.
    isolate: true,
    testTimeout: 10000,
  },
});
