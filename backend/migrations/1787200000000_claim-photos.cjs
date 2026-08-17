'use strict';

/**
 * Evidence photos attached to an insurance claim — crime scene, bike
 * condition, police report scan. Same shape as job_card_photos, stored via
 * the same hybridStorage abstraction (local disk or R2, whichever is
 * configured).
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE claim_photos (
      id SERIAL PRIMARY KEY,
      claim_id INTEGER NOT NULL REFERENCES insurance_claims(id) ON DELETE CASCADE,
      file_path TEXT NOT NULL,
      original_name TEXT,
      caption TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX idx_claim_photos_claim ON claim_photos(claim_id);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS claim_photos;`);
};
