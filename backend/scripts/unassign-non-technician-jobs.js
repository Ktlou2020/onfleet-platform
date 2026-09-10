'use strict';

// Clears the assignee on ACTIVE job cards that are held by someone who is not
// a technician.
//
// An unassigned job used to fall to whoever raised it, and job cards are raised
// by an admin account — so nearly every card on the platform showed as assigned
// to a superadmin who does not turn spanners. The create path no longer does
// that, but the cards already in that state still look owned, which is exactly
// what stopped anyone noticing a dozen jobs sitting untouched for weeks.
//
// Only open and in_progress cards are touched. A completed or cancelled card is
// a historical record of who the system recorded doing the work; clearing that
// would erase attribution to make a number look tidier, and those jobs do not
// need an owner because they are finished. If you genuinely want those cleared
// too, that is a separate and destructive decision — this script will not make
// it for you.
//
//   node scripts/unassign-non-technician-jobs.js             # dry run
//   APPLY=yes node scripts/unassign-non-technician-jobs.js   # apply
//
// Reversing it means reassigning by hand: the audit row records who held each
// card, so nothing is lost, but nothing puts it back automatically either.

const pgDb = require('../src/pgDb');
const APPLY = process.env.APPLY === 'yes';

(async () => {
  const { rows: targets } = await pgDb.query(`
    SELECT jc.id, jc.status, jc.job_type, jc.priority, jc.technician_id,
           u.full_name, u.role,
           FLOOR(EXTRACT(EPOCH FROM (NOW() - jc.created_at))/86400)::int AS days_open
      FROM job_cards jc
      JOIN users u ON u.id = jc.technician_id
     WHERE jc.status IN ('open','in_progress') AND u.role <> 'technician'
     ORDER BY jc.created_at`);

  console.log(`${APPLY ? 'APPLYING' : 'DRY RUN'} — ${targets.length} active job card(s) held by a non-technician\n`);

  let changed = 0;
  for (const t of targets) {
    console.log(`  #${t.id} ${t.job_type}/${t.priority} — ${t.days_open}d open, held by ${t.full_name} (${t.role}) -> unassigned`);
    if (!APPLY) continue;

    await pgDb.withTransaction(async (client) => {
      // Guarded on the assignee we read: if someone has picked this job up in
      // the meantime, leave it with them rather than pulling it back.
      const upd = await client.query(
        `UPDATE job_cards SET technician_id = NULL
          WHERE id = $1 AND technician_id = $2 AND status IN ('open','in_progress')`,
        [t.id, t.technician_id]);
      if (upd.rowCount !== 1) {
        console.log(`     skipped — job card #${t.id} changed underneath`);
        return;
      }
      await client.query(
        `INSERT INTO audit_logs (actor_id, action, entity, entity_id, metadata) VALUES ($1,$2,$3,$4,$5)`,
        [null, 'job_card.unassigned_from_non_technician', 'job_card', t.id,
         JSON.stringify({ was_technician_id: t.technician_id, was_name: t.full_name, was_role: t.role, days_open: t.days_open })]);
      changed++;
    });
  }

  console.log(`\n${APPLY ? 'cleared' : 'would clear'}: ${APPLY ? changed : targets.length}`);
  if (APPLY) {
    const { rows: check } = await pgDb.query(`
      SELECT COUNT(*) FILTER (WHERE technician_id IS NULL) AS unassigned,
             COUNT(*) AS active
        FROM job_cards WHERE status IN ('open','in_progress')`);
    console.log(`active job cards: ${check[0].active}, of which unassigned: ${check[0].unassigned}`);
  }
  await pgDb.pool.end();
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
