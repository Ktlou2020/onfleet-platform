'use strict';

// When a bike is actually due for service.
//
// Servicing has been driven by next_service_date alone, while next_service_km
// (set to odometer + 3,000 km at every job) sat unused by anything that
// notifies. The trackers already credit every trip to bikes.odometer_km, so a
// delivery bike doing 90 km a day can blow through its service interval weeks
// before its date, turn red on a page nobody opens, and be serviced late.
//
// This computes both, and — because the fleet's own GPS data says how hard a
// bike is being ridden — projects the date the distance threshold will be
// reached, so a reminder can arrive before the bike is overdue rather than
// after.

const pgDb = require('../pgDb');

const SOON_KM = Number(process.env.SERVICE_DUE_SOON_KM) || 300;
const SOON_DAYS = Number(process.env.SERVICE_DUE_SOON_DAYS) || 14;
const USAGE_WINDOW_DAYS = 14;

function classify({ kmRemaining, daysRemaining }) {
  if ((kmRemaining != null && kmRemaining <= 0) || (daysRemaining != null && daysRemaining < 0)) return 'overdue';
  if ((kmRemaining != null && kmRemaining <= SOON_KM) || (daysRemaining != null && daysRemaining <= SOON_DAYS)) return 'due_soon';
  return 'ok';
}

const isoDay = (d) => d.toISOString().slice(0, 10);

// One row per bike that is due or nearly due, by distance or by date.
async function bikesDueForService({ organizationId = null, ownFleetOnly = false } = {}) {
  const where = ['b.status NOT IN (\'sold\', \'written_off\', \'stolen\')'];
  const params = [];
  if (organizationId) { params.push(organizationId); where.push(`b.organization_id = $${params.length}`); }
  if (ownFleetOnly) where.push('b.organization_id IS NULL');

  const { rows } = await pgDb.query(
    `SELECT b.id, b.registration, b.make, b.model, b.status, b.organization_id,
            b.odometer_km, b.next_service_km, b.next_service_date,
            o.name AS organization_name,
            u.id AS rider_id, u.full_name AS rider_name, u.phone AS rider_phone,
            ag.id AS agreement_id,
            COALESCE(t.km_14d, 0) AS km_14d
       FROM bikes b
       LEFT JOIN organizations o ON o.id = b.organization_id
       LEFT JOIN LATERAL (
         SELECT id, user_id FROM agreements WHERE bike_id = b.id AND status = 'active' ORDER BY id DESC LIMIT 1
       ) ag ON TRUE
       LEFT JOIN users u ON u.id = ag.user_id
       LEFT JOIN LATERAL (
         SELECT SUM(distance_km) AS km_14d FROM trips
          WHERE bike_id = b.id AND started_at >= NOW() - ($${params.length + 1} || ' days')::interval
       ) t ON TRUE
      WHERE ${where.join(' AND ')}`,
    [...params, String(USAGE_WINDOW_DAYS)]);

  const today = new Date();
  return rows.map((b) => {
    const odometer = b.odometer_km == null ? null : Number(b.odometer_km);
    const nextKm = b.next_service_km == null ? null : Number(b.next_service_km);
    const kmRemaining = odometer != null && nextKm != null ? Math.round(nextKm - odometer) : null;
    const daysRemaining = b.next_service_date
      ? Math.round((new Date(`${isoDay(new Date(b.next_service_date))}T00:00:00Z`) - new Date(`${isoDay(today)}T00:00:00Z`)) / 86400000)
      : null;
    const kmPerDay = +(Number(b.km_14d || 0) / USAGE_WINDOW_DAYS).toFixed(1);
    // Only project from real usage — a bike that hasn't moved in a fortnight
    // gets no invented service date.
    const daysToKm = kmRemaining != null && kmPerDay > 0.5 ? Math.max(0, Math.round(kmRemaining / kmPerDay)) : null;
    const projected = daysToKm == null ? null : isoDay(new Date(today.getTime() + daysToKm * 86400000));

    return {
      ...b,
      odometer_km: odometer,
      next_service_km: nextKm,
      km_14d: +Number(b.km_14d || 0).toFixed(1),
      km_per_day: kmPerDay,
      km_remaining: kmRemaining,
      days_remaining: daysRemaining,
      days_to_service_km: daysToKm,
      projected_service_date: projected,
      // Which measure is pulling it in first, so a reminder can say why.
      // A bike already past its service distance counts as distance-driven
      // however far off its date is.
      reason: (() => {
        const kmDays = kmRemaining == null ? null : (kmRemaining <= 0 ? -1 : daysToKm);
        if (kmDays == null) return 'date';
        if (daysRemaining == null) return 'distance';
        return kmDays <= daysRemaining ? 'distance' : 'date';
      })(),
      state: classify({ kmRemaining, daysRemaining }),
    };
  }).filter((b) => b.state !== 'ok')
    .sort((a, z) => (a.state === z.state ? 0 : a.state === 'overdue' ? -1 : 1)
      || (a.km_remaining ?? 1e9) - (z.km_remaining ?? 1e9));
}

function describe(bike) {
  const bits = [];
  if (bike.km_remaining != null) {
    bits.push(bike.km_remaining <= 0 ? `${Math.abs(bike.km_remaining)} km past its service` : `${bike.km_remaining} km to go`);
  }
  if (bike.days_remaining != null) {
    bits.push(bike.days_remaining < 0 ? `${Math.abs(bike.days_remaining)} days overdue` : `due ${bike.next_service_date}`);
  }
  if (bike.km_per_day > 0.5 && bike.projected_service_date && bike.km_remaining > 0) {
    bits.push(`about ${bike.km_per_day} km/day, so around ${bike.projected_service_date}`);
  }
  return bits.join(' · ');
}

module.exports = { bikesDueForService, describe, classify, SOON_KM, SOON_DAYS, USAGE_WINDOW_DAYS };
