'use strict';

// A 0-100 score (100 = lowest risk) computed live from data already
// collected elsewhere: alert history (critical + driving-behavior alerts),
// on-time payment rate, and the address-verification flag. Not cached — at
// this platform's scale a live aggregation per request is cheap and always
// current, so there's no staleness to reason about.
//
// Shared between admin.js (platform-wide) and fleet.js (org-scoped) so both
// portals show the exact same score for the exact same rider.

const pgDb = require('../pgDb');

const CRITICAL_ALERT_TYPES = ['panic', 'tamper', 'power_disconnect', 'movement', 'night_movement', 'towing', 'theft_risk'];
const DRIVING_ALERT_TYPES = ['speeding', 'harsh_brake', 'harsh_accel', 'harsh_cornering'];

function computeRiderScore({ criticalAlerts90d, drivingAlerts90d, overdueRatio, addressMismatch }) {
  let score = 100;
  score -= Math.min(criticalAlerts90d, 5) * 12;
  score -= Math.min(drivingAlerts90d, 10) * 2;
  score -= overdueRatio * 30;
  if (addressMismatch) score -= 10;
  return Math.max(0, Math.round(score));
}

// riders: [{ user_id, full_name, phone, address_match_status, agreement_id, bike_id, bike_registration }]
async function scoreRiders(riders) {
  if (!riders.length) return [];

  const bikeIds = riders.map((r) => r.bike_id);
  const agreementIds = riders.map((r) => r.agreement_id);

  const { rows: alertCounts } = await pgDb.query(`
    SELECT bike_id, alert_type, COUNT(*) AS n
    FROM tracking_alerts
    WHERE bike_id = ANY($1) AND created_at > NOW() - INTERVAL '90 days'
    GROUP BY bike_id, alert_type
  `, [bikeIds]);

  const { rows: paymentStats } = await pgDb.query(`
    SELECT agreement_id,
      COUNT(*) FILTER (WHERE status IN ('paid','overdue','partial')) AS reckoned,
      COUNT(*) FILTER (WHERE status = 'overdue' OR (status = 'paid' AND paid_at IS NOT NULL AND paid_at::date > due_date)) AS late_or_overdue
    FROM payment_schedules
    WHERE agreement_id = ANY($1)
    GROUP BY agreement_id
  `, [agreementIds]);
  const paymentByAgreement = new Map(paymentStats.map((p) => [p.agreement_id, p]));

  const alertsByBike = new Map();
  for (const row of alertCounts) {
    if (!alertsByBike.has(row.bike_id)) alertsByBike.set(row.bike_id, {});
    alertsByBike.get(row.bike_id)[row.alert_type] = Number(row.n);
  }

  return riders.map((r) => {
    const bikeAlerts = alertsByBike.get(r.bike_id) || {};
    const criticalAlerts90d = CRITICAL_ALERT_TYPES.reduce((sum, t) => sum + (bikeAlerts[t] || 0), 0);
    const drivingAlerts90d = DRIVING_ALERT_TYPES.reduce((sum, t) => sum + (bikeAlerts[t] || 0), 0);
    const payment = paymentByAgreement.get(r.agreement_id);
    const reckoned = Number(payment?.reckoned || 0);
    const overdueRatio = reckoned > 0 ? Number(payment.late_or_overdue) / reckoned : 0;
    const addressMismatch = r.address_match_status === 'mismatch';
    const score = computeRiderScore({ criticalAlerts90d, drivingAlerts90d, overdueRatio, addressMismatch });
    return {
      user_id: r.user_id, full_name: r.full_name, phone: r.phone,
      bike_id: r.bike_id, bike_registration: r.bike_registration,
      score, critical_alerts_90d: criticalAlerts90d, driving_alerts_90d: drivingAlerts90d,
      payment_reckoned: reckoned, payment_late_or_overdue: Number(payment?.late_or_overdue || 0),
      address_match_status: r.address_match_status,
    };
  }).sort((a, b) => a.score - b.score);
}

module.exports = { scoreRiders, computeRiderScore };
