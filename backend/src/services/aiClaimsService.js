'use strict';

// AI-assisted investigation support for insurance claims. Inactive until
// ANTHROPIC_API_KEY is set — every call site checks isConfigured() first, so
// this changes no behavior on its own.
//
// Deliberately scoped to non-sensitive data: rider name/phone and a
// precomputed risk score, never raw KYC documents, ID numbers, or address
// text. The point is investigation support, not another surface where PII
// leaves the platform's own access-control boundary.

const pgDb = require('../pgDb');
const Anthropic = require('@anthropic-ai/sdk');
const { scoreRiders } = require('./riderScoring');

function isConfigured() {
  return !!process.env.ANTHROPIC_API_KEY;
}

let client = null;
function getClient() {
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return client;
}

const MODEL = 'claude-sonnet-5';

// Gathers everything a human investigator would otherwise dig through
// multiple admin pages to find: GPS breadcrumb around the incident, nearby
// alerts (same day-before/of/after window as the evidence-linking picker),
// how long the tracker had been silent before the incident, and the rider's
// claim history + risk score.
async function gatherClaimContext(claimId) {
  const { rows: claimRows } = await pgDb.query('SELECT * FROM insurance_claims WHERE id = $1', [claimId]);
  const claim = claimRows[0];
  if (!claim) throw new Error('Claim not found');

  const { rows: bikeRows } = await pgDb.query('SELECT id, registration, make, model FROM bikes WHERE id = $1', [claim.bike_id]);
  const bike = bikeRows[0] || null;

  const { rows: deviceRows } = await pgDb.query('SELECT connected, last_seen_at FROM tracking_devices WHERE bike_id = $1', [claim.bike_id]);
  const device = deviceRows[0] || null;

  let agreementId = claim.agreement_id;
  if (!agreementId) {
    const { rows } = await pgDb.query('SELECT id FROM agreements WHERE bike_id = $1 ORDER BY created_at DESC LIMIT 1', [claim.bike_id]);
    agreementId = rows[0]?.id || null;
  }

  let rider = null;
  if (agreementId) {
    const { rows: agRows } = await pgDb.query(`
      SELECT a.id AS agreement_id, u.id AS user_id, u.full_name, u.phone, u.address_match_status
      FROM agreements a JOIN users u ON u.id = a.user_id WHERE a.id = $1
    `, [agreementId]);
    const ag = agRows[0];
    if (ag) {
      const [scored] = await scoreRiders([{ ...ag, bike_id: claim.bike_id, bike_registration: bike?.registration }]);
      const { rows: priorRows } = await pgDb.query(`
        SELECT COUNT(*) FROM insurance_claims c
        JOIN agreements a2 ON a2.id = c.agreement_id
        WHERE a2.user_id = $1 AND c.id != $2
      `, [ag.user_id, claimId]);
      rider = {
        name: ag.full_name,
        // riderScoring.js: 0-100 scale where 100 = lowest risk / most reliable, 0 = highest risk.
        // Named explicitly (not "risk_score") since that name alone reads as "higher = more risk",
        // which is the exact opposite of this platform's convention.
        reliability_score_100_is_best: scored?.score ?? null,
        prior_insurance_claims: Number(priorRows[0].count),
      };
    }
  }

  const incidentAt = claim.incident_date || claim.filed_at;
  const { rows: pingsBeforeDesc } = await pgDb.query(`
    SELECT recorded_at, lat, lng, speed_kmh, ignition FROM gps_pings
    WHERE bike_id = $1 AND recorded_at <= $2 ORDER BY recorded_at DESC LIMIT 20
  `, [claim.bike_id, incidentAt]);
  const { rows: pingsAfter } = await pgDb.query(`
    SELECT recorded_at, lat, lng, speed_kmh, ignition FROM gps_pings
    WHERE bike_id = $1 AND recorded_at > $2 ORDER BY recorded_at ASC LIMIT 20
  `, [claim.bike_id, incidentAt]);

  const day = new Date(incidentAt);
  const from = new Date(day); from.setDate(from.getDate() - 1);
  const to = new Date(day); to.setDate(to.getDate() + 2);
  const { rows: alerts } = await pgDb.query(`
    SELECT alert_type, payload, created_at FROM tracking_alerts
    WHERE bike_id = $1 AND created_at >= $2 AND created_at < $3 ORDER BY created_at ASC
  `, [claim.bike_id, from.toISOString(), to.toISOString()]);

  let offlineGapMinutes = null;
  if (pingsBeforeDesc.length) {
    offlineGapMinutes = Math.round((new Date(incidentAt) - new Date(pingsBeforeDesc[0].recorded_at)) / 60000);
  }

  return {
    claim: {
      claim_type: claim.claim_type,
      status: claim.status,
      description: claim.description,
      incident_date: claim.incident_date,
      saps_case_number: claim.saps_case_number,
      saps_police_station: claim.saps_police_station,
    },
    bike: bike ? { registration: bike.registration, make: bike.make, model: bike.model } : null,
    device_currently_connected: device?.connected ?? null,
    minutes_of_silence_before_incident: offlineGapMinutes,
    rider,
    gps_before_incident: pingsBeforeDesc.slice().reverse(),
    gps_after_incident: pingsAfter,
    alerts_day_before_of_after: alerts,
  };
}

const CASE_ANALYSIS_TOOL = {
  name: 'submit_case_analysis',
  description: 'Submit the structured case analysis for this insurance claim',
  input_schema: {
    type: 'object',
    properties: {
      summary: { type: 'string', description: 'A concise, factual 3-6 sentence investigation summary of what the provided data shows — GPS/alert timeline, tracker behavior, rider context.' },
      risk_level: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Fraud/negligence risk level, based only on concrete evidence in the data.' },
      risk_reasons: { type: 'array', items: { type: 'string' }, description: 'Short, specific reasons for the risk level, each citing concrete evidence from the data. Empty array if risk_level is low with nothing notable.' },
    },
    required: ['summary', 'risk_level', 'risk_reasons'],
  },
};

async function generateCaseSummary(claimId) {
  if (!isConfigured()) throw new Error('AI is not configured — set ANTHROPIC_API_KEY');
  const context = await gatherClaimContext(claimId);

  const res = await getClient().messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: 'You are assisting an insurance investigator at a South African rent-to-own delivery-bike platform. '
      + 'Analyze the claim data provided and produce a factual, evidence-based summary. Be conservative: only flag '
      + 'medium/high risk when there is concrete, specific evidence (e.g. the tracker went silent unusually long '
      + 'before the incident with no corresponding alert, or the rider has multiple prior claims). Never state '
      + 'something as fact if it is only a possibility — use hedged language ("could indicate", "worth checking") '
      + 'for anything not directly evidenced by the data. If a rider reliability score is present, remember a '
      + 'HIGHER number means LOWER risk (100 = most reliable, 0 = least) — do not describe a high score as a '
      + 'concern.',
    messages: [{ role: 'user', content: `Claim data:\n${JSON.stringify(context, null, 2)}` }],
    tools: [CASE_ANALYSIS_TOOL],
    tool_choice: { type: 'tool', name: 'submit_case_analysis' },
  });

  const toolUse = res.content.find((b) => b.type === 'tool_use');
  if (!toolUse) throw new Error('AI did not return a structured analysis');
  const { summary, risk_level, risk_reasons } = toolUse.input;

  await pgDb.query(
    `UPDATE insurance_claims SET ai_summary=$1, ai_risk_level=$2, ai_risk_reasons=$3, ai_summary_generated_at=NOW() WHERE id=$4`,
    [summary, risk_level, risk_reasons || [], claimId]
  );

  return { summary, risk_level, risk_reasons: risk_reasons || [] };
}

module.exports = { isConfigured, gatherClaimContext, generateCaseSummary };
