'use strict';

/**
 * Outbound webhook delivery for tracking alarms.
 *
 * Subscribes once to the in-process trackingEvents 'alert' channel, which every
 * alert producer already emits on (tripService, geofenceService, riskService,
 * batteryHealthService). Hooking there rather than at each INSERT means any
 * alert type added later is delivered automatically, with no new wiring.
 *
 * Delivery is queued to Postgres first and sent second. A crash between the two
 * would otherwise drop the event silently; this way the retry sweep picks it up.
 *
 * Receivers verify authenticity with an HMAC-SHA256 signature over the exact
 * request body, keyed on the endpoint's secret. The timestamp is inside the
 * signed payload, so a captured request can't be replayed with a fresh one.
 */

const crypto = require('crypto');
const pgDb = require('../pgDb');
const trackingEvents = require('../trackingEvents');

const MAX_ATTEMPTS = 6;
// Exponential-ish backoff, capped: ~1m, 5m, 15m, 1h, 6h. A control room that
// drops offline for a few hours still gets the backlog rather than losing it.
const BACKOFF_SECONDS = [60, 300, 900, 3600, 21600];
const REQUEST_TIMEOUT_MS = 10_000;

function signPayload(secret, body) {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

// Enriches the raw trackingEvents payload with the identity a control room
// needs to act: which vehicle, and whose phone to ring.
async function buildEventBody(alert) {
  const { rows } = await pgDb.query(
    `SELECT b.id AS bike_id, b.registration, b.make, b.model,
            b.last_known_lat, b.last_known_lng, b.last_location_at,
            h.id AS hub_id, h.name AS hub_name,
            u.id AS rider_id, u.full_name AS rider_name, u.phone AS rider_phone,
            ag.agreement_no
       FROM bikes b
       LEFT JOIN hubs h ON h.id = b.hub_id
       LEFT JOIN LATERAL (
         SELECT * FROM agreements WHERE bike_id = b.id AND status = 'active'
         ORDER BY id DESC LIMIT 1
       ) ag ON TRUE
       LEFT JOIN users u ON u.id = ag.user_id
      WHERE b.id = $1`, [alert.bike_id]);
  const v = rows[0] || {};

  let detail = {};
  try { detail = typeof alert.payload === 'string' ? JSON.parse(alert.payload || '{}') : (alert.payload || {}); }
  catch { detail = {}; }

  return {
    event_id: `alert-${alert.id}`,
    event_type: alert.alert_type,
    severity: alert.severity || null,
    occurred_at: alert.created_at,
    sent_at: new Date().toISOString(),
    vehicle: {
      id: v.bike_id ?? alert.bike_id ?? null,
      registration: v.registration ?? alert.bike_registration ?? null,
      make: v.make ?? null,
      model: v.model ?? null,
      group: v.hub_id ? { id: v.hub_id, name: v.hub_name } : null,
      last_known_position: v.last_known_lat != null
        ? { lat: v.last_known_lat, lng: v.last_known_lng, at: v.last_location_at }
        : null,
    },
    driver: v.rider_id
      ? { id: v.rider_id, name: v.rider_name, phone: v.rider_phone, agreement_no: v.agreement_no }
      : null,
    detail,
  };
}

async function endpointsFor(eventType) {
  const { rows } = await pgDb.query(
    `SELECT * FROM webhook_endpoints WHERE active = TRUE AND scope = 'platform'`);
  // NULL event_types means "every event" — deliberately the default, so an
  // alert type added later isn't silently withheld from an existing subscriber.
  return rows.filter((e) => {
    if (!e.event_types) return true;
    return String(e.event_types).split(',').map((s) => s.trim()).filter(Boolean).includes(eventType);
  });
}

async function queueAlert(alert) {
  const targets = await endpointsFor(alert.alert_type);
  if (!targets.length) return 0;

  const body = await buildEventBody(alert);
  const serialized = JSON.stringify(body);
  let queued = 0;
  for (const endpoint of targets) {
    try {
      // ON CONFLICT: the unique (endpoint_id, event_id) index makes a
      // re-emitted alert a no-op rather than a duplicate delivery.
      const { rows } = await pgDb.query(
        `INSERT INTO webhook_deliveries (endpoint_id, event_type, event_id, payload)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (endpoint_id, event_id) DO NOTHING
         RETURNING id`,
        [endpoint.id, body.event_type, body.event_id, serialized]);
      if (rows[0]) queued += 1;
    } catch (e) {
      console.error('[webhooks] queue failed:', e.message);
    }
  }
  if (queued) setImmediate(() => flush().catch(() => {}));
  return queued;
}

async function deliver(delivery, endpoint) {
  const signature = signPayload(endpoint.secret, delivery.payload);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(endpoint.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'OnFleet-Webhooks/1',
        'X-OnFleet-Event': delivery.event_type,
        'X-OnFleet-Delivery': String(delivery.id),
        'X-OnFleet-Event-Id': delivery.event_id,
        'X-OnFleet-Signature': `sha256=${signature}`,
      },
      body: delivery.payload,
      signal: controller.signal,
    });
    return { ok: response.ok, status: response.status, error: response.ok ? null : `HTTP ${response.status}` };
  } catch (e) {
    return { ok: false, status: null, error: e.name === 'AbortError' ? 'Request timed out' : e.message };
  } finally {
    clearTimeout(timer);
  }
}

async function recordResult(delivery, endpoint, result) {
  const attempts = delivery.attempts + 1;
  if (result.ok) {
    await pgDb.query(
      `UPDATE webhook_deliveries SET status='delivered', attempts=$1, response_code=$2,
              delivered_at=NOW(), last_error=NULL WHERE id=$3`,
      [attempts, result.status, delivery.id]);
    await pgDb.query(
      `UPDATE webhook_endpoints SET last_success_at=NOW(), last_error=NULL WHERE id=$1`, [endpoint.id]);
    return;
  }

  const exhausted = attempts >= MAX_ATTEMPTS;
  const backoff = BACKOFF_SECONDS[Math.min(attempts - 1, BACKOFF_SECONDS.length - 1)];
  await pgDb.query(
    `UPDATE webhook_deliveries
        SET status=$1, attempts=$2, response_code=$3, last_error=$4,
            next_attempt_at = NOW() + ($5 || ' seconds')::interval
      WHERE id=$6`,
    [exhausted ? 'failed' : 'pending', attempts, result.status, result.error, String(backoff), delivery.id]);
  await pgDb.query(
    `UPDATE webhook_endpoints SET last_failure_at=NOW(), last_error=$1 WHERE id=$2`,
    [result.error, endpoint.id]);
  if (exhausted) {
    console.error(`[webhooks] giving up on delivery ${delivery.id} to endpoint ${endpoint.id} after ${attempts} attempts: ${result.error}`);
  }
}

// Sends everything currently due. Called on enqueue and on a timer; safe to run
// concurrently with itself since each delivery row is claimed by its own UPDATE.
let flushing = false;
async function flush(limit = 50) {
  if (flushing) return 0;
  flushing = true;
  try {
    const { rows: due } = await pgDb.query(
      `SELECT d.*, e.url, e.secret, e.active
         FROM webhook_deliveries d
         JOIN webhook_endpoints e ON e.id = d.endpoint_id
        WHERE d.status = 'pending' AND d.next_attempt_at <= NOW() AND e.active = TRUE
        ORDER BY d.next_attempt_at ASC
        LIMIT $1`, [limit]);

    let sent = 0;
    for (const row of due) {
      const endpoint = { id: row.endpoint_id, url: row.url, secret: row.secret };
      const result = await deliver(row, endpoint);
      await recordResult(row, endpoint, result);
      if (result.ok) sent += 1;
    }
    return sent;
  } finally {
    flushing = false;
  }
}

let started = false;
function start() {
  if (started) return;
  started = true;
  trackingEvents.on('alert', (alert) => {
    queueAlert(alert).catch((e) => console.error('[webhooks] queueAlert failed:', e.message));
  });
  // Catches retries and anything queued while the process was down.
  setInterval(() => { flush().catch((e) => console.error('[webhooks] flush failed:', e.message)); }, 60_000).unref();
  console.log('[webhooks] outbound dispatcher started');
}

module.exports = { start, flush, queueAlert, signPayload, buildEventBody };
