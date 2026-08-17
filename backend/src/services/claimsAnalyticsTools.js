'use strict';

// A fixed set of safe, parameterized aggregate queries the AI analytics
// assistant can call — deliberately NOT free-form SQL generation. This is
// real financial/incident data on a live platform; letting a model compose
// its own SQL against production is a real injection/exposure risk no
// matter how well-behaved it usually is. Every query here is hand-written,
// read-only, and returns only aggregates — no raw PII, no row-level
// personal data beyond a rider's name where genuinely needed for a pattern
// ("riders with multiple claims").

const pgDb = require('../pgDb');

const TOOLS = [
  {
    name: 'count_claims_by_type_and_status',
    description: 'Count insurance claims grouped by claim_type and status, optionally filtered by a filed_at date range.',
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'ISO date, inclusive, optional' },
        to: { type: 'string', description: 'ISO date, inclusive, optional' },
      },
    },
  },
  {
    name: 'avg_days_to_resolution',
    description: 'Average number of days between a claim being filed and resolved, for claims that have been resolved. Optionally filtered by claim_type.',
    input_schema: {
      type: 'object',
      properties: {
        claim_type: { type: 'string', description: 'Optional: theft, damage, accident, fire, or other' },
      },
    },
  },
  {
    name: 'device_offline_before_theft_correlation',
    description: 'For theft claims, how many had the GPS tracker go silent more than an hour before the incident vs. less than an hour — a signal for tracker tampering or a staged theft.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'theft_count_by_police_station',
    description: 'Count theft claims grouped by the SAPS police station recorded on the claim — the only consistently-captured location field.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'total_payout_exposure',
    description: 'Sum of payout_amount grouped by claim status — shows financial exposure of open/investigating claims vs. amounts already paid out.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'riders_with_multiple_claims',
    description: 'Riders who have filed more than one insurance claim, with counts — a pattern worth reviewing for fraud risk.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'high_risk_ai_flagged_claims',
    description: 'Claims the AI case-summary tool has flagged as medium or high fraud/negligence risk, most recent first.',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max rows to return, default 20' },
      },
    },
  },
];

async function runTool(name, input = {}) {
  switch (name) {
    case 'count_claims_by_type_and_status': {
      const params = [];
      let sql = 'SELECT claim_type, status, COUNT(*) AS count FROM insurance_claims WHERE 1=1';
      if (input.from) { params.push(input.from); sql += ` AND filed_at >= $${params.length}`; }
      if (input.to)   { params.push(input.to);   sql += ` AND filed_at <= $${params.length}`; }
      sql += ' GROUP BY claim_type, status ORDER BY count DESC';
      const { rows } = await pgDb.query(sql, params);
      return rows;
    }

    case 'avg_days_to_resolution': {
      const params = [];
      let sql = `SELECT ROUND(AVG(EXTRACT(EPOCH FROM (resolved_at - filed_at)) / 86400.0)::numeric, 1) AS avg_days, COUNT(*) AS resolved_count
        FROM insurance_claims WHERE resolved_at IS NOT NULL`;
      if (input.claim_type) { params.push(input.claim_type); sql += ` AND claim_type = $${params.length}`; }
      const { rows } = await pgDb.query(sql, params);
      return rows[0];
    }

    case 'device_offline_before_theft_correlation': {
      const { rows } = await pgDb.query(`
        SELECT c.id AS claim_id, COALESCE(c.incident_date::timestamptz, c.filed_at) AS incident_at,
          (SELECT MAX(recorded_at) FROM gps_pings WHERE bike_id = c.bike_id AND recorded_at <= COALESCE(c.incident_date::timestamptz, c.filed_at)) AS last_ping_at
        FROM insurance_claims c WHERE c.claim_type = 'theft'
      `);
      let offlineOver1hr = 0, offlineUnder1hr = 0, noPingData = 0;
      for (const r of rows) {
        if (!r.last_ping_at) { noPingData++; continue; }
        const gapMin = (new Date(r.incident_at) - new Date(r.last_ping_at)) / 60000;
        if (gapMin > 60) offlineOver1hr++; else offlineUnder1hr++;
      }
      return { total_theft_claims: rows.length, tracker_silent_over_1hr_before: offlineOver1hr, tracker_silent_under_1hr_before: offlineUnder1hr, no_gps_data_available: noPingData };
    }

    case 'theft_count_by_police_station': {
      const { rows } = await pgDb.query(`
        SELECT COALESCE(saps_police_station, 'Not recorded') AS police_station, COUNT(*) AS count
        FROM insurance_claims WHERE claim_type = 'theft' GROUP BY saps_police_station ORDER BY count DESC
      `);
      return rows;
    }

    case 'total_payout_exposure': {
      const { rows } = await pgDb.query(`
        SELECT status, SUM(COALESCE(payout_amount, 0)) AS total_amount, COUNT(*) AS claim_count
        FROM insurance_claims GROUP BY status ORDER BY total_amount DESC
      `);
      return rows;
    }

    case 'riders_with_multiple_claims': {
      const { rows } = await pgDb.query(`
        SELECT u.id AS user_id, u.full_name, COUNT(*) AS claim_count
        FROM insurance_claims c
        JOIN agreements a ON a.id = c.agreement_id
        JOIN users u ON u.id = a.user_id
        GROUP BY u.id, u.full_name HAVING COUNT(*) > 1 ORDER BY claim_count DESC
      `);
      return rows;
    }

    case 'high_risk_ai_flagged_claims': {
      const limit = Math.min(Number(input.limit) || 20, 100);
      const { rows } = await pgDb.query(`
        SELECT c.id AS claim_id, b.registration AS bike_registration, c.claim_type, c.ai_risk_level, c.ai_risk_reasons, c.ai_summary_generated_at
        FROM insurance_claims c JOIN bikes b ON b.id = c.bike_id
        WHERE c.ai_risk_level IN ('medium', 'high')
        ORDER BY c.ai_summary_generated_at DESC LIMIT $1
      `, [limit]);
      return rows;
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

module.exports = { TOOLS, runTool };
