'use strict';

/**
 * Closing an alert required a typed comment, so nobody did it: 0 of the 1,169
 * alerts raised in the last 30 days were closed. Recording *why* an alert was
 * closed, from a short list, makes closing a single tap and finally lets the
 * fleet measure how many alerts are real and how many bikes were recovered.
 *
 * Acknowledging is also unattributed today, and acknowledging is what stops a
 * critical alert escalating — so the one action that silences a theft alert
 * leaves no record of who took it. acknowledged_by fixes that.
 */
exports.up = (pgm) => {
  pgm.sql(`ALTER TABLE tracking_alerts ADD COLUMN IF NOT EXISTS resolution_outcome TEXT;`);
  pgm.sql(`ALTER TABLE tracking_alerts ADD COLUMN IF NOT EXISTS acknowledged_by INTEGER REFERENCES users(id);`);
  pgm.sql(`CREATE INDEX IF NOT EXISTS idx_tracking_alerts_outcome ON tracking_alerts(resolution_outcome) WHERE resolution_outcome IS NOT NULL;`);
};

exports.down = (pgm) => {
  pgm.sql(`DROP INDEX IF EXISTS idx_tracking_alerts_outcome;`);
  pgm.sql(`ALTER TABLE tracking_alerts DROP COLUMN IF EXISTS resolution_outcome;`);
  pgm.sql(`ALTER TABLE tracking_alerts DROP COLUMN IF EXISTS acknowledged_by;`);
};
