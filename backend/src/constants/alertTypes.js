'use strict';

/**
 * Single source of truth for which GPS/tracking alert types exist and how
 * severe each one is. Every alert-insert site (tripService, geofenceService,
 * riskService, batteryHealthService) and the settings endpoint in
 * routes/tracking.js import from here instead of keeping their own copies —
 * engine_cut_auto used to be missing from the settings list purely because
 * routes/tracking.js's own local array had drifted from what actually gets
 * generated.
 */
const ALERT_SEVERITY = {
  panic: 'critical', tamper: 'critical', power_disconnect: 'critical', movement: 'critical',
  theft_risk: 'critical', night_movement: 'critical', towing: 'critical', engine_cut_auto: 'critical',
  danger_zone_enter: 'critical',
  speeding: 'high', harsh_brake: 'high', geofence_exit: 'high',
  harsh_accel: 'medium', harsh_cornering: 'medium', geofence_enter: 'medium', low_battery: 'medium',
  long_trip: 'medium', battery_declining: 'medium',
  idle: 'low', device_offline: 'low', bike_dormant: 'low', danger_zone_exit: 'low',
};

// A no-go zone is not a geofence that happens to be red. Entering one is the
// alert the zone exists for, so it is its own type rather than a
// geofence_enter with zone_type buried in the payload — it can be switched
// on, routed and escalated separately from "the bike reached the depot", and
// it reads as itself in the control room.
const DANGER_ZONE_ALERTS = { enter: 'danger_zone_enter', exit: 'danger_zone_exit' };
const STANDARD_ZONE_ALERTS = { enter: 'geofence_enter', exit: 'geofence_exit' };

// Which alert a zone transition raises, given the zone's type.
function zoneAlertType(zoneType, entering) {
  const set = zoneType === 'danger' ? DANGER_ZONE_ALERTS : STANDARD_ZONE_ALERTS;
  return entering ? set.enter : set.exit;
}

const ALL_ALERT_TYPES = Object.keys(ALERT_SEVERITY);

module.exports = { ALERT_SEVERITY, ALL_ALERT_TYPES, zoneAlertType };
