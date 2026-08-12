'use strict';

/**
 * Lets a notification point at the specific record it's about (e.g. a job
 * card), so the notification bell can deep-link there instead of just the
 * section's list page. Nullable/untyped on purpose — not every notification
 * type has (or needs) a linked entity, and different entity_type values
 * point at different tables, so no FK is declared.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE notifications ADD COLUMN entity_type TEXT;
    ALTER TABLE notifications ADD COLUMN entity_id INTEGER;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE notifications DROP COLUMN IF EXISTS entity_type;
    ALTER TABLE notifications DROP COLUMN IF EXISTS entity_id;
  `);
};
