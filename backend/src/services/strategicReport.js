const db = require('../db');

function pct(value, total) {
  if (!total) return 0;
  return +((value / total) * 100).toFixed(1);
}

function scalar(query, ...params) {
  const row = db.prepare(query).get(...params) || {};
  return Number(Object.values(row)[0] || 0);
}

function rowsToMix(rows, keyName = 'label') {
  const total = rows.reduce((sum, row) => sum + Number(row.count || row.c || 0), 0);
  return rows.map((row) => ({
    [keyName]: row.label || row.platform || row.province || row.payout_preference || 'Unknown',
    count: Number(row.count || row.c || 0),
    pct: pct(Number(row.count || row.c || 0), total)
  })).sort((a, b) => b.count - a.count);
}

function buildPlatformMix() {
  const rows = db.prepare(`SELECT delivery_platforms FROM applications WHERE COALESCE(delivery_platforms,'') != ''`).all();
  const counts = new Map();
  for (const row of rows) {
    String(row.delivery_platforms || '').split(',').map((item) => item.trim()).filter(Boolean)
      .forEach((platform) => counts.set(platform, (counts.get(platform) || 0) + 1));
  }
  const total = [...counts.values()].reduce((sum, value) => sum + value, 0);
  return [...counts.entries()].map(([label, count]) => ({ label, count, pct: pct(count, total) }))
    .sort((a, b) => b.count - a.count);
}

function buildBikeRoi() {
  return db.prepare(`SELECT
      b.id,
      b.make,
      b.model,
      COALESCE(b.registration, b.vin) AS bike_code,
      COALESCE(b.purchase_price, 0) AS purchase_price,
      COALESCE((SELECT SUM(COALESCE(NULLIF(p.net_amount,0), p.amount))
        FROM payments p
        JOIN agreements a ON a.id = p.agreement_id
        WHERE a.bike_id = b.id AND p.status = 'success'), 0) AS collected,
      COALESCE((SELECT SUM(cost) FROM service_records s WHERE s.bike_id = b.id), 0) AS service_costs
    FROM bikes b`).all().map((bike) => {
      const total_cost = Number(bike.purchase_price) + Number(bike.service_costs);
      const net_roi_value = +(Number(bike.collected) - total_cost).toFixed(2);
      const roi_pct = total_cost > 0 ? +((net_roi_value / total_cost) * 100).toFixed(1) : 0;
      return {
        ...bike,
        total_cost: +total_cost.toFixed(2),
        net_roi_value,
        roi_pct
      };
    }).sort((a, b) => b.net_roi_value - a.net_roi_value);
}

function buildInsights(context) {
  const insights = [];
  const approvalRate = pct(context.funnel.approved + context.funnel.under_review, context.funnel.total_submitted || 1);
  const autoDeclineRate = pct(context.auto.auto_declined, context.funnel.total_submitted || 1);
  const overdueRate = pct(context.collections.overdue_agreements, context.agreements.active || 1);
  const maintenanceShare = pct(context.fleet.maintenance, context.fleet.total || 1);
  const topPlatform = context.platform_mix[0];
  const topProvince = context.province_mix[0];
  const bestBike = context.bike_roi[0];
  const worstBike = context.bike_roi[context.bike_roi.length - 1];

  insights.push({
    title: 'Underwriting health',
    priority: approvalRate >= 50 ? 'medium' : 'high',
    finding: `${approvalRate}% of submitted applications are progressing to review or approval, while ${autoDeclineRate}% are auto-declined by payslip screening.`,
    action: autoDeclineRate > 35
      ? 'Review acquisition channels and pre-screen messaging so riders understand the R1000/week threshold before they apply.'
      : 'Maintain the current payslip screening rule and track conversion quality weekly.'
  });

  insights.push({
    title: 'Collections risk',
    priority: overdueRate > 25 ? 'high' : 'medium',
    finding: `${overdueRate}% of active agreements currently have overdue balances. Overdue exposure is R${context.collections.overdue_amount.toFixed(2)}.`,
    action: overdueRate > 25
      ? 'Prioritize collections playbooks, reminder timing, and rider support for overdue cohorts this week.'
      : 'Collections are manageable, but continue monitoring riders entering their first overdue week.'
  });

  insights.push({
    title: 'Fleet productivity',
    priority: maintenanceShare > 20 ? 'high' : 'low',
    finding: `${maintenanceShare}% of the fleet is in maintenance. ${bestBike ? `${bestBike.make} ${bestBike.model} is currently the strongest ROI bike.` : 'Bike ROI data is limited so far.'}`,
    action: maintenanceShare > 20
      ? 'Reduce workshop turnaround time and keep a reserve pool of ready bikes to protect revenue.'
      : 'Use ROI rankings to guide the next bike purchases and retirement decisions.'
  });

  if (topPlatform) {
    insights.push({
      title: 'Channel focus',
      priority: 'medium',
      finding: `${topPlatform.label} is the largest declared rider income channel at ${topPlatform.pct}% of platform mentions.`,
      action: 'Focus partnerships, rider marketing, and onboarding collateral around the strongest delivery channels first.'
    });
  }

  if (topProvince) {
    insights.push({
      title: 'Regional demand',
      priority: 'low',
      finding: `${topProvince.label} is the leading rider province at ${topProvince.pct}% of registered riders.`,
      action: 'Use province concentration to plan field ops coverage, service partners, and next-city expansion.'
    });
  }

  if (worstBike && worstBike.net_roi_value < 0) {
    insights.push({
      title: 'Negative ROI watchlist',
      priority: 'high',
      finding: `${worstBike.make} ${worstBike.model} (${worstBike.bike_code}) is currently below breakeven with ROI ${worstBike.roi_pct}%.`,
      action: 'Audit downtime, maintenance frequency, and rider payment history before buying more of this bike profile.'
    });
  }

  return insights;
}

function generateStrategicReport() {
  const riders = scalar(`SELECT COUNT(*) FROM users WHERE role = 'rider' AND deleted_at IS NULL`);
  const admins = scalar(`SELECT COUNT(*) FROM users WHERE role IN ('admin','superadmin') AND deleted_at IS NULL`);
  const activeAgreements = scalar(`SELECT COUNT(*) FROM agreements WHERE status = 'active'`);
  const completedAgreements = scalar(`SELECT COUNT(*) FROM agreements WHERE status = 'completed'`);
  const totalBikes = scalar(`SELECT COUNT(*) FROM bikes`);
  const availableBikes = scalar(`SELECT COUNT(*) FROM bikes WHERE status = 'available'`);
  const allocatedBikes = scalar(`SELECT COUNT(*) FROM bikes WHERE status = 'allocated'`);
  const maintenanceBikes = scalar(`SELECT COUNT(*) FROM bikes WHERE status = 'maintenance'`);
  const totalSubmitted = scalar(`SELECT COUNT(*) FROM applications`);
  const submitted = scalar(`SELECT COUNT(*) FROM applications WHERE status = 'submitted'`);
  const underReview = scalar(`SELECT COUNT(*) FROM applications WHERE status = 'under_review'`);
  const approved = scalar(`SELECT COUNT(*) FROM applications WHERE status = 'approved'`);
  const rejected = scalar(`SELECT COUNT(*) FROM applications WHERE status = 'rejected'`);
  const preApproved = scalar(`SELECT COUNT(*) FROM applications WHERE auto_decision = 'pre_approved'`);
  const autoDeclined = scalar(`SELECT COUNT(*) FROM applications WHERE auto_decision = 'auto_declined'`);
  const grossReceived = scalar(`SELECT COALESCE(SUM(amount),0) FROM payments WHERE status = 'success'`);
  const transactionFees = scalar(`SELECT COALESCE(SUM(fee_amount),0) FROM payments WHERE status = 'success'`);
  const creditedRevenue = scalar(`SELECT COALESCE(SUM(COALESCE(NULLIF(net_amount,0), amount)),0) FROM payments WHERE status = 'success'`);
  const overdueAmount = scalar(`SELECT COALESCE(SUM(amount_due - amount_paid),0) FROM payment_schedules WHERE status = 'overdue'`);
  const overdueAgreements = scalar(`SELECT COUNT(DISTINCT agreement_id) FROM payment_schedules WHERE status = 'overdue'`);

  const payoutMix = rowsToMix(db.prepare(`SELECT COALESCE(payout_preference, 'unknown') AS payout_preference, COUNT(*) AS count
    FROM applications GROUP BY COALESCE(payout_preference, 'unknown')`).all(), 'label');
  const provinceMix = rowsToMix(db.prepare(`SELECT COALESCE(province, 'Unknown') AS province, COUNT(*) AS count
    FROM users WHERE role = 'rider' AND deleted_at IS NULL GROUP BY COALESCE(province, 'Unknown')`).all(), 'label');
  const platformMix = buildPlatformMix();
  const bikeRoi = buildBikeRoi();

  const monthlyRevenue = db.prepare(`SELECT strftime('%Y-%m', COALESCE(paid_at, created_at)) AS month,
      ROUND(SUM(COALESCE(NULLIF(net_amount,0), amount)), 2) AS total
    FROM payments
    WHERE status = 'success' AND COALESCE(paid_at, created_at) >= datetime('now','-6 months')
    GROUP BY month ORDER BY month`).all().map((row) => ({ month: row.month, total: Number(row.total || 0) }));

  const signupTrend = db.prepare(`SELECT strftime('%Y-%m', created_at) AS month, COUNT(*) AS count
    FROM users WHERE role = 'rider' AND deleted_at IS NULL AND created_at >= datetime('now','-6 months')
    GROUP BY month ORDER BY month`).all().map((row) => ({ month: row.month, count: Number(row.count || 0) }));

  const avgWeekly = db.prepare(`SELECT ROUND(AVG(average_weekly_earnings), 2) AS avg_weekly
    FROM applications WHERE average_weekly_earnings > 0`).get()?.avg_weekly || 0;

  const report = {
    generated_at: new Date().toISOString(),
    executive_summary: `OnFleet currently has ${riders} riders, ${activeAgreements} active agreements, and R${creditedRevenue.toFixed(2)} credited collections. The current underwriting funnel shows ${preApproved} pre-approved applications and ${autoDeclined} auto-declines, while overdue exposure stands at R${overdueAmount.toFixed(2)} across ${overdueAgreements} agreements.`,
    key_metrics: {
      riders,
      admins,
      avg_weekly_earnings: Number(avgWeekly || 0),
      gross_received: grossReceived,
      transaction_fees: transactionFees,
      credited_revenue: creditedRevenue,
      overdue_amount: overdueAmount
    },
    agreements: {
      active: activeAgreements,
      completed: completedAgreements
    },
    fleet: {
      total: totalBikes,
      available: availableBikes,
      allocated: allocatedBikes,
      maintenance: maintenanceBikes
    },
    funnel: {
      total_submitted: totalSubmitted,
      submitted,
      under_review: underReview,
      approved,
      rejected
    },
    auto: {
      pre_approved: preApproved,
      auto_declined: autoDeclined
    },
    collections: {
      gross_received: grossReceived,
      transaction_fees: transactionFees,
      credited_revenue: creditedRevenue,
      overdue_amount: overdueAmount,
      overdue_agreements: overdueAgreements
    },
    payout_mix: payoutMix,
    province_mix: provinceMix,
    platform_mix: platformMix,
    monthly_revenue: monthlyRevenue,
    signup_trend: signupTrend,
    bike_roi: bikeRoi.slice(0, 8)
  };

  report.insights = buildInsights(report);
  return report;
}

module.exports = { generateStrategicReport };
