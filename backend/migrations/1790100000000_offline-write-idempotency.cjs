'use strict';

/**
 * Making a repeated write harmless.
 *
 * A technician in a workshop loses signal, so their writes are queued on the
 * phone and sent when it comes back. The danger in that is not the queue, it
 * is the retry: a request that reached the server and whose reply was lost
 * looks exactly like one that never arrived. Send it again and the job card
 * quietly grows a second oil filter.
 *
 * So every queued write carries an id the phone generates before the first
 * attempt and keeps across every retry. The unique index below is what makes
 * the promise real — not the application remembering to check, but the
 * database refusing. A second insert under the same id cannot happen, and the
 * route answers with the row that already exists.
 *
 * The indexes are partial because only queued writes carry an id. Everything
 * typed at a desk on a working connection inserts a NULL and is unaffected,
 * and NULLs do not collide.
 */
exports.up = (pgm) => {
  pgm.sql(`ALTER TABLE job_card_items ADD COLUMN IF NOT EXISTS client_request_id TEXT;`);
  pgm.sql(`ALTER TABLE job_card_photos ADD COLUMN IF NOT EXISTS client_request_id TEXT;`);
  pgm.sql(`ALTER TABLE part_photos ADD COLUMN IF NOT EXISTS client_request_id TEXT;`);

  pgm.sql(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_job_card_items_client_request
      ON job_card_items (client_request_id) WHERE client_request_id IS NOT NULL;
  `);
  pgm.sql(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_job_card_photos_client_request
      ON job_card_photos (client_request_id) WHERE client_request_id IS NOT NULL;
  `);
  pgm.sql(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_part_photos_client_request
      ON part_photos (client_request_id) WHERE client_request_id IS NOT NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP INDEX IF EXISTS idx_job_card_items_client_request;`);
  pgm.sql(`DROP INDEX IF EXISTS idx_job_card_photos_client_request;`);
  pgm.sql(`DROP INDEX IF EXISTS idx_part_photos_client_request;`);
  pgm.sql(`ALTER TABLE job_card_items DROP COLUMN IF EXISTS client_request_id;`);
  pgm.sql(`ALTER TABLE job_card_photos DROP COLUMN IF EXISTS client_request_id;`);
  pgm.sql(`ALTER TABLE part_photos DROP COLUMN IF EXISTS client_request_id;`);
};
