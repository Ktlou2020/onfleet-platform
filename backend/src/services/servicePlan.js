'use strict';

// What this bike needs, at the kilometres on its clock.
//
// The manufacturer publishes a maintenance chart (inspect / clean / adjust /
// replace, per service) and a 36-month schedule (which part number at which
// kilometre reading). Both were paper. A technician opening a job card had to
// remember them, which is why services get done by date and parts get ordered
// after the bike is already apart.
//
// Given an odometer reading this works out which service the bike is at, what
// the chart says to do at that service, which parts are due to be replaced,
// and which are close enough to be worth doing while the bike is on the ramp.
// Parts already fitted recently are marked, so nothing is replaced twice.

const pgDb = require('../pgDb');

// The chart's services run to 30 500 km and then "repeat the frequency
// interval established here" (Note-1), so services continue every 3 000 km.
const REPEAT_EVERY_KM = 3000;
// A service due at 12 500 km is the same service at 12 100 or 13 200: the
// chart itself gives each service a 500 km window.
const WINDOW_KM = 800;
// Worth doing now rather than bringing the bike back for it.
const LOOKAHEAD_KM = 1500;

const ACTION_LABELS = {
  I: 'Inspect', R: 'Replace', C: 'Clean', L: 'Lubricate',
  A: 'Adjust if required', O: 'Oil change', T: 'Top up', E: 'Emission check',
};

const describeActions = (actions) => String(actions || '')
  .split(',').map((a) => ACTION_LABELS[a.trim()] || a.trim()).filter(Boolean).join(', ');

// Which numbered service an odometer reading belongs to, continuing past the
// published chart at its own interval.
function serviceAt(km, services) {
  if (!services.length) return null;
  const last = services[services.length - 1];
  for (const service of services) {
    if (km <= service.km_to + WINDOW_KM) return { ...service, cycle: 1 };
  }
  const past = km - last.km_to;
  const extra = Math.ceil(past / REPEAT_EVERY_KM);
  // Past the chart, services repeat: the 12th is 3 000 km after the 11th, and
  // its task list is the chart's own repeating pattern.
  const patternIndex = ((last.service_no + extra - 1) % services.length);
  return {
    ...services[patternIndex],
    service_no: last.service_no + extra,
    km_from: last.km_from + extra * REPEAT_EVERY_KM,
    km_to: last.km_to + extra * REPEAT_EVERY_KM,
    repeat_of: services[patternIndex].service_no,
    cycle: Math.floor((last.service_no + extra - 1) / services.length) + 1,
  };
}

async function servicePlanFor({ make, model, odometerKm, bikeId = null, db = pgDb }) {
  const km = Number(odometerKm);
  if (!Number.isFinite(km) || km < 0) return { error: 'Give the odometer reading in kilometres' };

  const { rows: services } = await db.query(
    `SELECT service_no, km_from, km_to FROM service_schedules
      WHERE LOWER(make) = LOWER($1) AND LOWER(model) = LOWER($2) ORDER BY service_no`, [make, model]);
  const { rows: scheduleParts } = await db.query(
    `SELECT description, part_number, at_km, qty FROM service_schedule_parts
      WHERE LOWER(make) = LOWER($1) AND LOWER(model) = LOWER($2)`, [make, model]);

  if (!services.length && !scheduleParts.length) {
    return { has_schedule: false, make, model, odometer_km: km, tasks: [], parts_due: [], parts_soon: [] };
  }

  const current = serviceAt(km, services);
  const { rows: tasks } = current
    ? await db.query(
      `SELECT item, actions, note FROM service_schedule_tasks
        WHERE LOWER(make) = LOWER($1) AND LOWER(model) = LOWER($2) AND service_no = $3
        ORDER BY id`, [make, model, current.repeat_of || current.service_no])
    : { rows: [] };

  // What this bike has had fitted before, so a part replaced 300 km ago isn't
  // recommended again. Job card items record what was actually used.
  const fitted = new Map();
  if (bikeId) {
    const { rows } = await db.query(
      `SELECT UPPER(REGEXP_REPLACE(jci.description, '[^A-Za-z0-9]', '', 'g')) AS key,
              MAX(jc.odometer_km) AS at_km, MAX(jc.completed_at) AS at
         FROM job_card_items jci
         JOIN job_cards jc ON jc.id = jci.job_card_id
        WHERE jc.bike_id = $1 AND jc.status = 'completed' AND jci.item_type = 'part'
        GROUP BY 1`, [bikeId]);
    for (const row of rows) fitted.set(row.key, row);
  }

  const plain = (value) => String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const lastFitted = (part) => {
    const byNumber = fitted.get(plain(part.part_number));
    const byName = [...fitted.entries()].find(([key]) => key.includes(plain(part.description).slice(0, 12)));
    return byNumber || (byName ? byName[1] : null);
  };

  const due = [];
  const soon = [];
  for (const part of scheduleParts) {
    const marks = (part.at_km || []).map(Number).sort((a, z) => a - z);
    const dueMark = marks.find((m) => Math.abs(m - km) <= WINDOW_KM);
    const nextMark = marks.find((m) => m > km);
    const previous = lastFitted(part);
    const entry = {
      description: part.description,
      part_number: part.part_number,
      qty: part.qty || 1,
      at_km: dueMark ?? nextMark ?? null,
      km_until: nextMark == null ? null : Math.max(0, Math.round(nextMark - km)),
      last_fitted_km: previous?.at_km == null ? null : Number(previous.at_km),
      last_fitted_at: previous?.at || null,
    };
    // Fitted since the mark came due? Then it is done, not due.
    const alreadyDone = dueMark != null && entry.last_fitted_km != null && entry.last_fitted_km >= dueMark - WINDOW_KM;
    if (dueMark != null && !alreadyDone) due.push({ ...entry, at_km: dueMark });
    else if (nextMark != null && nextMark - km <= LOOKAHEAD_KM) soon.push({ ...entry, at_km: nextMark });
  }

  // Prices and availability come from the dealer catalogue, so a job card can
  // show what the service will cost before the bike is stripped.
  const numbers = [...new Set([...due, ...soon].map((p) => plain(p.part_number)))];
  const priced = new Map();
  if (numbers.length) {
    const { rows } = await db.query(
      `SELECT UPPER(REGEXP_REPLACE(part_number, '[^A-Za-z0-9]', '', 'g')) AS key,
              part_number, description, price_ex_vat, status, is_kit
         FROM parts_catalog
        WHERE UPPER(REGEXP_REPLACE(part_number, '[^A-Za-z0-9]', '', 'g')) = ANY($1)
          AND price_ex_vat IS NOT NULL
        ORDER BY updated_at DESC NULLS LAST`, [numbers]);
    for (const row of rows) if (!priced.has(row.key)) priced.set(row.key, row);
  }
  const withPrice = (part) => {
    const match = priced.get(plain(part.part_number));
    return {
      ...part,
      catalogue_description: match?.description || null,
      price_ex_vat: match?.price_ex_vat == null ? null : Number(match.price_ex_vat),
      in_catalogue: !!match,
      is_kit: match?.is_kit || false,
    };
  };

  const partsDue = due.map(withPrice).sort((a, z) => a.description.localeCompare(z.description));

  // A scheduled part number that isn't in the dealer price list can't be
  // ordered or priced. That is usually a character's difference between two of
  // the manufacturer's own documents — the Eco 150 schedule asks for spark plug
  // 31916KRM4099S, the price list sells 31916KRM84099S. The nearest entries are
  // offered so a person can confirm which is right; nothing is substituted,
  // because Hero supply against the number asked for.
  const { nearestParts } = require('./partsImport');
  for (const part of partsDue) {
    if (part.in_catalogue) continue;
    part.did_you_mean = await nearestParts(part.part_number, { make, model, db });
  }
  const partsSoon = [];
  for (const part of soon.map(withPrice)) {
    if (!part.in_catalogue) part.did_you_mean = await nearestParts(part.part_number, { make, model, db });
    partsSoon.push(part);
  }
  partsSoon.sort((a, z) => (a.km_until ?? 0) - (z.km_until ?? 0));
  const total = (list) => +list.reduce((sum, p) => sum + (p.price_ex_vat || 0) * (p.qty || 1), 0).toFixed(2);

  return {
    has_schedule: true,
    make,
    model,
    odometer_km: km,
    service: current,
    next_service_km: current ? current.km_to + REPEAT_EVERY_KM : null,
    tasks: tasks.map((t) => ({ ...t, actions_text: describeActions(t.actions), replaces: /R/.test(t.actions) })),
    parts_due: partsDue,
    parts_soon: partsSoon,
    parts_due_total_ex_vat: total(partsDue),
    parts_soon_total_ex_vat: total(partsSoon),
  };
}

module.exports = { servicePlanFor, serviceAt, describeActions, ACTION_LABELS, WINDOW_KM, LOOKAHEAD_KM, REPEAT_EVERY_KM };
