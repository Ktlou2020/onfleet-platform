'use strict';

/**
 * How far each person has got through the workshop guide.
 *
 * Kept per user on the server rather than in the browser so a workshop manager
 * can see who has actually been through it — a new technician's training is a
 * fact about the shop, not a cookie on one phone.
 */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS guide_progress (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      guide TEXT NOT NULL,
      step_key TEXT NOT NULL,
      completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, guide, step_key)
    );
  `);
  pgm.sql(`CREATE INDEX IF NOT EXISTS idx_guide_progress_guide ON guide_progress(guide, user_id);`);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS guide_progress;`);
};
