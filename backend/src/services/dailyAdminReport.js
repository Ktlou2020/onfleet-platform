'use strict';

// Morning report for admins, sent at 08:00 SAST: what the trackers did in the
// last 24 hours, which riders missed yesterday's instalment, who is about to
// finish paying, and the queues that are waiting on an admin.
//
// Balances and arrears use the same rule as the agreement page
// (routes/agreements.js GET /:id): successful payments against total_amount,
// with arrears as weeks due so far x weekly amount, less what has been paid.
// Using the schedule rows' own allocation instead would disagree with the
// figure an admin sees when they click through, and the report should never
// be the second opinion.

const pgDb = require('../pgDb');
const { ALERT_SEVERITY } = require('../constants/alertTypes');

const PORTAL = process.env.PORTAL_URL || 'https://portal.onfleet.africa';
const TZ = 'Africa/Johannesburg';
const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low'];
const PAYOFF_WEEKS = 3;
const LIST_LIMIT = 25;

const ALERT_LABELS = {
  panic: 'Panic button', tamper: 'Tamper', power_disconnect: 'Power disconnected', movement: 'Unauthorised movement',
  theft_risk: 'Theft risk', night_movement: 'Night movement', towing: 'Towing', engine_cut_auto: 'Automatic engine cut',
  speeding: 'Speeding', harsh_brake: 'Harsh braking', geofence_exit: 'Left geofence',
  harsh_accel: 'Harsh acceleration', harsh_cornering: 'Harsh cornering', geofence_enter: 'Entered geofence',
  low_battery: 'Low battery', long_trip: 'Long trip', battery_declining: 'Battery declining',
  idle: 'Idling', device_offline: 'Tracker offline', bike_dormant: 'Bike dormant',
};

// ── formatting ───────────────────────────────────────────────────────────────

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function rand(value) {
  const n = Number(value) || 0;
  const [whole, cents] = Math.abs(n).toFixed(2).split('.');
  return `${n < 0 ? '-' : ''}R${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')},${cents}`;
}

function sastDate(date) {
  // en-CA gives YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

function sastTime(value) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('en-ZA', { timeZone: TZ, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(value));
}

function longDate(isoDate) {
  return new Intl.DateTimeFormat('en-ZA', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(`${isoDate}T00:00:00Z`));
}

function shiftDate(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function isoDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

// ── data ─────────────────────────────────────────────────────────────────────

async function trackingSection(from, to) {
  const { rows: alerts } = await pgDb.query(
    `SELECT a.id, a.alert_type, a.severity, a.created_at, a.acknowledged_at, a.resolved_at, a.bike_id,
            b.registration, b.status AS bike_status
       FROM tracking_alerts a LEFT JOIN bikes b ON b.id = a.bike_id
      WHERE a.created_at >= $1 AND a.created_at < $2
      ORDER BY a.created_at`, [from, to]);

  const byType = new Map();
  const byBike = new Map();
  for (const a of alerts) {
    a.severity = a.severity || ALERT_SEVERITY[a.alert_type] || 'low';
    const t = byType.get(a.alert_type) || { type: a.alert_type, severity: a.severity, count: 0, open: 0, bikes: new Set() };
    t.count += 1;
    if (!a.resolved_at) t.open += 1;
    if (a.bike_id) t.bikes.add(a.bike_id);
    byType.set(a.alert_type, t);
    if (a.bike_id) {
      const b = byBike.get(a.bike_id) || { registration: a.registration, bike_status: a.bike_status, count: 0, types: new Map() };
      b.count += 1;
      b.types.set(a.alert_type, (b.types.get(a.alert_type) || 0) + 1);
      byBike.set(a.bike_id, b);
    }
  }
  const types = [...byType.values()]
    .map((t) => ({ ...t, bikes: t.bikes.size }))
    .sort((x, y) => SEVERITY_ORDER.indexOf(x.severity) - SEVERITY_ORDER.indexOf(y.severity) || y.count - x.count);
  const serious = alerts.filter((a) => a.severity === 'critical' || a.severity === 'high').reverse();
  const noisiest = [...byBike.values()].sort((x, y) => y.count - x.count).slice(0, 5);

  // Critical alerts nobody has closed, whenever they were raised
  const { rows: [openCritical] } = await pgDb.query(
    `SELECT COUNT(*)::int AS n FROM tracking_alerts WHERE resolved_at IS NULL AND severity = 'critical'`);

  const { rows: [trips] } = await pgDb.query(
    `SELECT COUNT(*)::int AS trips, COUNT(DISTINCT bike_id)::int AS bikes,
            COALESCE(SUM(distance_km), 0)::float AS km
       FROM trips WHERE started_at >= $1 AND started_at < $2`, [from, to]);
  const { rows: fastest } = await pgDb.query(
    `SELECT t.max_speed_kmh, b.registration FROM trips t LEFT JOIN bikes b ON b.id = t.bike_id
      WHERE t.started_at >= $1 AND t.started_at < $2 AND t.max_speed_kmh IS NOT NULL
      ORDER BY t.max_speed_kmh DESC LIMIT 1`, [from, to]);

  const { rows: devices } = await pgDb.query(
    `SELECT d.id, d.imei, d.last_seen_at, d.created_at, d.engine_cut_active, d.engine_cut_at, d.engine_cut_reason,
            b.registration, b.status AS bike_status
       FROM tracking_devices d LEFT JOIN bikes b ON b.id = d.bike_id
      ORDER BY b.registration NULLS LAST`);
  const reporting = devices.filter((d) => d.last_seen_at && new Date(d.last_seen_at) >= from);
  const silent = devices.filter((d) => d.last_seen_at && new Date(d.last_seen_at) < from);
  const neverConnected = devices.filter((d) => !d.last_seen_at);
  const engineCut = devices.filter((d) => d.engine_cut_active);
  const onInactiveBikes = devices.filter((d) => d.registration && d.bike_status !== 'active');

  const { rows: [coverage] } = await pgDb.query(
    `SELECT COUNT(*)::int AS active,
            COUNT(*) FILTER (WHERE id IN (SELECT bike_id FROM tracking_devices WHERE bike_id IS NOT NULL))::int AS tracked
       FROM bikes WHERE status = 'active'`);

  // Engine commands and tracker changes, from the audit log
  const { rows: actions } = await pgDb.query(
    `SELECT l.action, l.metadata, l.created_at, u.full_name
       FROM audit_logs l LEFT JOIN users u ON u.id = l.actor_id
      WHERE l.created_at >= $1 AND l.created_at < $2
        AND (l.action IN ('tracking.engine_cut', 'tracking.engine_restore') OR l.action LIKE 'tracking.device_%')
      ORDER BY l.created_at`, [from, to]);
  const bikeIds = [...new Set(actions.map((r) => parseMeta(r.metadata).bike_id).filter(Boolean))];
  const plates = new Map();
  if (bikeIds.length) {
    const { rows } = await pgDb.query('SELECT id, registration FROM bikes WHERE id = ANY($1)', [bikeIds]);
    rows.forEach((r) => plates.set(r.id, r.registration));
  }
  const activity = actions.map((r) => {
    const m = parseMeta(r.metadata);
    return { ...r, meta: m, registration: m.registration || m.to_registration || plates.get(m.bike_id) || null };
  });

  return {
    alerts: { total: alerts.length, types, serious, noisiest, openCritical: openCritical.n },
    trips: { ...trips, fastest: fastest[0] || null },
    devices: { total: devices.length, reporting: reporting.length, silent, neverConnected, engineCut, onInactiveBikes },
    coverage,
    activity,
  };
}

function parseMeta(metadata) {
  if (!metadata) return {};
  if (typeof metadata === 'object') return metadata;
  try { return JSON.parse(metadata); } catch { return {}; }
}

async function agreementsSection(yesterday) {
  const { rows } = await pgDb.query(
    `WITH paid AS (
       SELECT agreement_id,
              SUM(COALESCE(NULLIF(net_amount, 0), amount)) AS paid,
              MAX(paid_at) AS last_paid_at
         FROM payments WHERE status = 'success' GROUP BY agreement_id
     ), sched AS (
       SELECT agreement_id,
              COUNT(*) FILTER (WHERE due_date <= $1) AS weeks_due,
              BOOL_OR(due_date = $1) AS due_yesterday,
              MAX(due_date) AS final_due
         FROM payment_schedules WHERE status <> 'waived' GROUP BY agreement_id
     )
     SELECT a.id, a.agreement_no, a.weekly_amount, a.total_amount,
            u.full_name, u.phone, b.registration,
            COALESCE(p.paid, 0) AS paid, p.last_paid_at,
            COALESCE(s.weeks_due, 0) AS weeks_due, COALESCE(s.due_yesterday, FALSE) AS due_yesterday, s.final_due
       FROM agreements a
       LEFT JOIN paid p ON p.agreement_id = a.id
       LEFT JOIN sched s ON s.agreement_id = a.id
       LEFT JOIN users u ON u.id = a.user_id
       LEFT JOIN bikes b ON b.id = a.bike_id
      WHERE a.status = 'active'`, [yesterday]);

  const agreements = rows.map((r) => {
    const weekly = Number(r.weekly_amount) || 0;
    const total = Number(r.total_amount) || 0;
    const paid = Number(r.paid) || 0;
    const dueSoFar = Math.min(total, Number(r.weeks_due) * weekly);
    const arrears = Math.max(0, +(dueSoFar - paid).toFixed(2));
    const remaining = Math.max(0, +(total - paid).toFixed(2));
    return {
      ...r, weekly, total, paid, arrears, remaining,
      weeksBehind: weekly > 0 ? Math.ceil(+(arrears / weekly).toFixed(6)) : 0,
      weeksLeft: weekly > 0 ? +(remaining / weekly).toFixed(1) : null,
      final_due: isoDate(r.final_due),
    };
  });

  const missed = agreements.filter((a) => a.due_yesterday && a.arrears > 0)
    .sort((x, y) => y.arrears - x.arrears);
  const inArrears = agreements.filter((a) => a.arrears > 0).sort((x, y) => y.arrears - x.arrears);
  const nearPayoff = agreements
    .filter((a) => a.remaining > 0 && a.weekly > 0 && a.remaining < PAYOFF_WEEKS * a.weekly)
    .sort((x, y) => x.remaining - y.remaining);
  // Completion is a manual step, so a fully paid agreement stays 'active'
  // (and the bike isn't marked paid off) until an admin closes it.
  const paidInFull = agreements.filter((a) => a.total > 0 && a.remaining === 0);

  return {
    activeCount: agreements.length,
    missed,
    missedTotal: missed.reduce((s, a) => s + a.arrears, 0),
    inArrears,
    arrearsTotal: inArrears.reduce((s, a) => s + a.arrears, 0),
    nearPayoff,
    paidInFull,
  };
}

async function operationsSection(from, to, today) {
  const q = async (sql, params = []) => (await pgDb.query(sql, params)).rows;

  const [received] = await q(
    `SELECT COUNT(*)::int AS n, COALESCE(SUM(amount), 0)::float AS total
       FROM payments WHERE status = 'success' AND COALESCE(paid_at, created_at) >= $1 AND COALESCE(paid_at, created_at) < $2`, [from, to]);
  const [paystack] = await q(
    `SELECT COUNT(*)::int AS n, COALESCE(SUM(amount), 0)::float AS total
       FROM paystack_charges WHERE status = 'unconfirmed'`);
  const [applications] = await q(
    `SELECT COUNT(*)::int AS n, MIN(submitted_at) AS oldest
       FROM applications WHERE status IN ('submitted', 'under_review')`);
  const [workshop] = await q(
    `SELECT COUNT(*) FILTER (WHERE status IN ('open', 'in_progress'))::int AS open,
            COUNT(*) FILTER (WHERE status IN ('open', 'in_progress') AND technician_id IS NULL)::int AS unassigned,
            COUNT(*) FILTER (WHERE status IN ('open', 'in_progress') AND created_at < $1::timestamptz - INTERVAL '7 days')::int AS stale,
            COUNT(*) FILTER (WHERE status = 'completed' AND completed_at >= $2 AND completed_at < $1)::int AS completed
       FROM job_cards`, [to, from]);
  const [payouts] = await q(
    `SELECT COUNT(*)::int AS n, COALESCE(SUM(amount_requested), 0)::float AS total
       FROM fleet_payout_requests WHERE status = 'pending'`);
  const paperwork = await q(
    `SELECT registration, license_disc_expiry, insurance_expiry FROM bikes
      WHERE status = 'active'
        AND (license_disc_expiry <= $1::date + 14 OR insurance_expiry <= $1::date + 14)
      ORDER BY LEAST(COALESCE(license_disc_expiry, 'infinity'::date), COALESCE(insurance_expiry, 'infinity'::date))`, [today]);
  const [failedMessages] = await q(
    `SELECT COUNT(*)::int AS n FROM notifications
      WHERE status = 'failed' AND created_at >= $1 AND created_at < $2`, [from, to]);

  let backup = null;
  try {
    backup = require('./backupService').listBackups().summary;
  } catch (e) {
    backup = { error: e.message };
  }

  return { received, paystack, applications, workshop, payouts, paperwork, failedMessages: failedMessages.n, backup };
}

async function collectDailyReport(now = new Date()) {
  const to = now;
  const from = new Date(now.getTime() - 24 * 3600 * 1000);
  const today = sastDate(now);
  const yesterday = shiftDate(today, -1);
  const [tracking, agreements, operations] = await Promise.all([
    trackingSection(from, to),
    agreementsSection(yesterday),
    operationsSection(from, to, today),
  ]);
  return { from, to, today, yesterday, tracking, agreements, operations };
}

// ── rendering ────────────────────────────────────────────────────────────────

const C = { ink: '#1a2b42', muted: '#6b7280', line: '#e5e7eb', red: '#b91c1c', amber: '#b45309', green: '#15803d', navy: '#1E3A5F' };
const SEV_COLOUR = { critical: C.red, high: C.amber, medium: '#1d4ed8', low: C.muted };

function h2(text, link) {
  return `<h2 style="font-size:17px;margin:32px 0 8px;color:${C.navy};border-bottom:2px solid ${C.navy};padding-bottom:4px">${esc(text)}${
    link ? ` <a href="${PORTAL}${link}" style="font-size:12px;font-weight:400;color:#2563EB;text-decoration:none">open ›</a>` : ''}</h2>`;
}
function h3(text) {
  return `<h3 style="font-size:14px;margin:18px 0 6px;color:${C.ink}">${esc(text)}</h3>`;
}
function p(html, colour = C.ink) {
  return `<p style="margin:6px 0;font-size:14px;color:${colour}">${html}</p>`;
}
function table(headers, rows, { note } = {}) {
  if (!rows.length) return '';
  const hasHeader = headers.some((h) => (h.label ?? h) !== '');
  const th = !hasHeader ? '' : headers.map((h) => `<th align="${h.right ? 'right' : 'left'}" style="padding:6px 8px;font-size:11px;text-transform:uppercase;letter-spacing:.4px;color:${C.muted};border-bottom:1px solid ${C.line}">${esc(h.label ?? h)}</th>`).join('');
  const body = rows.map((cells) => `<tr>${cells.map((c, i) => `<td align="${headers[i].right ? 'right' : 'left'}" style="padding:6px 8px;font-size:13px;border-bottom:1px solid ${C.line};vertical-align:top">${c}</td>`).join('')}</tr>`).join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:6px 0">${th ? `<tr>${th}</tr>` : ''}${body}</table>${note ? p(note, C.muted) : ''}`;
}
function capped(list, render, what) {
  const shown = list.slice(0, LIST_LIMIT).map(render);
  const more = list.length > LIST_LIMIT ? `Showing ${LIST_LIMIT} of ${list.length} ${what}.` : undefined;
  return { rows: shown, note: more };
}
function rider(a) {
  return `${esc(a.full_name || 'Unknown rider')}${a.phone ? `<br><span style="color:${C.muted};font-size:12px">${esc(a.phone)}</span>` : ''}`;
}
function agreementLink(a) {
  return `<a href="${PORTAL}/admin/agreements/${a.id}" style="color:#2563EB;text-decoration:none">${esc(a.agreement_no || `#${a.id}`)}</a>`;
}
function badge(text, colour) {
  return `<span style="display:inline-block;padding:1px 7px;border-radius:9px;font-size:11px;font-weight:700;color:#fff;background:${colour}">${esc(text)}</span>`;
}

function attentionItems(r) {
  const { tracking: t, agreements: a, operations: o } = r;
  const items = [];
  if (t.alerts.openCritical) items.push([C.red, `${plural(t.alerts.openCritical, 'critical alert')} still open`, '/admin/tracking']);
  if (a.missed.length) items.push([C.red, `${plural(a.missed.length, 'rider')} missed yesterday's payment (${rand(a.missedTotal)})`, '/admin/collections']);
  if (t.devices.silent.length) items.push([C.amber, `${plural(t.devices.silent.length, 'tracker')} silent for more than 24 hours`, '/admin/tracking/dashboard']);
  if (t.devices.neverConnected.length) items.push([C.amber, `${plural(t.devices.neverConnected.length, 'tracker')} registered but never connected`, '/admin/tracking/dashboard']);
  if (a.paidInFull.length) items.push([C.amber, `${plural(a.paidInFull.length, 'agreement')} paid in full but still open`, '/admin/agreements']);
  if (o.paystack.n) items.push([C.amber, `${plural(o.paystack.n, 'Paystack debit order')} to review (${rand(o.paystack.total)})`, '/admin/paystack-charges']);
  if (o.backup && (o.backup.error || o.backup.stale || o.backup.damaged)) items.push([C.red, 'Last night\'s backup needs checking', '/admin/integrations']);
  if (o.paperwork.length) items.push([C.amber, `${plural(o.paperwork.length, 'active bike')} with licence disc or insurance expiring within 14 days`, '/admin/bikes']);
  if (a.nearPayoff.length) items.push([C.green, `${plural(a.nearPayoff.length, 'rider')} within ${PAYOFF_WEEKS} weeks of paying off`, '/admin/agreements']);
  return items;
}

function renderDailyReport(r) {
  const { tracking: t, agreements: a, operations: o } = r;
  const parts = [];

  parts.push(`<h1 style="font-size:22px;margin:0 0 2px;color:${C.ink}">Daily fleet report</h1>`);
  parts.push(p(`${esc(longDate(r.today))} &nbsp;·&nbsp; covers ${esc(sastTime(r.from))} to ${esc(sastTime(r.to))}`, C.muted));

  const attention = attentionItems(r);
  parts.push(h2('Needs attention'));
  parts.push(attention.length
    ? `<ul style="margin:6px 0;padding-left:18px">${attention.map(([colour, text, link]) =>
      `<li style="margin:4px 0;font-size:14px;color:${colour}"><a href="${PORTAL}${link}" style="color:${colour};text-decoration:none">${esc(text)}</a></li>`).join('')}</ul>`
    : p('Nothing needs attention this morning.', C.green));

  // ── Tracking
  parts.push(h2('Tracking: last 24 hours', '/admin/tracking/dashboard'));
  parts.push(p(`<b>${t.devices.reporting}</b> of ${t.devices.total} trackers reported &nbsp;·&nbsp; <b>${t.trips.trips}</b> trips by ${plural(t.trips.bikes, 'bike')}, ${Math.round(t.trips.km).toLocaleString('en-ZA')} km${
    t.trips.fastest ? ` &nbsp;·&nbsp; top speed ${Math.round(t.trips.fastest.max_speed_kmh)} km/h (${esc(t.trips.fastest.registration || 'unlinked')})` : ''}`));
  parts.push(p(`Tracker coverage: <b>${t.coverage.tracked}/${t.coverage.active}</b> active bikes (${plural(t.coverage.active - t.coverage.tracked, 'bike')} without one)`, C.muted));

  parts.push(h3(`Alarms: ${t.alerts.total}`));
  if (!t.alerts.total) parts.push(p('No alarms.', C.muted));
  parts.push(table(
    ['Alarm', 'Severity', { label: 'Count', right: true }, { label: 'Bikes', right: true }, { label: 'Still open', right: true }],
    t.alerts.types.map((x) => [esc(ALERT_LABELS[x.type] || x.type), badge(x.severity, SEV_COLOUR[x.severity] || C.muted), x.count, x.bikes, x.open]),
  ));
  if (t.alerts.serious.length) {
    parts.push(h3('Critical and high alarms'));
    const s = capped(t.alerts.serious, (x) => [
      esc(sastTime(x.created_at)), esc(x.registration || 'Unlinked'), esc(ALERT_LABELS[x.alert_type] || x.alert_type),
      badge(x.severity, SEV_COLOUR[x.severity]),
      x.resolved_at ? `<span style="color:${C.green}">Resolved</span>` : x.acknowledged_at ? 'Acknowledged' : `<span style="color:${C.red}">Open</span>`,
    ], 'alarms');
    parts.push(table(['Time', 'Bike', 'Alarm', 'Severity', 'Status'], s.rows, { note: s.note }));
  }
  if (t.alerts.noisiest.length && t.alerts.total >= 10) {
    parts.push(h3('Bikes raising the most alarms'));
    parts.push(table(['Bike', { label: 'Alarms', right: true }, 'Mostly'], t.alerts.noisiest.map((b) => {
      const top = [...b.types.entries()].sort((x, y) => y[1] - x[1])[0];
      return [`${esc(b.registration || 'Unlinked')}${b.bike_status && b.bike_status !== 'active' ? ` <span style="color:${C.muted};font-size:12px">(${esc(b.bike_status.replace(/_/g, ' '))})</span>` : ''}`,
        b.count, esc(`${ALERT_LABELS[top[0]] || top[0]} (${top[1]})`)];
    })));
  }

  if (t.activity.length) {
    parts.push(h3('Engine commands and tracker changes'));
    const labels = {
      'tracking.engine_cut': 'Engine cut', 'tracking.engine_restore': 'Engine restored',
      'tracking.device_register': 'Tracker registered', 'tracking.device_register_rejected': 'Tracker registration refused (already registered)',
      'tracking.device_link': 'Tracker linked', 'tracking.device_unlink': 'Tracker unlinked', 'tracking.device_relink': 'Tracker moved',
      'tracking.device_update': 'Tracker settings changed', 'tracking.device_delete': 'Tracker deleted',
    };
    const s = capped(t.activity, (x) => {
      const m = x.meta;
      const bike = x.action === 'tracking.device_relink'
        ? `${esc(m.from_registration || '—')} → ${esc(m.to_registration || '—')}`
        : esc(x.registration || '—');
      return [esc(sastTime(x.created_at)), esc(labels[x.action] || x.action), bike, esc(m.imei || ''), esc(x.full_name || 'System')];
    }, 'entries');
    parts.push(table(['Time', 'What', 'Bike', 'IMEI', 'By'], s.rows, { note: s.note }));
  }

  if (t.devices.engineCut.length) {
    parts.push(h3(`Engines currently cut: ${t.devices.engineCut.length}`));
    parts.push(table(['Bike', 'Since', 'Reason'], t.devices.engineCut.map((d) =>
      [esc(d.registration || 'Unlinked'), esc(sastTime(d.engine_cut_at)), esc(d.engine_cut_reason || '')])));
  }
  if (t.devices.silent.length) {
    parts.push(h3('Trackers silent for more than 24 hours'));
    const s = capped(t.devices.silent, (d) => [esc(d.registration || 'Unlinked'), esc(d.bike_status ? d.bike_status.replace(/_/g, ' ') : '—'), esc(d.imei), esc(sastTime(d.last_seen_at))], 'trackers');
    parts.push(table(['Bike', 'Bike status', 'IMEI', 'Last seen'], s.rows, { note: s.note }));
  }
  if (t.devices.neverConnected.length) {
    parts.push(h3('Trackers registered but never connected'));
    parts.push(table(['Bike', 'IMEI', 'Registered'], t.devices.neverConnected.map((d) =>
      [esc(d.registration || 'Unlinked'), esc(d.imei), esc(sastTime(d.created_at))]),
    { note: 'Check power, SIM data and that the tracker points at hayabusa.proxy.rlwy.net port 52322.' }));
  }
  if (t.devices.onInactiveBikes.length) {
    parts.push(p(`${plural(t.devices.onInactiveBikes.length, 'tracker')} ${t.devices.onInactiveBikes.length === 1 ? 'is' : 'are'} on bikes that are not active: ${
      t.devices.onInactiveBikes.map((d) => `${esc(d.registration)} (${esc(String(d.bike_status || '').replace(/_/g, ' '))})`).join(', ')}.`, C.muted));
  }

  // ── Payments
  parts.push(h2(`Missed payments: due ${longDate(r.yesterday)}`, '/admin/collections'));
  if (!a.missed.length) {
    parts.push(p('Every rider with an instalment due yesterday is up to date.', C.green));
  } else {
    parts.push(p(`<b>${plural(a.missed.length, 'rider')}</b> did not pay in full: <b>${rand(a.missedTotal)}</b> outstanding across their agreements.`));
    const s = capped(a.missed, (x) => [rider(x), esc(x.registration || '—'), agreementLink(x), rand(x.weekly), rand(x.arrears), x.weeksBehind, esc(x.last_paid_at ? sastTime(x.last_paid_at) : 'Never')], 'riders');
    parts.push(table(['Rider', 'Bike', 'Agreement', { label: 'Weekly', right: true }, { label: 'Owing', right: true }, { label: 'Weeks behind', right: true }, 'Last paid'], s.rows, { note: s.note }));
  }
  parts.push(p(`All active agreements: <b>${a.inArrears.length}</b> of ${a.activeCount} are behind, <b>${rand(a.arrearsTotal)}</b> in total.`, C.muted));

  parts.push(h2(`Paying off within ${PAYOFF_WEEKS} weeks`, '/admin/agreements'));
  if (!a.nearPayoff.length) {
    parts.push(p('No riders are within three weeks of paying off.', C.muted));
  } else {
    const s = capped(a.nearPayoff, (x) => [rider(x), esc(x.registration || '—'), agreementLink(x), rand(x.remaining), x.weeksLeft, esc(x.final_due || '—')], 'riders');
    parts.push(table(['Rider', 'Bike', 'Agreement', { label: 'Left to pay', right: true }, { label: 'Weeks left', right: true }, 'Final due'], s.rows, { note: s.note }));
  }
  if (a.paidInFull.length) {
    parts.push(h3('Paid in full but still open'));
    parts.push(p('Close these so the bike is marked paid off and billing stops.', C.muted));
    const s = capped(a.paidInFull, (x) => [rider(x), esc(x.registration || '—'), agreementLink(x), rand(x.paid)], 'agreements');
    parts.push(table(['Rider', 'Bike', 'Agreement', { label: 'Paid', right: true }], s.rows, { note: s.note }));
  }

  // ── Everything else
  parts.push(h2('Other things to know'));
  const other = [
    ['Payments received (last 24 hours)', `${o.received.n} · ${rand(o.received.total)}`, '/admin/payments'],
    ['Paystack debit orders to review', o.paystack.n ? `${o.paystack.n} · ${rand(o.paystack.total)}` : 'None', '/admin/paystack-charges'],
    ['Applications waiting for a decision', o.applications.n ? `${o.applications.n}${o.applications.oldest ? ` · oldest ${sastTime(o.applications.oldest)}` : ''}` : 'None', '/admin/applications'],
    ['Workshop jobs open', `${o.workshop.open} (${o.workshop.unassigned} unassigned, ${o.workshop.stale} older than 7 days) · ${o.workshop.completed} completed yesterday`, '/admin/workshop'],
    ['Fleet payouts waiting', o.payouts.n ? `${o.payouts.n} · ${rand(o.payouts.total)}` : 'None', '/admin/fleet-payouts'],
    ['Messages that failed to send', String(o.failedMessages), '/admin/notifications'],
    ['Database backup', o.backup?.error ? `Could not check: ${o.backup.error}`
      : o.backup ? `${o.backup.damaged ? `${o.backup.damaged} damaged · ` : ''}${o.backup.stale ? 'No backup in the last 36 hours' : `Latest ${sastTime(o.backup.latest_at)}`}` : '—', '/admin/integrations'],
  ];
  parts.push(table(['', ''], other.map(([k, v, link]) =>
    [`<a href="${PORTAL}${link}" style="color:${C.ink};text-decoration:none">${esc(k)}</a>`, esc(v)])));
  if (o.paperwork.length) {
    parts.push(h3('Licence discs and insurance expiring within 14 days'));
    const s = capped(o.paperwork, (b) => {
      const flag = (d) => {
        const iso = isoDate(d);
        if (!iso) return '—';
        const colour = iso < r.today ? C.red : iso <= shiftDate(r.today, 14) ? C.amber : C.ink;
        return `<span style="color:${colour}">${esc(iso)}${iso < r.today ? ' (expired)' : ''}</span>`;
      };
      return [esc(b.registration), flag(b.license_disc_expiry), flag(b.insurance_expiry)];
    }, 'bikes');
    parts.push(table(['Bike', 'Licence disc', 'Insurance'], s.rows, { note: s.note }));
  }

  const body = parts.join('\n');
  const preheader = attention.length ? attention.slice(0, 3).map((x) => x[1]).join(' · ') : 'Nothing needs attention this morning';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Daily fleet report</title></head>
<body style="margin:0;padding:0;background:#f4f6f9;font-family:Arial,Helvetica,sans-serif">
<div style="display:none;max-height:0;overflow:hidden">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f9;padding:24px 0"><tr><td align="center">
<table role="presentation" width="720" cellpadding="0" cellspacing="0" style="max-width:720px;width:100%;background:#fff;border-radius:12px;overflow:hidden">
<tr><td style="background:${C.navy};padding:18px 28px"><span style="font-size:20px;font-weight:700;color:#fff">OnFleet</span><span style="font-size:13px;color:#93c5fd;margin-left:8px">Admin</span></td></tr>
<tr><td style="padding:24px 28px;color:${C.ink};font-size:14px;line-height:1.5">${body}</td></tr>
<tr><td style="background:#f4f6f9;padding:16px 28px;border-top:1px solid ${C.line};font-size:12px;color:${C.muted}">Sent every morning at 08:00 to OnFleet admins. Figures match the agreement pages on <a href="${PORTAL}" style="color:${C.navy}">portal.onfleet.africa</a>.</td></tr>
</table></td></tr></table></body></html>`;
}

function reportSubject(r) {
  const { agreements: a, tracking: t } = r;
  const bits = [`${t.alerts.total} alarms`, `${a.missed.length} missed payments`];
  if (a.nearPayoff.length) bits.push(`${a.nearPayoff.length} near payoff`);
  const day = new Intl.DateTimeFormat('en-ZA', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(`${r.today}T00:00:00Z`));
  return `OnFleet daily report, ${day}: ${bits.join(', ')}`;
}

// ── delivery ─────────────────────────────────────────────────────────────────

async function adminRecipients() {
  const { rows } = await pgDb.query(
    `SELECT id, email, full_name FROM users
      WHERE role IN ('admin', 'superadmin') AND status = 'active' AND deleted_at IS NULL
        AND COALESCE(TRIM(email), '') <> ''
      ORDER BY id`);
  return rows;
}

// One send per SAST day, even if the app restarts at 08:00 or runs on more
// than one instance: whoever flips the stored date first sends.
async function claimDay(day) {
  const { rows } = await pgDb.query(
    `INSERT INTO app_settings (setting_key, setting_value, updated_at)
     VALUES ('daily_admin_report_sent_for', $1, NOW())
     ON CONFLICT (setting_key) DO UPDATE SET setting_value = EXCLUDED.setting_value, updated_at = NOW()
       WHERE app_settings.setting_value IS DISTINCT FROM EXCLUDED.setting_value
     RETURNING setting_key`, [day]);
  return rows.length > 0;
}

async function sendDailyAdminReport({ now = new Date(), force = false, to = null } = {}) {
  const day = sastDate(now);
  if (!force && !(await claimDay(day))) return { skipped: 'already sent today', day };

  const report = await collectDailyReport(now);
  const html = renderDailyReport(report);
  const subject = reportSubject(report);
  const recipients = to ? [to] : await adminRecipients();
  const { sendHtmlEmail } = require('./notifier');

  const sent = [];
  const failed = [];
  for (const r of recipients) {
    try {
      await sendHtmlEmail(r.email, subject, html);
      sent.push(r.email);
    } catch (e) {
      failed.push({ email: r.email, error: e.message });
      console.error(`[daily-report] send to ${r.email} failed:`, e.message);
    }
  }
  const { logAudit } = require('../utils/helpersPg');
  await logAudit(null, 'report.daily_admin_sent', 'reports', null, { day, subject, sent, failed }, null);
  return { day, subject, sent, failed };
}

module.exports = {
  collectDailyReport, renderDailyReport, reportSubject, sendDailyAdminReport, adminRecipients,
  PAYOFF_WEEKS,
};
