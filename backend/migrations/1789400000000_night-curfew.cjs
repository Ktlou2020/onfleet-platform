'use strict';

/**
 * The overnight curfew: a bike moving between 00:00 and 04:00 SAST has its
 * engine cut automatically, because at that hour it should be parked.
 *
 * Two escape hatches ship with it, and both matter more than the feature:
 *
 * - `bikes.night_curfew_exempt` — a rider who legitimately works late must be
 *   exemptable, because stranding someone at 01:00 in Johannesburg is its own
 *   danger, not merely an inconvenience.
 * - `app_settings.night_curfew_enabled` — the whole thing off, now, without a
 *   deploy. Anything that immobilises vehicles on its own needs a switch that
 *   can be reached at the hour it goes wrong.
 *
 * Neither the column nor the setting decides who is covered on its own: the
 * service also refuses to cut a bike that has been sold, paid off or retired,
 * since that bike is not OnFleet's to immobilise.
 */
exports.up = (pgm) => {
  pgm.sql(`ALTER TABLE bikes ADD COLUMN IF NOT EXISTS night_curfew_exempt BOOLEAN NOT NULL DEFAULT FALSE;`);
  pgm.sql(`
    INSERT INTO app_settings (setting_key, setting_value, updated_at)
    VALUES ('night_curfew_enabled', 'true', NOW())
    ON CONFLICT (setting_key) DO NOTHING;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`ALTER TABLE bikes DROP COLUMN IF EXISTS night_curfew_exempt;`);
  pgm.sql(`DELETE FROM app_settings WHERE setting_key = 'night_curfew_enabled';`);
};
