'use strict';

/**
 * A technician's notes, actually stored.
 *
 * The note endpoint wrote an audit-log line and nothing else. It never touched
 * job_cards.technician_notes — that column is only writable through the
 * generic edit route — so a technician typing what they found and pressing
 * Save got an entry in a log nobody reads, and the job card came back empty.
 * The page also blanked, because the route answered {ok:true} and the browser
 * expected the card.
 *
 * A row per note rather than appending to the text column, for three reasons:
 * it keeps who wrote what and when, several people can add notes to one job
 * without overwriting each other, and a replayed note is deduplicated by a
 * unique index instead of by trying to work out whether the text is already
 * in the middle of a paragraph.
 */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS job_card_notes (
      id                SERIAL PRIMARY KEY,
      job_card_id       INTEGER NOT NULL REFERENCES job_cards(id) ON DELETE CASCADE,
      note              TEXT NOT NULL,
      created_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
      client_request_id TEXT,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  pgm.sql(`CREATE INDEX IF NOT EXISTS idx_job_card_notes_card ON job_card_notes (job_card_id, created_at);`);
  pgm.sql(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_job_card_notes_client_request
      ON job_card_notes (client_request_id) WHERE client_request_id IS NOT NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS job_card_notes;`);
};
