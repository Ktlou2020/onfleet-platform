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
    // 10s was tight and getting tighter. Every Postgres-backed file shares
    // one real database and they run sequentially, so a single test is a
    // handful of HTTP round trips plus a TRUNCATE over eighty-odd tables; at
    // ~1,480 tests the slowest were brushing the limit and failing on the
    // clock rather than on an assertion. Two failures were chased that way —
    // a 404 and a timeout — both passing alone and both in the harness
    // rather than the product.
    //
    // This is the ceiling, not the target. A test that genuinely hangs still
    // fails, just twenty seconds later.
    testTimeout: 20000,
  },
});
