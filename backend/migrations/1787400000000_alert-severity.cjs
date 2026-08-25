'use strict';

/**
 * Persists severity on the alert row instead of leaving it as a
 * frontend-only JS constant (frontend/src/lib/alertMeta.js). Needed so
 * severity can be filtered/sorted server-side and referenced by future
 * notification channels without re-deriving it from alert_type client-side.
 * Backfill matches backend/src/constants/alertTypes.js's ALERT_SEVERITY map.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`ALTER TABLE tracking_alerts ADD COLUMN IF NOT EXISTS severity TEXT;`);

  pgm.sql(`
    UPDATE tracking_alerts SET severity = CASE alert_type
      WHEN 'panic' THEN 'critical'
      WHEN 'tamper' THEN 'critical'
      WHEN 'power_disconnect' THEN 'critical'
      WHEN 'movement' THEN 'critical'
      WHEN 'theft_risk' THEN 'critical'
      WHEN 'night_movement' THEN 'critical'
      WHEN 'towing' THEN 'critical'
      WHEN 'engine_cut_auto' THEN 'critical'
      WHEN 'speeding' THEN 'high'
      WHEN 'harsh_brake' THEN 'high'
      WHEN 'geofence_exit' THEN 'high'
      WHEN 'harsh_accel' THEN 'medium'
      WHEN 'harsh_cornering' THEN 'medium'
      WHEN 'geofence_enter' THEN 'medium'
      WHEN 'low_battery' THEN 'medium'
      WHEN 'long_trip' THEN 'medium'
      WHEN 'battery_declining' THEN 'medium'
      WHEN 'idle' THEN 'low'
      WHEN 'device_offline' THEN 'low'
      WHEN 'bike_dormant' THEN 'low'
      ELSE 'medium'
    END
    WHERE severity IS NULL;
  `);

  pgm.sql(`ALTER TABLE tracking_alerts ALTER COLUMN severity SET DEFAULT 'medium';`);
  pgm.sql(`ALTER TABLE tracking_alerts ALTER COLUMN severity SET NOT NULL;`);
  pgm.sql(`
    ALTER TABLE tracking_alerts ADD CONSTRAINT tracking_alerts_severity_check
      CHECK (severity IN ('critical','high','medium','low'));
  `);
};

exports.down = (pgm) => {
  pgm.sql(`ALTER TABLE tracking_alerts DROP CONSTRAINT IF EXISTS tracking_alerts_severity_check;`);
  pgm.sql(`ALTER TABLE tracking_alerts DROP COLUMN IF EXISTS severity;`);
};
