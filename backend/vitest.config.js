const { defineConfig } = require('vitest/config');

module.exports = defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./tests/setup.js'],
    // Every test file gets its own module registry (and so its own :memory: db.js
    // instance) — required for DB isolation between files, see tests/setup.js.
    isolate: true,
    // Postgres-backed test files (tests/dunningService.test.js etc.) all share
    // one real database — running files in parallel means one file's
    // TRUNCATE races another file's inserts. SQLite files don't need this
    // (each gets its own :memory: db), but there's no way to parallelize only
    // some files, so the whole suite runs sequentially.
    fileParallelism: false,
    testTimeout: 10000,
  },
});
