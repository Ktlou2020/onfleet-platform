'use strict';

/**
 * Five trackers registered on 19 September have never sent a single byte, and
 * nobody noticed until a report was written that looked. A tracker is only
 * installed when it has proved it works: connected, fixed on satellites,
 * wired to ignition and power, and reporting. This records that proof, who
 * signed it off, and when — so a bad install is caught while the installer is
 * still standing next to the bike, not weeks later when a bike goes missing.
 */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS device_commissioning (
      device_id INTEGER PRIMARY KEY REFERENCES tracking_devices(id) ON DELETE CASCADE,
      commissioned_at TIMESTAMPTZ,
      commissioned_by INTEGER REFERENCES users(id),
      checks JSONB,
      override_reason TEXT,
      notes TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS device_commissioning;`);
};
