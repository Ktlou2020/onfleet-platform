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
  speeding: 'high', harsh_brake: 'high', geofence_exit: 'high',
  harsh_accel: 'medium', harsh_cornering: 'medium', geofence_enter: 'medium', low_battery: 'medium',
  long_trip: 'medium', battery_declining: 'medium',
  idle: 'low', device_offline: 'low', bike_dormant: 'low',
};

const ALL_ALERT_TYPES = Object.keys(ALERT_SEVERITY);

module.exports = { ALERT_SEVERITY, ALL_ALERT_TYPES };
