'use strict';

/**
 * Paystack retries webhook delivery on slow/failed responses, and the rider
 * portal's verify-on-redirect call can race the webhook for the same
 * payment. Nothing stopped two concurrent credits for the same reference
 * from both landing — this closes that with a real constraint instead of
 * the app-level check-then-act that raced under it. Scoped to type='credit'
 * only, so a reversal ('adjustment') can still reference the same
 * paystack_reference as the credit it's unwinding.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE UNIQUE INDEX idx_fleet_wallet_txns_credit_reference
    ON fleet_wallet_transactions (paystack_reference)
    WHERE type = 'credit' AND paystack_reference IS NOT NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP INDEX IF EXISTS idx_fleet_wallet_txns_credit_reference;`);
};
