const express = require('express');
const db = require('../db');
const { authRequired, adminOnly } = require('../middleware/auth');
const { logAudit, recalcScheduleStatuses } = require('../utils/helpers');
const { writeContractSnapshot } = require('../services/contracts');
const { discontinueAgreement, reinstateDiscontinuedAgreement } = require('../services/agreementLifecycle');

const router = express.Router();
const AGREEMENT_STATUS_VALUES = ['active', 'completed', 'defaulted', 'cancelled', 'paused', 'discontinued'];

function getAgreementBundle(agreementId) {
  const ag = db.prepare(`SELECT a.*, b.make, b.model, b.registration, b.image_url, b.vin,
      b.last_known_lat, b.last_known_lng, b.last_location_at, b.next_service_date,
      b.next_service_km, b.odometer_km, b.status AS bike_status,
      u.full_name, u.email, u.phone, u.id_number
    FROM agreements a
    JOIN bikes b ON b.id = a.bike_id
    JOIN users u ON u.id = a.user_id
    WHERE a.id = ?`).get(agreementId);
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
  const { status = '', bike_status = '' } = req.query;
  const where = [];
  const values = [];

  if (status) {
    where.push('a.status = ?');
    values.push(status);
  }
  if (bike_status) {
    where.push('b.status = ?');
    values.push(bike_status);
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
    const agreement = db.prepare(`SELECT id, agreement_no, status FROM agreements WHERE id = ?`).get(agreementId);
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
  const bundle = getAgreementBundle(req.params.id);
  if (!bundle) return res.status(404).json({ error: 'Not found' });
  const ag = bundle.agreement;
  if (ag.user_id !== req.user.id && !['admin', 'superadmin'].includes(req.user.role)) {
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
  const weeksPaid = schedule.filter((row) => row.status === 'paid').length;
  const overdueRaw = schedule.filter((row) => row.status === 'overdue').reduce((sum, row) => sum + (row.amount_due - row.amount_paid), 0);
  const nextDueRaw = schedule.find((row) => row.status !== 'paid' && row.status !== 'waived');
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
    rider: bundle.agreement,
    bike: bundle.agreement,
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
  const agreement = db.prepare('SELECT * FROM agreements WHERE id = ?').get(req.params.id);
  if (!agreement) return res.status(404).json({ error: 'Agreement not found' });
  db.prepare('UPDATE agreements SET status = ? WHERE id = ?').run(status, req.params.id);
  if (status === 'completed') db.prepare(`UPDATE bikes SET status = 'paid_off' WHERE id = ?`).run(agreement.bike_id);
  if (status === 'cancelled') db.prepare(`UPDATE bikes SET status = 'ready_to_go' WHERE id = ?`).run(agreement.bike_id);
  logAudit(req.user.id, 'agreement.status', 'agreements', Number(req.params.id), { previous_status: agreement.status, status });
  res.json({ ok: true });
});

router.post('/:id/reinstate', authRequired, adminOnly, (req, res) => {
  try {
    const result = reinstateDiscontinuedAgreement({ agreementId: Number(req.params.id), actorId: req.user.id, ip: req.ip });
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

module.exports = router;
