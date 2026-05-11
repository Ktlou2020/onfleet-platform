const express = require('express');
const db = require('../db');
const { authRequired, adminOnly } = require('../middleware/auth');
const { logAudit, recalcScheduleStatuses } = require('../utils/helpers');
const { writeContractSnapshot } = require('../services/contracts');

const router = express.Router();

function getAgreementBundle(agreementId) {
  const ag = db.prepare(`SELECT a.*, b.make, b.model, b.registration, b.image_url, b.vin,
      b.last_known_lat, b.last_known_lng, b.last_location_at, b.next_service_date,
      b.next_service_km, b.odometer_km,
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
  const remaining = +(ag.total_amount - totalPaid).toFixed(2);
  const weeksPaid = schedule.filter((row) => row.status === 'paid').length;
  const overdue = schedule.filter((row) => row.status === 'overdue').reduce((sum, row) => sum + (row.amount_due - row.amount_paid), 0);
  const nextDue = schedule.find((row) => row.status !== 'paid' && row.status !== 'waived');
  const progressPct = ag.total_amount ? +((totalPaid / ag.total_amount) * 100).toFixed(1) : 0;

  res.json({
    agreement: ag,
    application: bundle.application,
    application_documents: applicationDocuments,
    schedule,
    payments,
    summary: {
      total_paid: +totalPaid.toFixed(2),
      remaining,
      weeks_paid: weeksPaid,
      weeks_total: ag.total_weeks,
      overdue: +overdue.toFixed(2),
      next_due: nextDue,
      progress_pct: progressPct
    }
  });
});

router.get('/', authRequired, adminOnly, (req, res) => {
  const status = req.query.status;
  const sql = `SELECT a.*, u.full_name, u.email, b.make, b.model, b.registration
    FROM agreements a
    JOIN users u ON u.id = a.user_id
    JOIN bikes b ON b.id = a.bike_id
    ${status ? 'WHERE a.status = ?' : ''}
    ORDER BY a.created_at DESC`;
  const ags = status ? db.prepare(sql).all(status) : db.prepare(sql).all();
  res.json({ agreements: ags });
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
  if (!['active', 'completed', 'defaulted', 'cancelled', 'paused'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  db.prepare('UPDATE agreements SET status = ? WHERE id = ?').run(status, req.params.id);
  const ag = db.prepare('SELECT bike_id FROM agreements WHERE id = ?').get(req.params.id);
  if (status === 'completed') db.prepare(`UPDATE bikes SET status = 'paid_off' WHERE id = ?`).run(ag.bike_id);
  if (status === 'cancelled') db.prepare(`UPDATE bikes SET status = 'ready_to_go' WHERE id = ?`).run(ag.bike_id);
  logAudit(req.user.id, 'agreement.status', 'agreements', Number(req.params.id), { status });
  res.json({ ok: true });
});

module.exports = router;
