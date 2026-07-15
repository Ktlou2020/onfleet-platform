const express = require('express');
const axios = require('axios');
const db = require('../db');
const { authRequired, adminOnly } = require('../middleware/auth');
const { logAudit, addDays, recalcScheduleStatuses, rebuildScheduleAllocations, updateAgreementBalance } = require('../utils/helpers');
const { writeContractSnapshot } = require('../services/contracts');
const { discontinueAgreement, reinstateDiscontinuedAgreement } = require('../services/agreementLifecycle');

const router = express.Router();
const PAYSTACK_BASE = 'https://api.paystack.co';
const RIDER_PLAN_AMOUNTS = [500, 650, 700, 750, 800, 850, 1000, 1200];

function getRiderPlanCode(weeklyAmount) {
  const amount = Math.round(Number(weeklyAmount));
  for (const amt of RIDER_PLAN_AMOUNTS) {
    if (amount === amt) return process.env[`PAYSTACK_RIDER_PLAN_${amt}`] || null;
  }
  return null;
}
const AGREEMENT_STATUS_VALUES = ['active', 'completed', 'defaulted', 'cancelled', 'paused', 'discontinued'];

function adminVisibleAgreementClause(aAlias = 'a', bAlias = 'b', uAlias = 'u') {
  return `${bAlias}.organization_id IS NULL AND ${uAlias}.organization_id IS NULL`;
}

function getAgreementBundle(agreementId, options = {}) {
  const scopeClause = options.adminVisible ? ` AND ${adminVisibleAgreementClause('a', 'b', 'u')}` : '';
  const ag = db.prepare(`SELECT a.*, b.make, b.model, b.registration, b.image_url, b.vin,
      b.last_known_lat, b.last_known_lng, b.last_location_at, b.next_service_date,
      b.next_service_km, b.odometer_km, b.status AS bike_status,
      u.full_name, u.email, u.phone, u.id_number
    FROM agreements a
    JOIN bikes b ON b.id = a.bike_id
    JOIN users u ON u.id = a.user_id
    WHERE a.id = ?${scopeClause}`).get(agreementId);
  if (!ag) return null;
  const application = ag.application_id ? db.prepare('SELECT * FROM applications WHERE id = ?').get(ag.application_id) : null;
  return { agreement: ag, application };
}

router.get('/mine', authRequired, (req, res) => {
  const ags = db.prepare(`SELECT a.*, b.make, b.model, b.registration, b.image_url, b.vin, b.status AS bike_status
    FROM agreements a JOIN bikes b ON b.id = a.bike_id
    WHERE a.user_id = ? ORDER BY a.created_at DESC`).all(req.user.id);
  res.json({ agreements: ags });
});

router.get('/', authRequired, adminOnly, (req, res) => {
  const { status = '', bike_status = '', exclude_bike_statuses = '' } = req.query;
  const where = [adminVisibleAgreementClause('a', 'b', 'u')];
  const values = [];
  const excludedBikeStatuses = String(exclude_bike_statuses || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  if (status) {
    where.push('a.status = ?');
    values.push(status);
  }
  if (bike_status) {
    where.push('b.status = ?');
    values.push(bike_status);
  }
  if (excludedBikeStatuses.length) {
    where.push(`b.status NOT IN (${excludedBikeStatuses.map(() => '?').join(',')})`);
    values.push(...excludedBikeStatuses);
  }

  const sql = `SELECT a.*, u.full_name, u.email, b.make, b.model, b.registration, b.status AS bike_status
    FROM agreements a
    JOIN users u ON u.id = a.user_id
    JOIN bikes b ON b.id = a.bike_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY a.created_at DESC`;

  const ags = db.prepare(sql).all(...values);
  res.json({ agreements: ags });
});

router.post('/bulk-discontinue', authRequired, adminOnly, (req, res) => {
  const agreementIds = Array.from(new Set((Array.isArray(req.body.agreement_ids) ? req.body.agreement_ids : [])
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0)));

  if (!agreementIds.length) {
    return res.status(400).json({ error: 'Select at least one agreement to discontinue' });
  }

  const summary = {
    requested: agreementIds.length,
    discontinued: [],
    skipped: [],
    not_found: []
  };

  for (const agreementId of agreementIds) {
    const agreement = db.prepare(`SELECT a.id, a.agreement_no, a.status
      FROM agreements a
      JOIN bikes b ON b.id = a.bike_id
      JOIN users u ON u.id = a.user_id
      WHERE a.id = ? AND ${adminVisibleAgreementClause('a', 'b', 'u')}`).get(agreementId);
    if (!agreement) {
      summary.not_found.push(agreementId);
      continue;
    }
    if (['completed', 'cancelled', 'discontinued'].includes(agreement.status)) {
      summary.skipped.push({ id: agreement.id, agreement_no: agreement.agreement_no, status: agreement.status });
      continue;
    }

    const result = discontinueAgreement({
      agreementId: agreement.id,
      reason: 'bulk_admin_discontinue',
      actorId: req.user.id,
      ip: req.ip,
      auditAction: 'agreement.bulk_discontinued'
    });

    summary.discontinued.push({
      id: agreement.id,
      agreement_no: agreement.agreement_no,
      previous_status: agreement.status,
      waived_rows: result.waived_rows
    });
  }

  res.json({
    ok: true,
    requested: summary.requested,
    discontinued_count: summary.discontinued.length,
    skipped_count: summary.skipped.length,
    not_found_count: summary.not_found.length,
    waived_schedule_rows: summary.discontinued.reduce((sum, item) => sum + Number(item.waived_rows || 0), 0),
    details: summary
  });
});

router.get('/:id', authRequired, (req, res) => {
  const isAdminPortalUser = ['admin', 'superadmin'].includes(req.user.role);
  const bundle = getAgreementBundle(req.params.id, { adminVisible: isAdminPortalUser });
  if (!bundle) return res.status(404).json({ error: 'Not found' });
  const ag = bundle.agreement;
  if (ag.user_id !== req.user.id && !isAdminPortalUser) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  recalcScheduleStatuses(ag.id);
  const schedule = db.prepare(`SELECT * FROM payment_schedules WHERE agreement_id = ? ORDER BY week_number`).all(ag.id);
  const payments = db.prepare(`SELECT * FROM payments WHERE agreement_id = ? ORDER BY COALESCE(paid_at, created_at) DESC`).all(ag.id);
  const applicationDocuments = ag.application_id ? db.prepare(`SELECT id, doc_type, file_path, original_name, status, uploaded_at
    FROM application_documents WHERE application_id = ? ORDER BY uploaded_at DESC`).all(ag.application_id) : [];

  const successfulPayments = payments.filter((payment) => payment.status === 'success');
  const creditedAmount = (payment) => Number(payment.net_amount || payment.amount || 0);
  const totalPaid = successfulPayments.reduce((sum, payment) => sum + creditedAmount(payment), 0);
  const remainingRaw = +(ag.total_amount - totalPaid).toFixed(2);

  // Derive weeks_paid, overdue, and next_due from payments (source of truth), not from
  // potentially-stale payment_schedules rows. This means no rebuild click is needed.
  const weeklyAmount = Number(ag.weekly_amount) || 0;
  const weeksPaid = weeklyAmount > 0 ? Math.floor(+(totalPaid / weeklyAmount).toFixed(10)) : 0;
  const today = new Date().toISOString().slice(0, 10);
  const nonWaivedSchedule = schedule.filter((s) => s.status !== 'waived');
  const weeksDueByToday = nonWaivedSchedule.filter((s) => s.due_date <= today).length;
  const amountDueByToday = +(weeksDueByToday * weeklyAmount).toFixed(2);
  const overdueRaw = Math.max(0, +(amountDueByToday - totalPaid).toFixed(2));
  const nextDueRaw = nonWaivedSchedule[weeksPaid] || null;
  const progressPct = ag.total_amount ? +((totalPaid / ag.total_amount) * 100).toFixed(1) : 0;
  const isDiscontinued = ag.status === 'discontinued';

  res.json({
    agreement: ag,
    application: bundle.application,
    application_documents: applicationDocuments,
    schedule,
    payments,
    summary: {
      total_paid: +totalPaid.toFixed(2),
      remaining: isDiscontinued ? 0 : remainingRaw,
      weeks_paid: weeksPaid,
      weeks_total: ag.total_weeks,
      overdue: isDiscontinued ? 0 : +overdueRaw.toFixed(2),
      next_due: isDiscontinued ? null : nextDueRaw,
      progress_pct: progressPct
    }
  });
});

router.post('/:id/sign', authRequired, (req, res) => {
  const bundle = getAgreementBundle(req.params.id);
  if (!bundle || bundle.agreement.user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
  const signature = req.body.signature || `${req.user.full_name} · ${new Date().toLocaleString('en-ZA')}`;
  const signedContractPath = writeContractSnapshot({
    agreement: bundle.agreement,
    rider: { ...bundle.agreement },
    bike: { ...bundle.agreement },
    application: bundle.application,
    signatureData: signature,
    kind: 'signed'
  });
  db.prepare(`UPDATE agreements SET signed_at = CURRENT_TIMESTAMP, signature_data = ?, signed_contract_path = ? WHERE id = ?`)
    .run(signature, signedContractPath, req.params.id);

  if (bundle.agreement.application_id) {
    const existing = db.prepare(`SELECT id FROM application_documents WHERE application_id = ? AND doc_type = 'signed_contract'`).get(bundle.agreement.application_id);
    if (existing) {
      db.prepare(`UPDATE application_documents SET file_path = ?, original_name = ?, mime_type = 'text/html', status = 'signed', uploaded_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(signedContractPath, `${bundle.agreement.agreement_no}-signed.html`, existing.id);
    } else {
      db.prepare(`INSERT INTO application_documents
        (application_id, user_id, doc_type, file_path, original_name, mime_type, status, uploaded_by)
        VALUES (?,?,?,?,?,?,?,?)`).run(
          bundle.agreement.application_id,
          bundle.agreement.user_id,
          'signed_contract',
          signedContractPath,
          `${bundle.agreement.agreement_no}-signed.html`,
          'text/html',
          'signed',
          req.user.id
        );
    }
  }

  logAudit(req.user.id, 'agreement.sign', 'agreements', Number(req.params.id));
  res.json({ ok: true, signed_contract_path: signedContractPath });
});

router.post('/:id/status', authRequired, adminOnly, (req, res) => {
  const { status } = req.body;
  if (!AGREEMENT_STATUS_VALUES.includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  const agreement = db.prepare(`SELECT a.*
    FROM agreements a
    JOIN bikes b ON b.id = a.bike_id
    JOIN users u ON u.id = a.user_id
    WHERE a.id = ? AND ${adminVisibleAgreementClause('a', 'b', 'u')}`).get(req.params.id);
  if (!agreement) return res.status(404).json({ error: 'Agreement not found' });
  db.prepare('UPDATE agreements SET status = ? WHERE id = ?').run(status, req.params.id);
  if (status === 'completed') db.prepare(`UPDATE bikes SET status = 'paid_off' WHERE id = ?`).run(agreement.bike_id);
  if (status === 'cancelled') db.prepare(`UPDATE bikes SET status = 'ready_to_go' WHERE id = ?`).run(agreement.bike_id);
  if (status === 'discontinued') {
    db.prepare(`UPDATE agreements SET discontinued_at = CURRENT_TIMESTAMP, discontinued_reason = 'admin_status_change' WHERE id = ?`).run(req.params.id);
    db.prepare(`UPDATE payment_schedules SET status = 'waived' WHERE agreement_id = ? AND status IN ('pending','upcoming','overdue')`).run(req.params.id);
  }
  if (agreement.status === 'discontinued' && status !== 'discontinued') {
    db.prepare(`UPDATE agreements SET discontinued_at = NULL, discontinued_reason = NULL WHERE id = ?`).run(req.params.id);
  }
  logAudit(req.user.id, 'agreement.status', 'agreements', Number(req.params.id), { previous_status: agreement.status, status });
  res.json({ ok: true });
});

router.post('/:id/reinstate', authRequired, adminOnly, (req, res) => {
  try {
    const agreement = db.prepare(`SELECT a.id
      FROM agreements a
      JOIN bikes b ON b.id = a.bike_id
      JOIN users u ON u.id = a.user_id
      WHERE a.id = ? AND ${adminVisibleAgreementClause('a', 'b', 'u')}`).get(req.params.id);
    if (!agreement) return res.status(404).json({ error: 'Agreement not found' });
    const result = reinstateDiscontinuedAgreement({ agreementId: Number(req.params.id), actorId: req.user.id, ip: req.ip });
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// POST /:id/rebuild-schedule — resets payment schedule rows and replays all payments from the payments table
router.post('/:id/rebuild-schedule', authRequired, adminOnly, (req, res) => {
  const agreement = db.prepare(`SELECT a.id
    FROM agreements a
    JOIN bikes b ON b.id = a.bike_id
    JOIN users u ON u.id = a.user_id
    WHERE a.id = ? AND ${adminVisibleAgreementClause('a', 'b', 'u')}`).get(req.params.id);
  if (!agreement) return res.status(404).json({ error: 'Agreement not found' });
  rebuildScheduleAllocations(agreement.id);
  logAudit(req.user.id, 'admin.agreement_schedule_rebuild', 'agreements', agreement.id, {}, req.ip);
  res.json({ ok: true });
});

// PUT /:id/balance — admin manually sets the outstanding remaining balance
router.put('/:id/balance', authRequired, adminOnly, (req, res) => {
  try {
    const agreement = db.prepare(`SELECT a.id
      FROM agreements a
      JOIN bikes b ON b.id = a.bike_id
      JOIN users u ON u.id = a.user_id
      WHERE a.id = ? AND ${adminVisibleAgreementClause('a', 'b', 'u')}`).get(req.params.id);
    if (!agreement) return res.status(404).json({ error: 'Agreement not found' });
    const result = updateAgreementBalance(Number(req.params.id), req.body.remaining_balance);
    logAudit(req.user.id, 'admin.agreement_balance_edit', 'agreements', agreement.id, {
      remaining_balance: result.remaining_balance,
      total_amount: result.total_amount
    }, req.ip);
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// PUT /:id/schedule — admin changes the number of installments (total_weeks)
router.put('/:id/schedule', authRequired, adminOnly, (req, res) => {
  try {
    const ag = db.prepare(`SELECT a.*
      FROM agreements a
      JOIN bikes b ON b.id = a.bike_id
      JOIN users u ON u.id = a.user_id
      WHERE a.id = ? AND ${adminVisibleAgreementClause('a', 'b', 'u')}`).get(req.params.id);
    if (!ag) return res.status(404).json({ error: 'Agreement not found' });

    const newTotalWeeks = Number(req.body.total_weeks);
    if (!Number.isInteger(newTotalWeeks) || newTotalWeeks < 1 || newTotalWeeks > 520) {
      return res.status(400).json({ error: 'total_weeks must be a whole number between 1 and 520' });
    }

    // Find the highest committed week (paid/partial/waived) — cannot go below this
    const committed = db.prepare(
      `SELECT COALESCE(MAX(week_number), 0) AS max_week FROM payment_schedules
       WHERE agreement_id = ? AND status IN ('paid', 'partial', 'waived')`
    ).get(ag.id);
    const minWeeks = committed.max_week || 0;

    if (newTotalWeeks < minWeeks) {
      return res.status(400).json({
        error: `Cannot reduce to ${newTotalWeeks} — week ${minWeeks} already has a payment recorded`
      });
    }

    const weeklyAmount = Number(ag.weekly_amount);
    const newTotalAmount = +(weeklyAmount * newTotalWeeks).toFixed(2);

    db.transaction(() => {
      // Remove all pending/overdue rows beyond the new total
      db.prepare(
        `DELETE FROM payment_schedules WHERE agreement_id = ? AND week_number > ? AND status NOT IN ('paid', 'partial', 'waived')`
      ).run(ag.id, newTotalWeeks);

      // Find the current highest week_number in the schedule
      const currentMax = db.prepare(
        `SELECT COALESCE(MAX(week_number), 0) AS max FROM payment_schedules WHERE agreement_id = ?`
      ).get(ag.id).max;

      // Insert any new rows needed
      const insert = db.prepare(
        `INSERT INTO payment_schedules (agreement_id, week_number, due_date, amount_due) VALUES (?,?,?,?)`
      );
      for (let w = currentMax + 1; w <= newTotalWeeks; w++) {
        insert.run(ag.id, w, addDays(ag.start_date, (w - 1) * 7), weeklyAmount);
      }

      db.prepare(`UPDATE agreements SET total_weeks = ?, total_amount = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(newTotalWeeks, newTotalAmount, ag.id);
    })();

    recalcScheduleStatuses(ag.id);
    logAudit(req.user.id, 'admin.agreement_schedule_edit', 'agreements', ag.id, {
      old_total_weeks: ag.total_weeks,
      new_total_weeks: newTotalWeeks,
      weekly_amount: weeklyAmount,
      new_total_amount: newTotalAmount
    }, req.ip);

    res.json({ ok: true, total_weeks: newTotalWeeks, total_amount: newTotalAmount, weekly_amount: weeklyAmount });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// POST /:id/subscription/init — admin generates a Paystack recurring-payment link for a rider
router.post('/:id/subscription/init', authRequired, adminOnly, async (req, res) => {
  try {
    const ag = db.prepare(`SELECT a.*, u.email, u.full_name
      FROM agreements a
      JOIN users u ON u.id = a.user_id
      JOIN bikes b ON b.id = a.bike_id
      WHERE a.id = ? AND ${adminVisibleAgreementClause('a', 'b', 'u')}`).get(req.params.id);
    if (!ag) return res.status(404).json({ error: 'Agreement not found' });

    const overrideAmount = req.body.plan_amount ? Math.round(Number(req.body.plan_amount)) : null;
    const weeklyAmount = overrideAmount || Math.round(Number(ag.weekly_amount));

    const planCode = getRiderPlanCode(weeklyAmount);
    if (!planCode) {
      return res.status(400).json({
        error: `No payment plan configured for R${weeklyAmount}/week. Available: R${RIDER_PLAN_AMOUNTS.join(', R')}.`
      });
    }

    const reference = `RSUB-ADM-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const resp = await axios.post(`${PAYSTACK_BASE}/transaction/initialize`, {
      email: ag.email,
      amount: weeklyAmount * 100,
      currency: 'ZAR',
      reference,
      plan: planCode,
      callback_url: process.env.PAYSTACK_CALLBACK_URL,
      metadata: {
        type: 'rider_subscription',
        rider_user_id: ag.user_id,
        agreement_id: ag.id,
        weekly_amount: weeklyAmount
      }
    }, { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } });

    logAudit(req.user.id, 'agreement.subscription_link_generated', 'agreements', Number(req.params.id), { plan_code: planCode, weekly_amount: weeklyAmount }, req.ip);

    res.json({
      authorization_url: resp.data.data.authorization_url,
      access_code: resp.data.data.access_code,
      reference,
      plan_code: planCode,
      weekly_amount: weeklyAmount,
      rider_name: ag.full_name,
      rider_email: ag.email
    });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.response?.data?.message || error.message });
  }
});

module.exports = router;
