'use strict';

/**
 * One row per device per day: a daily snapshot of the tracker's internal
 * (backup-cell) battery percentage. Lets a decline over several days be
 * detected — a single reading can't tell a healthy cell from one about to
 * die, but a steady multi-day drop is a strong early-warning signal, and
 * this is the one power source that still matters after grid/vehicle power
 * is cut (e.g. a theft attempt), so catching it failing ahead of time is
 * worth a dedicated small table rather than parsing gps_pings.io_data
 * historically on every check.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE device_battery_history (
      device_id    INTEGER NOT NULL REFERENCES tracking_devices(id) ON DELETE CASCADE,
      battery_pct  INTEGER NOT NULL,
      recorded_at  DATE NOT NULL,
      PRIMARY KEY (device_id, recorded_at)
    );
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS device_battery_history;`);
};
