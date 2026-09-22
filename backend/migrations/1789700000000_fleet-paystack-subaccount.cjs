'use strict';

/**
 * A fleet can be paid through a Paystack subaccount instead of connecting a
 * whole Paystack account of its own.
 *
 * The difference matters for onboarding. Connecting an account means the fleet
 * must first open and get a Paystack merchant account approved — FICA
 * documents, bank verification, the wait. A subaccount needs only their bank
 * details: the platform stays the merchant of record, and Paystack settles the
 * fleet's share straight to their bank. Money still never sits with us.
 *
 * Only the subaccount CODE is stored. The platform deliberately does not
 * create subaccounts or set their split, because Paystack's own documentation
 * disagrees with itself about which way `percentage_charge` runs — the GitHub
 * source says the percentage goes to the main account, docs-v2 says it goes to
 * the subaccount. On a R850 payment that is the difference between the fleet
 * receiving R680 and receiving R170. So the fleet (or we, on their behalf)
 * creates the subaccount in Paystack's own dashboard, where the wording is in
 * front of whoever sets the number, and the platform only references the code.
 *
 * Three ways a payment can now be routed, in this order:
 *   1. the fleet's own Paystack keys, if connected — we never touch the money
 *   2. the platform's keys with the fleet's subaccount — Paystack splits it
 *   3. the platform's keys alone — OnFleet Africa's own operation
 */
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE organizations
      ADD COLUMN IF NOT EXISTS paystack_subaccount_code TEXT,
      ADD COLUMN IF NOT EXISTS paystack_subaccount_name TEXT,
      ADD COLUMN IF NOT EXISTS paystack_subaccount_bank TEXT,
      ADD COLUMN IF NOT EXISTS paystack_subaccount_linked_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS paystack_subaccount_linked_by INTEGER;
  `);

  // Which subaccount a payment was routed through, recorded on the payment.
  // A fleet may relink a different one later, and a reconciliation months
  // afterwards should not have to guess which was in force at the time.
  pgm.sql(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS paystack_subaccount_code TEXT;`);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE organizations
      DROP COLUMN IF EXISTS paystack_subaccount_code,
      DROP COLUMN IF EXISTS paystack_subaccount_name,
      DROP COLUMN IF EXISTS paystack_subaccount_bank,
      DROP COLUMN IF EXISTS paystack_subaccount_linked_at,
      DROP COLUMN IF EXISTS paystack_subaccount_linked_by;
  `);
  pgm.sql(`ALTER TABLE payments DROP COLUMN IF EXISTS paystack_subaccount_code;`);
};
