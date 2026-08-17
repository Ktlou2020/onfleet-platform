'use strict';

const express = require('express');
const pgDb = require('../pgDb');
const { authRequired, adminOnly } = require('../middleware/auth');
const { logAudit } = require('../utils/helpersPg');
const asyncRouter = require('../utils/asyncRouter');
const aiClaimsService = require('../services/aiClaimsService');
const aiAnalyticsService = require('../services/aiAnalyticsService');

const router = asyncRouter(express.Router());

const CLAIM_TYPES = ['theft', 'damage', 'accident', 'fire', 'other'];
const CLAIM_STATUSES = ['filed', 'investigating', 'approved', 'rejected', 'paid', 'closed'];

async function hydrateClaim(claim) {
  const { rows: bikeRows } = await pgDb.query(
    `SELECT registration, make, model, vin FROM bikes WHERE id = $1`, [claim.bike_id]
  );
  const { rows: filerRows } = await pgDb.query(`SELECT full_name FROM users WHERE id = $1`, [claim.filed_by]);
  let alerts = [];
  if (claim.linked_alert_ids?.length) {
    const { rows } = await pgDb.query(
      `SELECT id, alert_type, payload, created_at, resolved_at FROM tracking_alerts WHERE id = ANY($1) ORDER BY created_at DESC`,
      [claim.linked_alert_ids]
    );
    alerts = rows;
  }
  return { ...claim, bike: bikeRows[0] || null, filed_by_name: filerRows[0]?.full_name || null, alerts };
}

router.get('/', authRequired, adminOnly, async (req, res) => {
  const status = String(req.query.status || '').trim();
  const params = [];
  let sql = 'SELECT c.*, b.registration AS bike_registration FROM insurance_claims c JOIN bikes b ON b.id = c.bike_id WHERE 1=1';
  if (status) { params.push(status); sql += ` AND c.status = $${params.length}`; }
  sql += ' ORDER BY c.filed_at DESC';
  const { rows } = await pgDb.query(sql, params);
  res.json({ claims: rows });
});

router.get('/:id', authRequired, adminOnly, async (req, res) => {
  const { rows } = await pgDb.query('SELECT * FROM insurance_claims WHERE id = $1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Claim not found' });
  res.json({ claim: await hydrateClaim(rows[0]) });
});

router.post('/', authRequired, adminOnly, async (req, res) => {
  const bikeId = Number(req.body.bike_id);
  const claimType = String(req.body.claim_type || '').trim();
  const description = String(req.body.description || '').trim();
  const incidentDate = req.body.incident_date || null;
  const agreementId = req.body.agreement_id ? Number(req.body.agreement_id) : null;
  const linkedAlertIds = Array.isArray(req.body.linked_alert_ids)
    ? req.body.linked_alert_ids.map(Number).filter(Number.isFinite)
    : [];
  const sapsCaseNumber = req.body.saps_case_number ? String(req.body.saps_case_number).trim() : null;
  const sapsPoliceStation = req.body.saps_police_station ? String(req.body.saps_police_station).trim() : null;

  if (!Number.isFinite(bikeId)) return res.status(400).json({ error: 'bike_id is required' });
  if (!CLAIM_TYPES.includes(claimType)) return res.status(400).json({ error: `claim_type must be one of: ${CLAIM_TYPES.join(', ')}` });
  if (!description) return res.status(400).json({ error: 'A description is required' });

  const { rows: bikeRows } = await pgDb.query('SELECT id FROM bikes WHERE id = $1', [bikeId]);
  if (!bikeRows[0]) return res.status(404).json({ error: 'Bike not found' });

  const { rows } = await pgDb.query(
    `INSERT INTO insurance_claims (bike_id, agreement_id, claim_type, description, incident_date, linked_alert_ids, filed_by, saps_case_number, saps_police_station)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [bikeId, agreementId, claimType, description, incidentDate, linkedAlertIds, req.user.id, sapsCaseNumber, sapsPoliceStation]
  );
  const claim = rows[0];
  await logAudit(req.user.id, 'claim.file', 'insurance_claims', claim.id, { bike_id: bikeId, claim_type: claimType }, req.ip);
  res.json({ claim: await hydrateClaim(claim) });
});

router.put('/:id', authRequired, adminOnly, async (req, res) => {
  const { rows: existingRows } = await pgDb.query('SELECT * FROM insurance_claims WHERE id = $1', [req.params.id]);
  const existing = existingRows[0];
  if (!existing) return res.status(404).json({ error: 'Claim not found' });

  const updates = [];
  const values = [];
  if (req.body.status !== undefined) {
    if (!CLAIM_STATUSES.includes(req.body.status)) return res.status(400).json({ error: `status must be one of: ${CLAIM_STATUSES.join(', ')}` });
    values.push(req.body.status);
    updates.push(`status = $${values.length}`);
    if (['approved', 'rejected', 'paid', 'closed'].includes(req.body.status) && !existing.resolved_at) {
      updates.push(`resolved_at = NOW()`);
    }
  }
  if (req.body.payout_amount !== undefined) {
    values.push(req.body.payout_amount === null ? null : Number(req.body.payout_amount));
    updates.push(`payout_amount = $${values.length}`);
  }
  if (req.body.notes !== undefined) {
    values.push(String(req.body.notes || ''));
    updates.push(`notes = $${values.length}`);
  }
  if (req.body.saps_case_number !== undefined) {
    values.push(req.body.saps_case_number ? String(req.body.saps_case_number).trim() : null);
    updates.push(`saps_case_number = $${values.length}`);
  }
  if (req.body.saps_police_station !== undefined) {
    values.push(req.body.saps_police_station ? String(req.body.saps_police_station).trim() : null);
    updates.push(`saps_police_station = $${values.length}`);
  }
  if (!updates.length) return res.status(400).json({ error: 'No changes provided' });
  updates.push('updated_at = NOW()');

  values.push(req.params.id);
  const { rows } = await pgDb.query(
    `UPDATE insurance_claims SET ${updates.join(', ')} WHERE id = $${values.length} RETURNING *`,
    values
  );
  const claim = rows[0];
  await logAudit(req.user.id, 'claim.update', 'insurance_claims', claim.id, { changes: req.body }, req.ip);
  res.json({ claim: await hydrateClaim(claim) });
});

router.post('/:id/ai-summary', authRequired, adminOnly, async (req, res) => {
  if (!aiClaimsService.isConfigured()) {
    return res.status(400).json({ error: 'AI is not configured. Set ANTHROPIC_API_KEY to enable this.' });
  }
  const { rows } = await pgDb.query('SELECT id FROM insurance_claims WHERE id = $1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Claim not found' });

  try {
    const result = await aiClaimsService.generateCaseSummary(Number(req.params.id));
    await logAudit(req.user.id, 'claim.ai_summary', 'insurance_claims', req.params.id, { risk_level: result.risk_level }, req.ip);
    const { rows: claimRows } = await pgDb.query('SELECT * FROM insurance_claims WHERE id = $1', [req.params.id]);
    res.json({ claim: await hydrateClaim(claimRows[0]) });
  } catch (e) {
    res.status(502).json({ error: `AI summary generation failed: ${e.message}` });
  }
});

router.post('/analytics/ask', authRequired, adminOnly, async (req, res) => {
  if (!aiAnalyticsService.isConfigured()) {
    return res.status(400).json({ error: 'AI is not configured. Set ANTHROPIC_API_KEY to enable this.' });
  }
  const question = String(req.body.question || '').trim();
  if (!question) return res.status(400).json({ error: 'question is required' });

  try {
    const result = await aiAnalyticsService.askQuestion(question);
    await logAudit(req.user.id, 'claims.ai_analytics_query', null, null, { question }, req.ip);
    res.json(result);
  } catch (e) {
    res.status(502).json({ error: `AI analytics failed: ${e.message}` });
  }
});

module.exports = router;
