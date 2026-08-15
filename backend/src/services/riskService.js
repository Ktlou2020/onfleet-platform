'use strict';

// Real-time theft/anomaly risk scoring for tracked bikes.
//
// Builds a per-bike behavioural baseline from ride history (typical operating
// hours, usual geographic area, normal speed range) and scores every incoming
// GPS ping against it plus a handful of high-confidence precursor signals
// (tamper, unauthorized movement, implausible position jumps, no-go/hijacking
// zone presence). This is a lightweight in-process statistical model, not a
// trained ML model — chosen to fit the single-process Node deploy (no GPU/ML
// runtime available) while still catching the theft patterns that matter:
// a bike moving somewhere/somewhen it never does, moving unusually fast
// (loaded onto another vehicle), or teleporting between distant points.

const pgDb = require('../pgDb');
const trackingEvents = require('../trackingEvents');
const { sendNotification } = require('./notifierPg');

const BASELINE_WINDOW_DAYS = 30;
const MIN_SAMPLES_FOR_BASELINE = 50;
const RISK_ALERT_COOLDOWN_MS = 15 * 60_000;
const LEVEL_RANK = { normal: 0, watch: 1, elevated: 2, critical: 3 };

function levelForScore(score) {
  if (score >= 70) return 'critical';
  if (score >= 40) return 'elevated';
  if (score >= 20) return 'watch';
  return 'normal';
}

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function percentile(sortedAsc, p) {
  if (!sortedAsc.length) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.floor(p * sortedAsc.length));
  return sortedAsc[idx];
}

// SA has no DST — Africa/Johannesburg is always UTC+2 (matches frontend's SAST handling)
function sastHour(ts) {
  return (new Date(ts).getUTCHours() + 2) % 24;
}

// bikeId → baseline profile | null (null = not enough history yet)
const baselineCache = new Map();
// bikeId → { lat, lng, ts } of the last scored ping (for implausible-jump detection)
const lastPingByBike = new Map();
// bikeId → { score, level, reasons, updatedAt } — current smoothed risk state
const scoreState = new Map();
// bikeId → epoch ms of last persisted theft_risk alert
const riskAlertCooldown = new Map();

// Global alert_settings row for 'theft_risk' (mirrors tripService's per-type settings cache;
// theft_risk only supports the global toggle, not per-device overrides, since it's one model per bike)
let riskAlertSettings = { enabled: true, notify_enabled: true, recipientIds: [] };

async function loadAlertSettings() {
  try {
    const { rows } = await pgDb.query(`SELECT * FROM alert_settings WHERE alert_type='theft_risk'`);
    if (rows[0]) {
      let recipientIds = [];
      try { recipientIds = JSON.parse(rows[0].recipient_user_ids || '[]'); } catch { /* ignore */ }
      riskAlertSettings = { enabled: rows[0].enabled, notify_enabled: rows[0].notify_enabled, recipientIds };
    }
  } catch { /* alert_settings may not exist yet on first boot */ }
}
function reloadAlertSettings() { loadAlertSettings().catch(() => {}); }
setTimeout(() => loadAlertSettings().catch(() => {}), 2000);

async function rebuildBaseline(bikeId) {
  const { rows } = await pgDb.query(
    `SELECT lat, lng, speed_kmh, recorded_at FROM gps_pings
     WHERE bike_id = $1 AND recorded_at >= NOW() - INTERVAL '${BASELINE_WINDOW_DAYS} days'
     ORDER BY recorded_at DESC LIMIT 20000`,
    [bikeId]
  );

  const moving = rows.filter(r => Number(r.speed_kmh) > 2);
  const sample = moving.length >= MIN_SAMPLES_FOR_BASELINE ? moving : rows;

  if (sample.length < MIN_SAMPLES_FOR_BASELINE) {
    await pgDb.query(
      `INSERT INTO bike_risk_profiles (bike_id, hour_histogram, centroid_lat, centroid_lng, radius_p95_m, speed_p95_kmh, sample_count, computed_at)
       VALUES ($1,NULL,NULL,NULL,NULL,NULL,$2,NOW())
       ON CONFLICT (bike_id) DO UPDATE SET hour_histogram=NULL, centroid_lat=NULL, centroid_lng=NULL,
         radius_p95_m=NULL, speed_p95_kmh=NULL, sample_count=EXCLUDED.sample_count, computed_at=NOW()`,
      [bikeId, sample.length]
    );
    baselineCache.set(bikeId, null);
    return;
  }

  const hourHistogram = new Array(24).fill(0);
  for (const r of sample) hourHistogram[sastHour(r.recorded_at)]++;

  const centroidLat = sample.reduce((s, r) => s + r.lat, 0) / sample.length;
  const centroidLng = sample.reduce((s, r) => s + r.lng, 0) / sample.length;

  const distancesM = sample
    .map(r => haversineKm(centroidLat, centroidLng, r.lat, r.lng) * 1000)
    .sort((a, b) => a - b);
  const radiusP95 = Math.max(500, percentile(distancesM, 0.95));

  const speeds = sample.map(r => Number(r.speed_kmh) || 0).sort((a, b) => a - b);
  const speedP95 = percentile(speeds, 0.95);

  await pgDb.query(
    `INSERT INTO bike_risk_profiles (bike_id, hour_histogram, centroid_lat, centroid_lng, radius_p95_m, speed_p95_kmh, sample_count, computed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
     ON CONFLICT (bike_id) DO UPDATE SET hour_histogram=EXCLUDED.hour_histogram, centroid_lat=EXCLUDED.centroid_lat,
       centroid_lng=EXCLUDED.centroid_lng, radius_p95_m=EXCLUDED.radius_p95_m, speed_p95_kmh=EXCLUDED.speed_p95_kmh,
       sample_count=EXCLUDED.sample_count, computed_at=NOW()`,
    [bikeId, JSON.stringify(hourHistogram), centroidLat, centroidLng, radiusP95, speedP95, sample.length]
  );

  baselineCache.set(bikeId, {
    hour_histogram: hourHistogram,
    centroid_lat: centroidLat,
    centroid_lng: centroidLng,
    radius_p95_m: radiusP95,
    speed_p95_kmh: speedP95,
    sample_count: sample.length,
  });
}

async function rebuildAllBaselines() {
  const { rows } = await pgDb.query(
    'SELECT DISTINCT bike_id FROM tracking_devices WHERE bike_id IS NOT NULL'
  );
  let ok = 0, failed = 0;
  for (const { bike_id } of rows) {
    try { await rebuildBaseline(bike_id); ok++; }
    catch (e) { failed++; console.error(`[Risk] Baseline rebuild failed for bike ${bike_id}:`, e.message); }
  }
  console.log(`[Risk] Rebuilt ${ok} baseline(s)${failed ? `, ${failed} failed` : ''}`);
}

async function getBaseline(bikeId) {
  if (baselineCache.has(bikeId)) return baselineCache.get(bikeId);
  try {
    const { rows } = await pgDb.query('SELECT * FROM bike_risk_profiles WHERE bike_id=$1', [bikeId]);
    const profile = rows[0] && rows[0].centroid_lat != null ? rows[0] : null;
    baselineCache.set(bikeId, profile);
    return profile;
  } catch {
    return null;
  }
}

function canFireRiskAlert(bikeId, nowMs) {
  const last = riskAlertCooldown.get(bikeId);
  if (last && nowMs - last < RISK_ALERT_COOLDOWN_MS) return false;
  riskAlertCooldown.set(bikeId, nowMs);
  return true;
}

async function fireRiskAlert(bikeId, deviceId, score, level, reasons, recordedAt) {
  if (riskAlertSettings.enabled === false) return;

  const { rows: bikeRows } = await pgDb.query('SELECT registration FROM bikes WHERE id = $1', [bikeId]);
  const reg = bikeRows[0]?.registration || `Bike #${bikeId}`;
  const payload = JSON.stringify({ score, level, reasons });

  const { rows } = await pgDb.query(
    `INSERT INTO tracking_alerts (bike_id, device_id, alert_type, payload, created_at)
     VALUES ($1,$2,'theft_risk',$3,$4) RETURNING id`,
    [bikeId, deviceId, payload, recordedAt]
  );

  trackingEvents.emit('alert', {
    id: rows[0].id,
    bike_id: bikeId,
    device_id: deviceId,
    alert_type: 'theft_risk',
    payload,
    bike_registration: reg,
    created_at: recordedAt,
    acknowledged_at: null,
  });

  if (level === 'critical' && riskAlertSettings.notify_enabled !== false) {
    const title = `🚨 AI Theft Risk: ${reg} (${score}/100)`;
    const message = `Bike ${reg} has an elevated theft/anomaly risk score of ${score}/100 at ${recordedAt}.\n\nReasons:\n${reasons.map(r => `- ${r}`).join('\n')}`;
    const { rows: recipients } = riskAlertSettings.recipientIds.length
      ? await pgDb.query('SELECT id FROM users WHERE id = ANY($1) AND deleted_at IS NULL', [riskAlertSettings.recipientIds])
      : await pgDb.query("SELECT id FROM users WHERE role='superadmin' AND email IS NOT NULL AND deleted_at IS NULL");
    for (const admin of recipients) {
      sendNotification({ userId: admin.id, channel: 'email', type: 'gps_theft_risk', title, message, throwOnError: false, digest: true }).catch(() => {});
    }
  }
}

async function evaluatePing(bikeId, deviceId, lat, lng, speed, ignition, recordedAt, io) {
  const ts = new Date(recordedAt).getTime();
  const reasons = [];
  let points = 0;
  let floor = 0; // high-confidence signals force the score up immediately, bypassing smoothing

  const baseline = await getBaseline(bikeId);

  if (baseline && speed > 5) {
    const hour = sastHour(ts);
    const total = baseline.hour_histogram.reduce((a, b) => a + b, 0);
    const hourCount = baseline.hour_histogram[hour] || 0;
    if (total >= MIN_SAMPLES_FOR_BASELINE && hourCount / total < 0.02) {
      points += 25;
      reasons.push(`Unusual operating hour (${hour}:00 SAST — rarely active then)`);
    }
  }

  if (baseline) {
    const distM = haversineKm(baseline.centroid_lat, baseline.centroid_lng, lat, lng) * 1000;
    const radius = baseline.radius_p95_m;
    if (distM > radius * 3) {
      points += 30;
      reasons.push(`Far outside usual operating area (${Math.round(distM)}m from typical zone)`);
    } else if (distM > radius * 1.5) {
      points += 15;
      reasons.push('Outside usual operating area');
    }
  }

  if (baseline && baseline.speed_p95_kmh) {
    const speedCeiling = Math.max(baseline.speed_p95_kmh * 1.5, 90);
    if (speed > speedCeiling) {
      points += 20;
      reasons.push(`Speed ${Math.round(speed)}km/h far above rider's normal range — possible vehicle transport`);
    }
  }

  const last = lastPingByBike.get(bikeId);
  if (last && ts > last.ts) {
    const dtHr = (ts - last.ts) / 3_600_000;
    if (dtHr > 0 && dtHr < 0.5) {
      const distKm = haversineKm(last.lat, last.lng, lat, lng);
      const impliedSpeed = distKm / dtHr;
      if (impliedSpeed > 180) {
        points += 35;
        floor = Math.max(floor, 70);
        reasons.push(`Implausible jump — ${Math.round(distKm)}km in ${Math.round(dtHr * 60)}min (~${Math.round(impliedSpeed)}km/h implied)`);
      }
    }
  }
  lastPingByBike.set(bikeId, { lat, lng, ts });

  try {
    const { rows: zoneRows } = await pgDb.query(
      `SELECT g.zone_type, g.name FROM geofence_states s JOIN geofences g ON g.id = s.geofence_id
       WHERE s.bike_id = $1 AND s.inside = TRUE AND g.zone_type IN ('danger','warning')`,
      [bikeId]
    );
    for (const z of zoneRows) {
      if (z.zone_type === 'danger') {
        points += 25;
        reasons.push(`Currently inside no-go zone: ${z.name}`);
      } else {
        points += 12;
        reasons.push(`Currently inside hijacking-risk zone: ${z.name}`);
      }
    }
  } catch { /* geofence tables may not be ready yet */ }

  if (io) {
    if (io[252]) {
      points += 30;
      floor = Math.max(floor, 75);
      reasons.push('GPS tamper detected');
    }
    if (io[240] && !ignition) {
      points += 30;
      floor = Math.max(floor, 75);
      reasons.push('Movement detected with ignition off');
    }
  }

  points = Math.min(100, points);

  const prev = scoreState.get(bikeId);
  let score = floor
    ? Math.max(floor, points, prev ? prev.score : 0)
    : (prev ? Math.round(prev.score * 0.6 + points * 0.4) : points);
  score = Math.max(0, Math.min(100, score));

  const level = levelForScore(score);
  const updatedAt = new Date(ts).toISOString();
  scoreState.set(bikeId, { score, level, reasons, updated_at: updatedAt });

  trackingEvents.emit('risk_update', { bike_id: bikeId, device_id: deviceId, score, level, reasons, ts });

  if (LEVEL_RANK[level] >= LEVEL_RANK.elevated && canFireRiskAlert(bikeId, ts)) {
    fireRiskAlert(bikeId, deviceId, score, level, reasons, updatedAt).catch(e =>
      console.error('[Risk] Failed to fire risk alert:', e.message)
    );
  }

  return { score, level, reasons };
}

function getCurrentScores() {
  const out = {};
  for (const [bikeId, state] of scoreState.entries()) out[bikeId] = state;
  return out;
}

module.exports = { evaluatePing, rebuildBaseline, rebuildAllBaselines, getCurrentScores, reloadAlertSettings };
