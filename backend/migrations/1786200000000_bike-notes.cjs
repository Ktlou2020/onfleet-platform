'use strict';

/**
 * Free-text operational notes control room/admin staff attach to a bike —
 * e.g. "spoke to rider, bike parked at depot for the night". Append-only:
 * no edit/delete, just a running log alongside the bike's alert history.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE bike_notes (
      id SERIAL PRIMARY KEY,
      bike_id INTEGER NOT NULL REFERENCES bikes(id) ON DELETE CASCADE,
      author_id INTEGER REFERENCES users(id),
      note TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX idx_bike_notes_bike ON bike_notes(bike_id, created_at DESC);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS bike_notes;`);
};
