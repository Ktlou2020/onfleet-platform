'use strict';

// Automated escalation on top of fleet.js's existing collections_actions log
// (previously 100% manual — a fleet-owner staff member had to remember to
// log each call/SMS/notice themselves). This adds an automatic tier that
// only acts when a human hasn't already gotten there first, so it augments
// manual collections work rather than overriding it.
//
// Platform-direct riders (bikes with no organization_id) aren't covered here
// — collections_actions is scoped to fleet-owner organizations by schema
// design, and platform-direct riders already get the existing overdue
// WhatsApp/SMS reminders via scheduler.js's runDailyReminders.

const pgDb = require('../pgDb');
const { sendNotification } = require('./notifierPg');
const { logAudit } = require('../utils/helpersPg');

const STAGE_ORDER = ['pending', 'contacted', 'notice_sent', 'recovery', 'resolved'];

function stageForDaysOverdue(daysOverdue) {
  if (daysOverdue >= 21) return 'recovery';
  if (daysOverdue >= 14) return 'notice_sent';
  if (daysOverdue >= 7) return 'contacted';
  return null; // under a week overdue — the existing daily reminder already covers this
}

async function runAutomatedDunning() {
  const { rows: overdueAgreements } = await pgDb.query(`
    SELECT a.id AS agreement_id, a.agreement_no, a.user_id, b.organization_id,
           MIN(s.due_date) AS oldest_overdue_due_date,
           SUM(s.amount_due - s.amount_paid) AS total_owed
    FROM agreements a
    JOIN bikes b ON b.id = a.bike_id AND b.organization_id IS NOT NULL
    JOIN payment_schedules s ON s.agreement_id = a.id AND s.status = 'overdue'
    WHERE a.status = 'active'
    GROUP BY a.id, a.agreement_no, a.user_id, b.organization_id
  `);

  const today = new Date().toISOString().slice(0, 10);

  for (const row of overdueAgreements) {
    try {
      const daysOverdue = Math.floor((Date.now() - new Date(row.oldest_overdue_due_date).getTime()) / 86400000);
      const targetStage = stageForDaysOverdue(daysOverdue);
      if (!targetStage) continue;

      const { rows: latestRows } = await pgDb.query(
        `SELECT stage, created_at::date AS created_date FROM collections_actions WHERE agreement_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [row.agreement_id]
      );
      const latest = latestRows[0];
      if (latest?.stage === 'resolved') continue; // human closed it out — don't reopen automatically
      if (latest && STAGE_ORDER.indexOf(latest.stage) >= STAGE_ORDER.indexOf(targetStage)) continue; // already at/past target (human or prior automation)
      if (latest?.created_date === today) continue; // one automated step per agreement per day

      const { rows: adminRows } = await pgDb.query(
        `SELECT id FROM users WHERE organization_id = $1 AND role = 'fleet_owner_admin' AND status = 'active' AND deleted_at IS NULL ORDER BY created_at ASC LIMIT 1`,
        [row.organization_id]
      );
      const actorId = adminRows[0]?.id;
      if (!actorId) continue; // no one to attribute the action to — skip rather than guess

      const owed = Number(row.total_owed || 0).toFixed(2);
      const actionType = targetStage === 'recovery' ? 'note' : 'whatsapp';
      const notes = {
        contacted: `[Automated] ${daysOverdue} days overdue — reminder sent to rider`,
        notice_sent: `[Automated] ${daysOverdue} days overdue — formal notice sent to rider`,
        recovery: `[Automated] ${daysOverdue} days overdue — flagged for recovery review`,
      }[targetStage];

      const { rows: inserted } = await pgDb.query(
        `INSERT INTO collections_actions (agreement_id, organization_id, stage, action_type, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [row.agreement_id, row.organization_id, targetStage, actionType, notes, actorId]
      );

      if (targetStage === 'recovery') {
        await sendNotification({
          userId: actorId, channel: 'email', type: 'collections_recovery_flag',
          title: `Recovery review needed: ${row.agreement_no}`,
          message: `Agreement ${row.agreement_no} is ${daysOverdue} days overdue (R${owed} owed) and has been auto-flagged for recovery review. Please assess next steps.`,
        }).catch(() => {});
      } else {
        const { rows: riderRows } = await pgDb.query(`SELECT full_name FROM users WHERE id = $1`, [row.user_id]);
        const firstName = (riderRows[0]?.full_name || 'there').split(' ')[0];
        const message = targetStage === 'notice_sent'
          ? `URGENT NOTICE: Hi ${firstName}, your OnFleet agreement ${row.agreement_no} is ${daysOverdue} days overdue (R${owed} owed). Please settle immediately to avoid further action.`
          : `Hi ${firstName}, your OnFleet agreement ${row.agreement_no} is ${daysOverdue} days overdue (R${owed} owed). Please make payment as soon as possible.`;
        await sendNotification({ userId: row.user_id, channel: 'whatsapp', type: 'collections_escalation', message }).catch(() => {});
      }

      await logAudit(actorId, 'collections.auto_escalate', 'collections_actions', inserted[0].id,
        { agreement_id: row.agreement_id, stage: targetStage, days_overdue: daysOverdue });
    } catch (err) {
      console.error(`[dunning] failed for agreement ${row.agreement_id}:`, err.message);
    }
  }
}

module.exports = { runAutomatedDunning };
