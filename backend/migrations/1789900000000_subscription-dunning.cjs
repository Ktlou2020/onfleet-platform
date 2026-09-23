'use strict';

/**
 * What happens when a fleet's card is declined.
 *
 * Until now, nothing did. A failed charge incremented a counter and the fleet
 * was not retried until the 1st of the following month, was never told, and
 * never lost access — because access is gated on `organizations.status` while
 * billing only ever wrote `subscription_status`. The two were never connected,
 * in either direction: a fleet that stopped paying kept the platform, and a
 * fleet that paid still got locked out the day its trial expired.
 *
 * These two dates are what connects them.
 *
 * `billing_retry_at` is the next day we may touch the card again. Without it a
 * daily billing run would retry a declined card every morning, which is how an
 * account ends up flagged by its bank.
 *
 * `billing_grace_until` is the day access stops if the money has still not
 * arrived. It is written when the first charge fails, so the deadline a fleet
 * is told about in the email is the same date the scheduler acts on, rather
 * than one recalculated later from a different rule.
 */
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE organizations
      ADD COLUMN IF NOT EXISTS billing_retry_at DATE,
      ADD COLUMN IF NOT EXISTS billing_grace_until DATE,
      ADD COLUMN IF NOT EXISTS billing_last_notice TEXT;
  `);

  // The daily run asks one question — who needs charging today — and this is
  // what keeps it from being a full table scan once there are real numbers of
  // fleets on the platform.
  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_organizations_billing_due
      ON organizations (next_billing_date, billing_retry_at)
      WHERE subscription_tier IS NOT NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP INDEX IF EXISTS idx_organizations_billing_due;`);
  pgm.sql(`
    ALTER TABLE organizations
      DROP COLUMN IF EXISTS billing_retry_at,
      DROP COLUMN IF EXISTS billing_grace_until,
      DROP COLUMN IF EXISTS billing_last_notice;
  `);
};
