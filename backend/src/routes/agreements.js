const express = require('express');
const axios = require('axios');
const pgDb = require('../pgDb');
const { authRequired, adminOnly } = require('../middleware/auth');
// Postgres versions — see each *Pg module's header comment for why it's a
// separate file from the SQLite original (other, not-yet-migrated routes
// still depend on those).
const { logAudit, addDays, recalcScheduleStatuses, rebuildScheduleAllocations, updateAgreementBalance } = require('../utils/helpersPg');
const { writeContractSnapshot } = require('../services/contracts');
const { discontinueAgreement, reinstateDiscontinuedAgreement } = require('../services/agreementLifecyclePg');
const asyncRouter = require('../utils/asyncRouter');

const router = asyncRouter(express.Router());
const PAYSTACK_BASE = 'https://api.paystack.co';
const RIDER_PLAN_AMOUNTS = [500, 650, 700, 750, 800, 850, 1000, 1200];

// Paystack subscriptions that can still take money from a rider. 'attention'
// means a charge failed and Paystack is retrying it, so it will charge the
// moment the card has funds; 'non-renewing' will not charge again and is left
// out. Returns null when Paystack can't be reached, so the caller can refuse
// rather than guess — a guess here is how riders ended up with ten.
//
// The customer record looks like it answers this, and doesn't: it has a
// subscriptions field that came back empty for a rider with ten live ones.
// Listing subscriptions by customer id is what returns them all.
async function chargeableSubscriptionsFor(email) {
  const headers = { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` };
  try {
    let customerId;
    try {
      const { data } = await axios.get(`${PAYSTACK_BASE}/customer/${encodeURIComponent(email)}`, { headers, timeout: 15000 });
      customerId = data?.data?.id;
    } catch (err) {
      // No Paystack customer yet means no subscriptions: the normal first-link case.
      if (err.response?.status === 404) return [];
      throw err;
    }
    if (!customerId) return [];
    const { data } = await axios.get(`${PAYSTACK_BASE}/subscription`,
      { headers, timeout: 15000, params: { customer: customerId, perPage: 100 } });
    return (data?.data || []).filter((sub) => ['active', 'attention'].includes(sub.status));
  } catch (err) {
    console.error('[subscription/init] could not read Paystack subscriptions:', err.response?.data?.message || err.message);
    return null;
  }
}

function getRiderPlanCode(weeklyAmount) {
  const amount = Math.round(Number(weeklyAmount));
  for (const amt of RIDER_PLAN_AMOUNTS) {
    if (amount === amt) return process.env[`PAYSTACK_RIDER_PLAN_${amt}`] || null;
  }
  return null;
}
const AGREEMENT_STATUS_VALUES = ['active', 'completed', 'defaulted', 'cancelled', 'paused', 'discontinued'];

function adminVisibleAgreementClause(_aAlias = 'a', bAlias = 'b', uAlias = 'u') {
  return `${bAlias}.organization_id IS NULL AND ${uAlias}.organization_id IS NULL`;
}

async function getAgreementBundle(agreementId, options = {}) {
  const scopeClause = options.adminVisible ? ` AND ${adminVisibleAgreementClause('a', 'b', 'u')}` : '';
  const { rows: agRows } = await pgDb.query(`SELECT a.*, b.make, b.model, b.registration, b.image_url, b.vin,
      b.last_known_lat, b.last_known_lng, b.last_location_at, b.next_service_date,
      b.next_service_km, b.odometer_km, b.status AS bike_status,
      u.full_name, u.email, u.phone, u.id_number
    FROM agreements a
    JOIN bikes b ON b.id = a.bike_id
    JOIN users u ON u.id = a.user_id
    WHERE a.id = $1${scopeClause}`, [agreementId]);
  const ag = agRows[0];
  if (!ag) return null;
  let application = null;
  if (ag.application_id) {
    const { rows: appRows } = await pgDb.query('SELECT * FROM applications WHERE id = $1', [ag.application_id]);
    application = appRows[0] || null;
  }
  return { agreement: ag, application };
}

router.get('/mine', authRequired, async (req, res) => {
  const { rows: ags } = await pgDb.query(`SELECT a.*, b.make, b.model, b.registration, b.image_url, b.vin, b.status AS bike_status
    FROM agreements a JOIN bikes b ON b.id = a.bike_id
    WHERE a.user_id = $1 ORDER BY a.created_at DESC`, [req.user.id]);
  res.json({ agreements: ags });
});

router.get('/', authRequired, adminOnly, async (req, res) => {
  const { status = '', bike_status = '', exclude_bike_statuses = '' } = req.query;
  const where = [adminVisibleAgreementClause('a', 'b', 'u')];
  const values = [];
  const excludedBikeStatuses = String(exclude_bike_statuses || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  if (status) {
    values.push(status);
    where.push(`a.status = $${values.length}`);
  }
  if (bike_status) {
    values.push(bike_status);
    where.push(`b.status = $${values.length}`);
  }
  if (excludedBikeStatuses.length) {
    const placeholders = excludedBikeStatuses.map((value) => {
      values.push(value);
      return `$${values.length}`;
    });
    where.push(`b.status NOT IN (${placeholders.join(',')})`);
  }

  const sql = `SELECT a.*, u.full_name, u.email, b.make, b.model, b.registration, b.status AS bike_status
    FROM agreements a
    JOIN users u ON u.id = a.user_id
    JOIN bikes b ON b.id = a.bike_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY a.created_at DESC`;

  const { rows: ags } = await pgDb.query(sql, values);
  res.json({ agreements: ags });
});

router.post('/bulk-discontinue', authRequired, adminOnly, async (req, res) => {
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
    const { rows: agreementRows } = await pgDb.query(`SELECT a.id, a.agreement_no, a.status
      FROM agreements a
      JOIN bikes b ON b.id = a.bike_id
      JOIN users u ON u.id = a.user_id
      WHERE a.id = $1 AND ${adminVisibleAgreementClause('a', 'b', 'u')}`, [agreementId]);
    const agreement = agreementRows[0];
    if (!agreement) {
      summary.not_found.push(agreementId);
      continue;
    }
    if (['completed', 'cancelled', 'discontinued'].includes(agreement.status)) {
      summary.skipped.push({ id: agreement.id, agreement_no: agreement.agreement_no, status: agreement.status });
      continue;
    }

    const result = await discontinueAgreement({
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

router.get('/:id', authRequired, async (req, res) => {
  const isAdminPortalUser = ['admin', 'superadmin'].includes(req.user.role);
  const bundle = await getAgreementBundle(req.params.id, { adminVisible: isAdminPortalUser });
  if (!bundle) return res.status(404).json({ error: 'Not found' });
  const ag = bundle.agreement;
  if (ag.user_id !== req.user.id && !isAdminPortalUser) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  await recalcScheduleStatuses(ag.id);
  const { rows: schedule } = await pgDb.query(`SELECT * FROM payment_schedules WHERE agreement_id = $1 ORDER BY week_number`, [ag.id]);
  const { rows: payments } = await pgDb.query(`SELECT * FROM payments WHERE agreement_id = $1 ORDER BY COALESCE(paid_at, created_at) DESC`, [ag.id]);
  let applicationDocuments = [];
  if (ag.application_id) {
    const { rows } = await pgDb.query(`SELECT id, doc_type, file_path, original_name, status, uploaded_at
      FROM application_documents WHERE application_id = $1 ORDER BY uploaded_at DESC`, [ag.application_id]);
    applicationDocuments = rows;
  }

  const successfulPayments = payments.filter((payment) => payment.status === 'success');
  const creditedAmount = (payment) => Number(payment.net_amount) || Number(payment.amount) || 0;
  const totalPaid = successfulPayments.reduce((sum, payment) => sum + creditedAmount(payment), 0);
  const totalAmount = Number(ag.total_amount) || 0;
  const remainingRaw = +(totalAmount - totalPaid).toFixed(2);

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
  // Clamped: an overpayment (or a credit adjustment) would otherwise surface to
  // the rider as a negative outstanding balance and a progress bar running past
  // the end of its track. Owing nothing is R0 and 100%, not less than nothing.
  const progressPct = totalAmount ? Math.min(100, +((totalPaid / totalAmount) * 100).toFixed(1)) : 0;
  const isDiscontinued = ag.status === 'discontinued';

  res.json({
    agreement: ag,
    application: bundle.application,
    application_documents: applicationDocuments,
    schedule,
    payments,
    summary: {
      total_paid: +totalPaid.toFixed(2),
      remaining: isDiscontinued ? 0 : Math.max(0, remainingRaw),
      weeks_paid: Math.min(weeksPaid, Number(ag.total_weeks) || weeksPaid),
      weeks_total: ag.total_weeks,
      overdue: isDiscontinued ? 0 : +overdueRaw.toFixed(2),
      next_due: isDiscontinued ? null : nextDueRaw,
      progress_pct: progressPct
    }
  });
});

router.post('/:id/sign', authRequired, async (req, res) => {
  const bundle = await getAgreementBundle(req.params.id);
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
  await pgDb.query(`UPDATE agreements SET signed_at = CURRENT_TIMESTAMP, signature_data = $1, signed_contract_path = $2 WHERE id = $3`,
    [signature, signedContractPath, req.params.id]);

  if (bundle.agreement.application_id) {
    const { rows: existingRows } = await pgDb.query(`SELECT id FROM application_documents WHERE application_id = $1 AND doc_type = 'signed_contract'`, [bundle.agreement.application_id]);
    const existing = existingRows[0];
    if (existing) {
      await pgDb.query(`UPDATE application_documents SET file_path = $1, original_name = $2, mime_type = 'text/html', status = 'signed', uploaded_at = CURRENT_TIMESTAMP WHERE id = $3`,
        [signedContractPath, `${bundle.agreement.agreement_no}-signed.html`, existing.id]);
    } else {
      await pgDb.query(`INSERT INTO application_documents
        (application_id, user_id, doc_type, file_path, original_name, mime_type, status, uploaded_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [
          bundle.agreement.application_id,
          bundle.agreement.user_id,
          'signed_contract',
          signedContractPath,
          `${bundle.agreement.agreement_no}-signed.html`,
          'text/html',
          'signed',
          req.user.id
        ]);
    }
  }

  await logAudit(req.user.id, 'agreement.sign', 'agreements', Number(req.params.id));
  res.json({ ok: true, signed_contract_path: signedContractPath });
});

router.post('/:id/status', authRequired, adminOnly, async (req, res) => {
  const { status } = req.body;
  if (!AGREEMENT_STATUS_VALUES.includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  const { rows: agreementRows } = await pgDb.query(`SELECT a.*
    FROM agreements a
    JOIN bikes b ON b.id = a.bike_id
    JOIN users u ON u.id = a.user_id
    WHERE a.id = $1 AND ${adminVisibleAgreementClause('a', 'b', 'u')}`, [req.params.id]);
  const agreement = agreementRows[0];
  if (!agreement) return res.status(404).json({ error: 'Agreement not found' });
  await pgDb.query('UPDATE agreements SET status = $1 WHERE id = $2', [status, req.params.id]);
  if (status === 'completed') await pgDb.query(`UPDATE bikes SET status = 'paid_off' WHERE id = $1`, [agreement.bike_id]);
  if (status === 'cancelled' || status === 'defaulted') await pgDb.query(`UPDATE bikes SET status = 'ready_to_go' WHERE id = $1`, [agreement.bike_id]);
  if (status === 'discontinued') {
    await pgDb.query(`UPDATE agreements SET discontinued_at = CURRENT_TIMESTAMP, discontinued_reason = 'admin_status_change' WHERE id = $1`, [req.params.id]);
    await pgDb.query(`UPDATE payment_schedules SET status = 'waived' WHERE agreement_id = $1 AND status IN ('pending','upcoming','overdue')`, [req.params.id]);
  }
  if (agreement.status === 'discontinued' && status !== 'discontinued') {
    await pgDb.query(`UPDATE agreements SET discontinued_at = NULL, discontinued_reason = NULL WHERE id = $1`, [req.params.id]);
  }
  await logAudit(req.user.id, 'agreement.status', 'agreements', Number(req.params.id), { previous_status: agreement.status, status });
  res.json({ ok: true });
});

// Cancel is for agreements that should never have existed: test data, a
// duplicate, one opened on the wrong rider or bike. It differs from the other
// ways out on purpose. Completing marks the bike paid off; defaulting and the
// generic status route put it back to 'ready_to_go', which would hand a test
// bike to the next rider. Cancelling leaves the bike exactly as it is, stops
// billing by waiving every unpaid week, and needs a reason on record.
const CANCELLABLE_STATUSES = ['active', 'paused', 'defaulted'];

router.post('/:id/cancel', authRequired, adminOnly, async (req, res) => {
  const reason = String(req.body?.reason || '').trim();
  if (reason.length < 5) return res.status(400).json({ error: 'Give a reason for cancelling (at least 5 characters)' });
  if (reason.length > 500) return res.status(400).json({ error: 'Keep the reason under 500 characters' });

  const result = await pgDb.withTransaction(async (client) => {
    const { rows } = await client.query(`SELECT a.*
      FROM agreements a
      JOIN bikes b ON b.id = a.bike_id
      JOIN users u ON u.id = a.user_id
      WHERE a.id = $1 AND ${adminVisibleAgreementClause('a', 'b', 'u')}
      FOR UPDATE OF a`, [req.params.id]);
    const agreement = rows[0];
    if (!agreement) return { status: 404, body: { error: 'Agreement not found' } };
    if (!CANCELLABLE_STATUSES.includes(agreement.status)) {
      return { status: 409, body: { error: `A ${agreement.status} agreement can't be cancelled` } };
    }
    const stamp = new Date().toISOString().slice(0, 10);
    await client.query(`UPDATE agreements
      SET status = 'cancelled',
          notes = CONCAT_WS(E'\\n', NULLIF(notes, ''), $1::text),
          updated_at = NOW()
      WHERE id = $2`, [`Cancelled ${stamp}: ${reason}`, agreement.id]);
    const { rowCount: waived } = await client.query(`UPDATE payment_schedules SET status = 'waived'
      WHERE agreement_id = $1 AND status <> 'waived' AND amount_paid < amount_due`, [agreement.id]);
    return { status: 200, body: { ok: true, waived_rows: waived }, agreement, waived };
  });

  if (result.agreement) {
    await logAudit(req.user.id, 'agreement.cancelled', 'agreements', result.agreement.id, {
      previous_status: result.agreement.status, reason, waived_rows: result.waived, bike_id: result.agreement.bike_id,
    }, req.ip);
  }
  res.status(result.status).json(result.body);
});

router.post('/:id/reinstate', authRequired, adminOnly, async (req, res) => {
  try {
    const { rows: agreementRows } = await pgDb.query(`SELECT a.id
      FROM agreements a
      JOIN bikes b ON b.id = a.bike_id
      JOIN users u ON u.id = a.user_id
      WHERE a.id = $1 AND ${adminVisibleAgreementClause('a', 'b', 'u')}`, [req.params.id]);
    if (!agreementRows[0]) return res.status(404).json({ error: 'Agreement not found' });
    const result = await reinstateDiscontinuedAgreement({ agreementId: Number(req.params.id), actorId: req.user.id, ip: req.ip });
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// POST /:id/rebuild-schedule — resets payment schedule rows and replays all payments from the payments table
router.post('/:id/rebuild-schedule', authRequired, adminOnly, async (req, res) => {
  const { rows: agreementRows } = await pgDb.query(`SELECT a.id
    FROM agreements a
    JOIN bikes b ON b.id = a.bike_id
    JOIN users u ON u.id = a.user_id
    WHERE a.id = $1 AND ${adminVisibleAgreementClause('a', 'b', 'u')}`, [req.params.id]);
  const agreement = agreementRows[0];
  if (!agreement) return res.status(404).json({ error: 'Agreement not found' });
  await rebuildScheduleAllocations(agreement.id);
  await logAudit(req.user.id, 'admin.agreement_schedule_rebuild', 'agreements', agreement.id, {}, req.ip);
  res.json({ ok: true });
});

// PUT /:id/balance — admin manually sets the outstanding remaining balance
router.put('/:id/balance', authRequired, adminOnly, async (req, res) => {
  try {
    const { rows: agreementRows } = await pgDb.query(`SELECT a.id
      FROM agreements a
      JOIN bikes b ON b.id = a.bike_id
      JOIN users u ON u.id = a.user_id
      WHERE a.id = $1 AND ${adminVisibleAgreementClause('a', 'b', 'u')}`, [req.params.id]);
    const agreement = agreementRows[0];
    if (!agreement) return res.status(404).json({ error: 'Agreement not found' });
    const result = await updateAgreementBalance(Number(req.params.id), req.body.remaining_balance);
    await logAudit(req.user.id, 'admin.agreement_balance_edit', 'agreements', agreement.id, {
      remaining_balance: result.remaining_balance,
      total_amount: result.total_amount
    }, req.ip);
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// PUT /:id/schedule — admin changes the number of installments (total_weeks)
router.put('/:id/schedule', authRequired, adminOnly, async (req, res) => {
  try {
    const { rows: agRows } = await pgDb.query(`SELECT a.*
      FROM agreements a
      JOIN bikes b ON b.id = a.bike_id
      JOIN users u ON u.id = a.user_id
      WHERE a.id = $1 AND ${adminVisibleAgreementClause('a', 'b', 'u')}`, [req.params.id]);
    const ag = agRows[0];
    if (!ag) return res.status(404).json({ error: 'Agreement not found' });

    const newTotalWeeks = Number(req.body.total_weeks);
    if (!Number.isInteger(newTotalWeeks) || newTotalWeeks < 1 || newTotalWeeks > 520) {
      return res.status(400).json({ error: 'total_weeks must be a whole number between 1 and 520' });
    }

    // Find the highest committed week (paid/partial/waived) — cannot go below this
    const { rows: committedRows } = await pgDb.query(
      `SELECT COALESCE(MAX(week_number), 0) AS max_week FROM payment_schedules
       WHERE agreement_id = $1 AND status IN ('paid', 'partial', 'waived')`, [ag.id]
    );
    const minWeeks = Number(committedRows[0]?.max_week) || 0;

    if (newTotalWeeks < minWeeks) {
      return res.status(400).json({
        error: `Cannot reduce to ${newTotalWeeks} — week ${minWeeks} already has a payment recorded`
      });
    }

    const weeklyAmount = Number(ag.weekly_amount);
    const newTotalAmount = +(weeklyAmount * newTotalWeeks).toFixed(2);

    await pgDb.withTransaction(async (client) => {
      // Remove all pending/overdue rows beyond the new total
      await client.query(
        `DELETE FROM payment_schedules WHERE agreement_id = $1 AND week_number > $2 AND status NOT IN ('paid', 'partial', 'waived')`,
        [ag.id, newTotalWeeks]
      );

      // Find the current highest week_number in the schedule
      const { rows: currentMaxRows } = await client.query(
        `SELECT COALESCE(MAX(week_number), 0) AS max FROM payment_schedules WHERE agreement_id = $1`, [ag.id]
      );
      const currentMax = Number(currentMaxRows[0]?.max) || 0;

      // Insert any new rows needed
      for (let w = currentMax + 1; w <= newTotalWeeks; w++) {
        await client.query(
          `INSERT INTO payment_schedules (agreement_id, week_number, due_date, amount_due) VALUES ($1,$2,$3,$4)`,
          [ag.id, w, addDays(ag.start_date, (w - 1) * 7), weeklyAmount]
        );
      }

      await client.query(`UPDATE agreements SET total_weeks = $1, total_amount = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3`,
        [newTotalWeeks, newTotalAmount, ag.id]);
    });

    await recalcScheduleStatuses(ag.id);
    await logAudit(req.user.id, 'admin.agreement_schedule_edit', 'agreements', ag.id, {
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
    const { rows: agRows } = await pgDb.query(`SELECT a.*, u.email, u.full_name
      FROM agreements a
      JOIN users u ON u.id = a.user_id
      JOIN bikes b ON b.id = a.bike_id
      WHERE a.id = $1 AND ${adminVisibleAgreementClause('a', 'b', 'u')}`, [req.params.id]);
    const ag = agRows[0];
    if (!ag) return res.status(404).json({ error: 'Agreement not found' });

    const overrideAmount = req.body.plan_amount ? Math.round(Number(req.body.plan_amount)) : null;
    const weeklyAmount = overrideAmount || Math.round(Number(ag.weekly_amount));

    const planCode = getRiderPlanCode(weeklyAmount);
    if (!planCode) {
      return res.status(400).json({
        error: `No payment plan configured for R${weeklyAmount}/week. Available: R${RIDER_PLAN_AMOUNTS.join(', R')}.`
      });
    }

    // Every link initialises a brand-new Paystack subscription, and nothing ever
    // cancelled the one before it. Links were regenerated freely — 61 for 25
    // agreements — so 51 riders ended up with several live subscriptions at once
    // and some were charged twice in a day. Check Paystack itself rather than
    // local records: this route never wrote any, so they can't be trusted here.
    const chargeable = await chargeableSubscriptionsFor(ag.email);
    if (chargeable === null) {
      return res.status(502).json({
        error: 'Could not check this rider\'s existing Paystack subscriptions. Try again before generating a link, so a second subscription isn\'t created by mistake.',
      });
    }
    if (chargeable.length) {
      return res.status(409).json({
        error: `${ag.full_name} already has ${chargeable.length} Paystack subscription${chargeable.length === 1 ? '' : 's'} that can still charge them. `
          + 'Cancel it from Paystack subscriptions before generating a new link, or the rider will be charged twice.',
        subscriptions: chargeable.map((sub) => ({
          subscription_code: sub.subscription_code,
          status: sub.status,
          amount: (sub.amount || 0) / 100,
          next_payment_date: sub.next_payment_date || null,
        })),
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

    await logAudit(req.user.id, 'agreement.subscription_link_generated', 'agreements', Number(req.params.id), { plan_code: planCode, weekly_amount: weeklyAmount }, req.ip);

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
