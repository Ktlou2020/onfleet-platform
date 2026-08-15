'use strict';

/**
 * Lets an admin clear a device from the GPS Tracking Health tab after
 * reading it. Stores the exact set of issue categories that were
 * acknowledged (not the display text, which includes fluctuating numbers
 * like a battery percentage) so the row reappears automatically if the
 * situation changes — e.g. a device offline for a battery issue that then
 * also drops its GPS fix is a materially different problem worth
 * surfacing again, not a rendering of the same dismissed row.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE tracking_devices ADD COLUMN health_ack_at TIMESTAMPTZ;
    ALTER TABLE tracking_devices ADD COLUMN health_ack_signature TEXT;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE tracking_devices DROP COLUMN IF EXISTS health_ack_at;
    ALTER TABLE tracking_devices DROP COLUMN IF EXISTS health_ack_signature;
  `);
};
