'use strict';

/**
 * Marks when a critical tracking alert (panic, tamper, theft, etc.) was
 * escalated — re-notified because nobody acknowledged it within the alert
 * escalation window. Set exactly once per alert, so an ongoing incident
 * gets a second nudge but not a repeat spam of nudges.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`ALTER TABLE tracking_alerts ADD COLUMN escalated_at TIMESTAMPTZ;`);
};

exports.down = (pgm) => {
  pgm.sql(`ALTER TABLE tracking_alerts DROP COLUMN IF EXISTS escalated_at;`);
};
