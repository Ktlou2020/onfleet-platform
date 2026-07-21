const { v4: uuid } = require('uuid');
const db = require('../db');
const { parseMoney, parseDateFlexible } = require('./csvImports');

function sanitizeRef(value) {
  return String(value || '').trim().replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

function buildRef(row) {
  const base = sanitizeRef(row.reference || row['Bike and Date']) || `FLEET-PAY-${uuid().slice(0, 8)}`;
  const reg = sanitizeRef(row.registration || row.Bike || row['Vehicle Reg'] || row['Bike Registration']);
  const date = sanitizeRef((parseDateFlexible(row.paid_at || row['Date Created']) || '').replace(/[^0-9]/g, ''));
  return [base, reg, date].filter(Boolean).join('-');
}

function resolveOrgAgreement(registration, orgId) {
  const bike = db.prepare(
    `SELECT * FROM bikes WHERE UPPER(COALESCE(registration,'')) = UPPER(?) AND organization_id = ?`
  ).get(registration, orgId);
  if (!bike) return null;
  return db.prepare(`SELECT * FROM agreements WHERE bike_id = ? ORDER BY
    CASE status WHEN 'active' THEN 0 WHEN 'defaulted' THEN 1 WHEN 'paused' THEN 2
    WHEN 'completed' THEN 3 WHEN 'cancelled' THEN 4 ELSE 5 END, id DESC LIMIT 1`
  ).get(bike.id);
}

function insertImportedPaymentForFleet(row, recordedBy, orgId) {
  const registration = String(row.registration || row.Bike || row['Vehicle Reg'] || row['Bike Registration'] || '').trim();
  if (!registration) throw new Error('Bike registration is required');

  const agreement = resolveOrgAgreement(registration, orgId);
  if (!agreement) throw new Error(`No agreement found for registration ${registration} in your organisation`);

  const amount = parseMoney(row.amount || row['Amount Collected']);
  if (!amount) throw new Error(`Amount missing for registration ${registration}`);

  const reference = buildRef(row);
  const exists = db.prepare('SELECT id FROM payments WHERE reference = ?').get(reference);
  if (exists) return { skipped: true, reference };

  const paidAt = parseDateFlexible(row.paid_at || row['Date Created']) || new Date().toISOString().slice(0, 10);
  const info = db.prepare(`INSERT INTO payments
    (agreement_id, user_id, amount, currency, method, reference, status, paid_at, recorded_by, notes, fee_amount, net_amount)
    VALUES (?,?,?,?,?,?, 'success', ?, ?, ?, 0, ?)`
  ).run(
    agreement.id,
    agreement.user_id,
    amount,
    'ZAR',
    String(row.method || 'eft').trim() || 'eft',
    reference,
    paidAt,
    recordedBy,
    String(row.notes || `Imported for ${registration}`).slice(0, 500),
    amount
  );

  const schedules = db.prepare(`SELECT * FROM payment_schedules WHERE agreement_id = ? ORDER BY week_number`).all(agreement.id);
  let remaining = amount;
  for (const schedule of schedules) {
    if (remaining <= 0) break;
    const owed = +(Number(schedule.amount_due) - Number(schedule.amount_paid || 0)).toFixed(2);
    if (owed <= 0) continue;
    const applied = Math.min(remaining, owed);
    const newPaid = +(Number(schedule.amount_paid || 0) + applied).toFixed(2);
    const status = newPaid >= Number(schedule.amount_due) ? 'paid' : 'partial';
    db.prepare(`UPDATE payment_schedules SET amount_paid = ?, status = ?, paid_at = COALESCE(paid_at, ?) WHERE id = ?`)
      .run(newPaid, status, paidAt, schedule.id);
    remaining = +(remaining - applied).toFixed(2);
  }

  return { id: info.lastInsertRowid, reference };
}

module.exports = { insertImportedPaymentForFleet };
