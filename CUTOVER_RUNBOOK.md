# OnFleet Africa — SQLite → Postgres Production Cutover Runbook

**Status:** Not yet executed. This document is the plan; nothing here has been run against production.

**Scheduled window: Tuesday 2026-08-11, 02:00–04:00 SAST.** (~6 days out from when this was written — enough time to close the remaining pre-flight checklist items below, particularly the fresh-data rehearsal.)

## What this is

OnFleet's business data (users, bikes, agreements, payments, wallets, KYC, audit logs — 27 tables) currently lives in SQLite (`backend/data/onfleet.db`, a Railway Volume). GPS/tracking data already lives in the project's Postgres database. The application code has been fully rewritten (locally, unpushed) to read and write business data from that same Postgres database instead of SQLite, eliminating the two-database split.

This cutover:
1. Creates the 27 business tables in the existing production Postgres database
2. Copies every row from production SQLite into them
3. Verifies the copy is correct
4. Deploys the Postgres-only application code
5. Confirms the live app is healthy, then reopens traffic

**Blast radius:** the entire app (rider app, fleet-owner portal, admin console, Paystack payments). No staging environment exists, so this runs directly against production data with real money involved. Everything below is designed so any failure before step 10 (code deploy) leaves production completely unaffected — SQLite is never modified by this process, only read.

## Timing

**Locked in: Tuesday 2026-08-11, 02:00–04:00 SAST.**

Reasoning: OnFleet's traffic is delivery-rider-driven, concentrated around meal times (roughly 07:00–09:00, 11:00–14:00, 18:00–21:00 SAST) and admin/ops activity during business hours. 02:00–04:00 avoids all of that. A weeknight (not Friday/weekend) means ops staff are back at their desks the same or next business day if anything needs attention, rather than the issue sitting unattended over a weekend. Adjust if you know OnFleet's actual traffic doesn't match this assumption — I don't have real analytics for this, it's a standard default.

Expected downtime: however long step 4 (freeze) through step 11 (reopen) takes — with ~150 rows of seed-scale data this ran in seconds locally, but production row counts and Railway's deploy time will dominate. Budget **30–45 minutes** to be safe, most of it Railway's build/deploy time, not the data migration itself.

## Roles

Everything below is written as commands to run from a machine with `psql`/`pg_dump`/`pg_restore` installed (your laptop, not Railway — Railway's default Node build image doesn't ship Postgres client tools) and network access to production's `DATABASE_URL`. **I (Claude) can execute these commands if you want me to drive the window live** — but per the standing safety rule, I will stop and ask for your explicit go-ahead at every `⛔ STOP` gate below rather than running straight through, since this is production data with no undo button on some of these steps. You're free to run any step yourself instead.

---

## Phase 1 — Pre-flight (complete these *before* the window, not during)

- [x] **Confirm Railway env vars.** `DATABASE_URL` points at production Postgres, `PAYSTACK_SECRET_KEY`/`PAYSTACK_PUBLIC_KEY` are live keys. **Confirmed by Kagiso.**
- [x] **Confirm you can scale the Railway service to 0 replicas**, and deploy-while-scaled-to-0 behavior is understood. **Confirmed by Kagiso.**
- [ ] **Confirm `postgresql-client` (`pg_dump`, `pg_restore`, `psql`) is installed** on whichever machine will run the backup/migration commands. `brew install postgresql@15` on macOS if not.
- [ ] **Re-run the local rehearsal once more against a fresh copy of production data** (a downloaded `onfleet.db` + a scratch Postgres schema), not the months-old `onfleet_migration_dev` state — production's real row counts, real data quirks, and real timestamp shapes may differ from the original rehearsal seed data. This is the single highest-value pre-flight step; don't skip it. Re-use the exact steps in Phase 2/3 below but against `--target-schema=cutover_rehearsal` and a throwaway local Postgres, then `DROP SCHEMA cutover_rehearsal CASCADE` when done.
- [ ] **Notify anyone who needs to know** (ops/admin users, and yourself as a heads-up) that there will be a brief outage during the window. Not required to be public-facing given the small scale, but internal staff shouldn't be mid-task in the admin console when it goes down.
- [ ] **Confirm no one else is mid-deploy** — check Railway's deploy history for anything in flight, and confirm you're not about to push over someone else's uncommitted work.

⛔ **STOP — do not proceed to Phase 2 until every box above is checked and you've explicitly said to proceed.**

---

## Phase 2 — Backup (can run *before* the freeze; SQLite's online backup API is safe against a live database)

```bash
cd backend
DATABASE_URL="<production DATABASE_URL>" DB_PATH=/path/to/downloaded/onfleet.db \
  node scripts/backup.js
```

This writes to `backend/backups/<timestamp>/` with a manifest (file sizes, SHA-256 checksums, row-count spot-checks). Confirm the manifest looks sane — nonzero file sizes, row counts roughly matching what you'd expect — before continuing.

**Getting the SQLite file to back up from:** since this runs from your laptop, not inside Railway's container, you need a copy of `backend/data/onfleet.db` first — Kagiso is handling the Railway-side retrieval of this file directly, not scripted here.

⛔ **STOP — confirm the backup succeeded and the manifest looks correct before proceeding.**

---

## Phase 3 — Freeze writes

In the Railway dashboard: **scale the app service to 0 replicas.**

Wait for the running instance to fully stop (Railway's dashboard shows this). This is the moment SQLite becomes the final, frozen source of truth — nothing can write to it anymore until the new Postgres-based code is live.

Take a **second, final SQLite backup** now that writes are frozen (repeat the `backup.js --sqlite-only` command from Phase 2) — this is the copy the data migration will actually read from, so it must be taken *after* the freeze, not before.

⛔ **STOP — confirm the service shows 0 running replicas and the post-freeze backup succeeded before proceeding. This is the last point where aborting costs nothing — the app comes back exactly as it was the moment you scale back to 1 replica.**

---

## Phase 4 — Create the business-data schema in production Postgres

```bash
cd backend
DATABASE_URL="<production DATABASE_URL>" npx node-pg-migrate up
```

This runs migration `1785919620135_business-data-schema.cjs` (creates the 27 empty business tables) — **not** `1785919957643_business-data-tracking-fks.cjs` yet, that one comes after data is loaded (Phase 6).

Confirm with `psql "<production DATABASE_URL>" -c '\dt'` that the new tables exist and are empty (`SELECT COUNT(*) FROM agreements;` etc. should all be 0).

---

## Phase 5 — Copy the data

```bash
cd backend
DATABASE_URL="<production DATABASE_URL>" DB_PATH=/path/to/post-freeze-backup/onfleet.db \
  node scripts/migrate-business-data-to-postgres.js
```

Point `DB_PATH` at the **post-freeze** backup from Phase 3, not the pre-freeze one from Phase 2. This is read-only against SQLite and safe to re-run (`ON CONFLICT (id) DO NOTHING`) if you need to retry after fixing something.

Watch the output for any `WARNING unrecognized timestamp shape` or `WARNING unexpected date shape` lines — the script passes unrecognized values through as-is rather than failing, so these need eyeballing, not just a clean exit code.

---

## Phase 6 — Verify

Run these against production Postgres (`psql "<production DATABASE_URL>"`) and compare against the same queries run against the frozen SQLite backup (`sqlite3 /path/to/post-freeze-backup/onfleet.db`):

```sql
-- Row counts — every one of these should match exactly between SQLite and Postgres
SELECT COUNT(*) FROM users; SELECT COUNT(*) FROM bikes; SELECT COUNT(*) FROM agreements;
SELECT COUNT(*) FROM payments; SELECT COUNT(*) FROM payment_schedules; SELECT COUNT(*) FROM applications;
-- ...repeat for all 27 tables. Row count mismatch on ANY table = abort, do not proceed.

-- Money totals — must match to the cent
SELECT COALESCE(SUM(amount),0) FROM payments WHERE status='success';
SELECT COALESCE(SUM(COALESCE(NULLIF(net_amount,0),amount)),0) FROM payments WHERE status='success';
SELECT COALESCE(SUM(balance),0) FROM fleet_wallets;

-- Orphan-FK checks — every one of these must return 0 rows
SELECT a.id FROM agreements a LEFT JOIN bikes b ON b.id=a.bike_id WHERE b.id IS NULL;
SELECT a.id FROM agreements a LEFT JOIN users u ON u.id=a.user_id WHERE u.id IS NULL;
SELECT p.id FROM payments p LEFT JOIN agreements a ON a.id=p.agreement_id WHERE a.id IS NULL;
SELECT ps.id FROM payment_schedules ps LEFT JOIN agreements a ON a.id=ps.agreement_id WHERE a.id IS NULL;
-- (extend to every FK relationship in the schema — see migrations/1785919620135_business-data-schema.cjs for the full list)

-- Sequences ahead of MAX(id) — required before any new row can be inserted post-cutover
SELECT 'agreements', MAX(id), nextval(pg_get_serial_sequence('agreements','id')) - 1 FROM agreements;
-- repeat per table, or trust migrate-business-data-to-postgres.js's own sequence-reset step and spot-check 2-3

-- Spot-check 10 real agreements end-to-end: schedule total vs. paid total, compared query-for-query
-- against the same agreement IDs in SQLite. Pick a mix of active/completed/discontinued agreements.
SELECT id, agreement_no, total_amount,
  (SELECT COALESCE(SUM(amount_due),0) FROM payment_schedules WHERE agreement_id = agreements.id) AS schedule_total,
  (SELECT COALESCE(SUM(COALESCE(NULLIF(net_amount,0),amount)),0) FROM payments WHERE agreement_id = agreements.id AND status='success') AS paid_total
FROM agreements WHERE id IN (/* 10 real ids */);
```

⛔ **STOP — every check above must pass cleanly. Any row-count mismatch, nonzero orphan-FK query, or money-total mismatch means abort: do not run Phase 7, do not push code. Scale the Railway service back to 1 replica — production resumes on SQLite exactly as it was, untouched. Diagnose and restart from Phase 4 (the schema is idempotent to re-create, or `DROP` the 27 tables and start clean) once the issue is understood.**

---

## Phase 7 — Harden foreign keys from tracking data

```bash
cd backend
DATABASE_URL="<production DATABASE_URL>" npx node-pg-migrate up
```

This runs the remaining migration, `1785919957643_business-data-tracking-fks.cjs` — adds FKs from `tracking_devices`/`geofences`/`tracking_alerts` etc. into the now-populated `bikes`/`users` tables. Postgres refuses to add a validated FK against dangling values, so this migration failing is itself a second, independent orphan-data check on top of Phase 6's manual queries.

If it fails: same abort path as Phase 6 — scale back to 1 replica, diagnose, retry.

---

## Phase 8 — Deploy the application code

```bash
git push origin main
```

Local `main` is currently 21 commits ahead of `origin/main` (or however many are in front by the time you run this — check `git log --oneline origin/main..main` first). This is a **fast-forward push, not a merge** — confirm `git status` shows nothing uncommitted and `git log --oneline -5` looks like the expected Postgres-rewrite history before pushing.

Railway auto-deploys on push to `main`. Watch the Railway dashboard for the build to complete.

⛔ **STOP — confirm the Railway build succeeded (green, not red/crashed) before proceeding. If it failed to build or crashed on boot, do NOT scale up traffic — you're still safely at 0 replicas with old code in the image but not running. Fix forward (new commit + push) or revert (`git revert`, push) as appropriate.**

---

## Phase 9 — Smoke test before reopening traffic

With the service still at 0 replicas (or, if Railway auto-scales on deploy, immediately after it comes up), hit the live URL directly and confirm, in order:

1. `GET /` or a health endpoint responds
2. Admin login works (`POST /api/auth/login`) — confirms Postgres auth path is live
3. `GET /api/bikes` (admin) returns real bikes, not an empty list or a 500
4. `GET /api/agreements` (admin) returns real agreements with correct-looking totals
5. Open one real agreement's detail page and confirm the payment schedule/summary numbers look right
6. If comfortable doing so live: trigger one real Paystack webhook event (or check Paystack's dashboard for the last few webhook deliveries) to confirm `/api/payments/paystack/webhook` is reachable and processes correctly

⛔ **STOP — if anything in this list looks wrong, do not open traffic. Roll back (see below) rather than debugging live with real users on the line.**

---

## Phase 10 — Reopen traffic

Scale the Railway service back to **1 replica** (or whatever it was before).

Monitor closely for the first 15–30 minutes: Railway logs, Paystack webhook success rate in the Paystack dashboard, and spot-check a few real user actions if you have a test account.

---

## Rollback

- **Any failure through Phase 7 (before code push):** scale back to 1 replica. Production is completely unaffected — the running code never changed, SQLite was only read from. The new Postgres tables can be left in place (harmless, unused by the old code) or dropped; no rush either way.
- **Phase 8 fails to build/boot:** stay at 0 replicas, fix forward or `git revert` + push, retry Phase 8.
- **Phase 9 smoke test fails, or Phase 10 reveals a problem shortly after reopening:** `git revert` the cutover commits (or use Railway's deploy-history rollback to redeploy the previous build) and push — this puts the OLD, SQLite-reading code back. **Important:** any writes that happened against Postgres during the broken window (real payments, agreement updates, etc.) will NOT be reflected back in SQLite automatically — reconciling those is a manual, case-by-case task if it happens. This is the actual reason Phase 9's smoke test matters: catch it before real traffic resumes, not after.

## Post-cutover cleanup (not urgent, do whenever)

- Once confident the cutover is stable (a few days), remove `backend/src/db.js` and the now-dead SQLite dependency (`better-sqlite3`) from `package.json`, and delete the SQLite Railway Volume.
- `services/agreementLifecycle.js` (the SQLite original) has been fully dead code since the application-layer conversion — safe to delete.
- Update `DEPLOY.md`'s "Move to PostgreSQL" checklist item — it'll be done.
