const { v4: uuid } = require('uuid');
const pgDb = require('../pgDb');
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

async function resolveOrgAgreement(registration, orgId) {
  const { rows: bikeRows } = await pgDb.query(
    `SELECT * FROM bikes WHERE UPPER(COALESCE(registration,'')) = UPPER($1) AND organization_id = $2`,
    [registration, orgId]
  );
  const bike = bikeRows[0];
  if (!bike) return null;
  const { rows: agreementRows } = await pgDb.query(
    `SELECT * FROM agreements WHERE bike_id = $1 ORDER BY
     CASE status WHEN 'active' THEN 0 WHEN 'defaulted' THEN 1 WHEN 'paused' THEN 2
     WHEN 'completed' THEN 3 WHEN 'cancelled' THEN 4 ELSE 5 END, id DESC LIMIT 1`,
    [bike.id]
  );
  return agreementRows[0];
}

async function insertImportedPaymentForFleet(row, recordedBy, orgId) {
  const registration = String(row.registration || row.Bike || row['Vehicle Reg'] || row['Bike Registration'] || '').trim();
  if (!registration) throw new Error('Bike registration is required');

  const agreement = await resolveOrgAgreement(registration, orgId);
  if (!agreement) throw new Error(`No agreement found for registration ${registration} in your organisation`);

  const amount = parseMoney(row.amount || row['Amount Collected']);
  if (!amount) throw new Error(`Amount missing for registration ${registration}`);

  const reference = buildRef(row);
  const { rows: existingRows } = await pgDb.query('SELECT id FROM payments WHERE reference = $1', [reference]);
  if (existingRows[0]) return { skipped: true, reference };

  const paidAt = parseDateFlexible(row.paid_at || row['Date Created']) || new Date().toISOString().slice(0, 10);
  const { rows: inserted } = await pgDb.query(
    `INSERT INTO payments
     (agreement_id, user_id, amount, currency, method, reference, status, paid_at, recorded_by, notes, fee_amount, net_amount)
     VALUES ($1,$2,$3,$4,$5,$6, 'success', $7, $8, $9, 0, $10) RETURNING id`,
    [
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
    ]
  );

  const { rows: schedules } = await pgDb.query(
    `SELECT * FROM payment_schedules WHERE agreement_id = $1 ORDER BY week_number`, [agreement.id]
  );
  let remaining = amount;
  for (const schedule of schedules) {
    if (remaining <= 0) break;
    const owed = +(Number(schedule.amount_due) - Number(schedule.amount_paid || 0)).toFixed(2);
    if (owed <= 0) continue;
    const applied = Math.min(remaining, owed);
    const newPaid = +(Number(schedule.amount_paid || 0) + applied).toFixed(2);
    const status = newPaid >= Number(schedule.amount_due) ? 'paid' : 'partial';
    await pgDb.query(
      `UPDATE payment_schedules SET amount_paid = $1, status = $2, paid_at = COALESCE(paid_at, $3) WHERE id = $4`,
      [newPaid, status, paidAt, schedule.id]
    );
    remaining = +(remaining - applied).toFixed(2);
  }

  return { id: inserted[0].id, reference };
}

module.exports = { insertImportedPaymentForFleet };
