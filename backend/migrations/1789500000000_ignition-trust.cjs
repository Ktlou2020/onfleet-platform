'use strict';

/**
 * Whether a tracker's ignition reading can be believed.
 *
 * The towing alert says "the bike covered real road distance with the ignition
 * off", which can only mean it is on the back of something. That reasoning
 * collapses when the ignition line was never wired: the tracker reports
 * element 239 as a well-formed 0 for ever, so every ordinary afternoon ride
 * reads as a tow — and the same dead 0 makes every ride read as unauthorised
 * movement, and stops any trip being recorded at all, because a trip only
 * starts once the ignition is on.
 *
 * A tracker now earns trust by having reported the ignition ON at least once,
 * and this column records when. Until then its ignition reading is treated as
 * absent rather than as "off".
 *
 * The column is only added here. Working out which existing trackers have ever
 * reported ignition on means reading the ping table, and a migration that runs
 * long or fails takes the whole service down with it — so that runs as a
 * background job at boot instead (services/ignitionTrust.js).
 */
exports.up = (pgm) => {
  pgm.sql(`ALTER TABLE tracking_devices ADD COLUMN IF NOT EXISTS ignition_trusted_at TIMESTAMPTZ;`);
};

exports.down = (pgm) => {
  pgm.sql(`ALTER TABLE tracking_devices DROP COLUMN IF EXISTS ignition_trusted_at;`);
};
