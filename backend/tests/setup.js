// Runs once per test file (vitest isolate: true gives each file its own module
// registry), before any test code or app/db imports in that file. Must set these
// env vars here rather than in individual test files, since db.js and auth.js
// read them at require-time.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-do-not-use-in-production';
process.env.JWT_EXPIRES_IN = '1h';
process.env.DB_PATH = ':memory:';
// Postgres-backed tests (claims, riderScoring, dunningService, backupService)
// need a real, throwaway DATABASE_URL — provided by CI's postgres service
// container, or locally via TEST_DATABASE_URL pointed at a migrated test db
// (see tests/README.md). If neither is present, leave it unset; those tests
// skip themselves via describe.skipIf(!process.env.DATABASE_URL) rather than
// failing, so `npm test` still runs clean with no Postgres available.
if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
} else if (!process.env.DATABASE_URL) {
  delete process.env.DATABASE_URL;
}
