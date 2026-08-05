'use strict';

/**
 * Adds foreign keys from the tracking tables (already created by
 * src/migrations/trackingPgSchema.js, which predates bikes/users existing
 * in this database) into the newly-migrated bikes/users tables.
 *
 * MUST run after the business data migration (scripts/migrate-business-data-to-postgres.js)
 * has completed and been verified — not before, and not bundled into the
 * same migration as creating the business tables. Adding a validated FK
 * constraint makes Postgres check every existing row in the referencing
 * table, so this doubles as a real orphan-data check: if any tracking row
 * points at a bike_id/user_id that doesn't actually exist, this migration
 * fails loudly here rather than corrupting silently.
 *
 * Deliberately NOT adding a FK on gps_pings.bike_id — it's a high-volume,
 * high-insert-rate table, and full-table FK validation on ADD CONSTRAINT is
 * slow/lock-heavy at scale. If wanted later: ADD CONSTRAINT ... NOT VALID
 * followed by an off-peak VALIDATE CONSTRAINT, as its own follow-up.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE tracking_devices
      ADD CONSTRAINT tracking_devices_bike_id_fkey
      FOREIGN KEY (bike_id) REFERENCES bikes(id) ON DELETE SET NULL;

    ALTER TABLE geofences
      ADD CONSTRAINT geofences_bike_id_fkey
      FOREIGN KEY (bike_id) REFERENCES bikes(id) ON DELETE CASCADE,
      ADD CONSTRAINT geofences_created_by_fkey
      FOREIGN KEY (created_by) REFERENCES users(id);

    ALTER TABLE tracking_commands
      ADD CONSTRAINT tracking_commands_created_by_fkey
      FOREIGN KEY (created_by) REFERENCES users(id);

    ALTER TABLE trips
      ADD CONSTRAINT trips_bike_id_fkey
      FOREIGN KEY (bike_id) REFERENCES bikes(id) ON DELETE CASCADE,
      ADD CONSTRAINT trips_device_id_fkey
      FOREIGN KEY (device_id) REFERENCES tracking_devices(id);

    ALTER TABLE tracking_alerts
      ADD CONSTRAINT tracking_alerts_bike_id_fkey
      FOREIGN KEY (bike_id) REFERENCES bikes(id) ON DELETE CASCADE,
      ADD CONSTRAINT tracking_alerts_device_id_fkey
      FOREIGN KEY (device_id) REFERENCES tracking_devices(id),
      ADD CONSTRAINT tracking_alerts_resolved_by_fkey
      FOREIGN KEY (resolved_by) REFERENCES users(id);

    ALTER TABLE bike_risk_profiles
      ADD CONSTRAINT bike_risk_profiles_bike_id_fkey
      FOREIGN KEY (bike_id) REFERENCES bikes(id) ON DELETE CASCADE;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE bike_risk_profiles DROP CONSTRAINT bike_risk_profiles_bike_id_fkey;
    ALTER TABLE tracking_alerts DROP CONSTRAINT tracking_alerts_bike_id_fkey, DROP CONSTRAINT tracking_alerts_device_id_fkey, DROP CONSTRAINT tracking_alerts_resolved_by_fkey;
    ALTER TABLE trips DROP CONSTRAINT trips_bike_id_fkey, DROP CONSTRAINT trips_device_id_fkey;
    ALTER TABLE tracking_commands DROP CONSTRAINT tracking_commands_created_by_fkey;
    ALTER TABLE geofences DROP CONSTRAINT geofences_bike_id_fkey, DROP CONSTRAINT geofences_created_by_fkey;
    ALTER TABLE tracking_devices DROP CONSTRAINT tracking_devices_bike_id_fkey;
  `);
};
