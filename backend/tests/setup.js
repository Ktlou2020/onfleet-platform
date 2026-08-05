// Runs once per test file (vitest isolate: true gives each file its own module
// registry), before any test code or app/db imports in that file. Must set these
// env vars here rather than in individual test files, since db.js and auth.js
// read them at require-time.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-do-not-use-in-production';
process.env.JWT_EXPIRES_IN = '1h';
process.env.DB_PATH = ':memory:';
// Intentionally no DATABASE_URL — Postgres-backed tracking routes are out of
// scope for this suite; pgDb.query() throws clearly if a test hits one unmocked.
delete process.env.DATABASE_URL;
