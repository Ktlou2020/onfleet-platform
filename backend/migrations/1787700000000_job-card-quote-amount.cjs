'use strict';

/**
 * Records the figure a quote was approved at.
 *
 * job_cards already carried quote_approved_at and quote_approved_by, but no
 * amount — so there was nothing for an approval to be an approval *of*. In
 * practice the feature was never used once: quote_approved_at was null on all
 * 97 job cards raised to date.
 *
 * The amount is snapshotted at approval rather than read back from
 * job_card_items, because the whole point of approving a quote is to fix what
 * was agreed. Line items keep moving afterwards — parts get added, a job grows
 * — and an approval that silently tracked those changes would agree to
 * whatever the job later became.
 */

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE job_cards
      ADD COLUMN IF NOT EXISTS quote_amount NUMERIC(12,2);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`ALTER TABLE job_cards DROP COLUMN IF EXISTS quote_amount;`);
};
