# Backend tests

`npm test` runs everything with no setup required. Tests that need a real
Postgres database (claims, riderScoring, dunningService, backupService — the
routes/services already migrated off SQLite) skip themselves cleanly when
`DATABASE_URL` isn't set, via `describe.skipIf(!process.env.DATABASE_URL)`.

CI provides a throwaway Postgres automatically (see `.github/workflows/test.yml`).

## Running the Postgres-backed tests locally

One-time setup — create a dedicated test database and apply the schema
(tracking tables first via `trackingPgSchema.js`, since migration
`business-data-tracking-fks` adds foreign keys onto them and they aren't
created by node-pg-migrate):

```bash
createdb onfleet_test
DATABASE_URL="postgresql://localhost/onfleet_test" node -e "require('./src/migrations/trackingPgSchema').runTrackingSchema().then(() => process.exit(0))"
DATABASE_URL="postgresql://localhost/onfleet_test" npx node-pg-migrate up
```

Then run:

```bash
npm run test:pg
```

This points `TEST_DATABASE_URL` at `onfleet_test` for you — never point it at
`onfleet_migration_dev` or any database you use for manual exploration; the
Postgres tests `TRUNCATE ... CASCADE` every table between tests.
