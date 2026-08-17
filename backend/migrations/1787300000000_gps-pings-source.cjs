'use strict';

/**
 * Distinguishes real telemetry from our own trackers vs. historical GPS
 * data backfilled from another platform's export (e.g. to fill an
 * investigation gap where our tracker never reported). Investigators and
 * the AI case-summary tool need to know which is which — imported data
 * carries different trust/verification implications than live telemetry.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`ALTER TABLE gps_pings ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'device';`);
};

exports.down = (pgm) => {
  pgm.sql(`ALTER TABLE gps_pings DROP COLUMN IF EXISTS source;`);
};
