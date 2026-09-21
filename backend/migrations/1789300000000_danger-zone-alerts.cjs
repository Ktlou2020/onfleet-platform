'use strict';

/**
 * No-go zones get their own alert type.
 *
 * Until now a bike entering a no-go zone raised `geofence_enter` — the same
 * alert as arriving at a depot, at medium severity — with the zone's type
 * buried in the payload. The one alert the zone exists for was the one it
 * could not raise for itself: it could not be switched on separately, routed
 * to its own recipients, escalated, or picked out of the control room's list.
 *
 * From here, entering a zone marked `danger` raises `danger_zone_enter`
 * (critical, escalates) and leaving it raises `danger_zone_exit` (low) — so
 * riding back out of a no-go zone stops reading as a high-severity "Left
 * geofence", which is good news wearing bad news' clothes.
 *
 * The alerts already in history are reclassified to match, so a search for
 * no-go entries finds the ones that happened before today. They are matched on
 * the zone_type the payload already carries; the match is on the raw text
 * rather than a ::jsonb cast so that a single malformed payload cannot fail
 * this migration and, with it, stop the service from starting.
 */

const ENTERED = `alert_type = 'geofence_enter' AND payload LIKE '%"zone_type":"danger"%'`;
const LEFT = `alert_type = 'geofence_exit' AND payload LIKE '%"zone_type":"danger"%'`;

exports.up = (pgm) => {
  pgm.sql(`UPDATE tracking_alerts SET alert_type = 'danger_zone_enter', severity = 'critical' WHERE ${ENTERED};`);
  pgm.sql(`UPDATE tracking_alerts SET alert_type = 'danger_zone_exit', severity = 'low' WHERE ${LEFT};`);
};

// No alert_settings rows are written: with none, both types read as on, which
// is the point of asking for the alert. Deliberately not inherited from the
// ordinary geofence types, since those may well be switched off for noise and
// that would silently ship the new alert switched off too.

exports.down = (pgm) => {
  pgm.sql(`UPDATE tracking_alerts SET alert_type = 'geofence_enter', severity = 'medium' WHERE alert_type = 'danger_zone_enter';`);
  pgm.sql(`UPDATE tracking_alerts SET alert_type = 'geofence_exit', severity = 'high' WHERE alert_type = 'danger_zone_exit';`);
  pgm.sql(`DELETE FROM alert_settings WHERE alert_type IN ('danger_zone_enter', 'danger_zone_exit');`);
};
