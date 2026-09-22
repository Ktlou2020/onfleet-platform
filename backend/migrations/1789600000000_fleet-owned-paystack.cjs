'use strict';

/**
 * Each fleet collects rider payments into its own Paystack account.
 *
 * Until now one Paystack account — the platform's — took every rider payment,
 * kept 3.5% + R1, credited the fleet's wallet with the rest and paid it out on
 * request. That works when the platform and the fleet are the same business.
 * Sold as software to other operators it means holding other people's money,
 * which is a different business with a different regulator.
 *
 * So a fleet connects its own account and the money never touches ours: the
 * rider pays the fleet directly, and we charge only the subscription.
 *
 * Three things this stores per organisation:
 *
 *  - `paystack_public_key` — safe in the open; it is meant to reach browsers.
 *  - `paystack_secret_key_encrypted` — AES-256-GCM, never in plain text. A
 *    secret key can move money and issue refunds on that fleet's account, so
 *    a database dump must not be enough to use it.
 *  - `paystack_webhook_token` — an unguessable string in that fleet's webhook
 *    URL. Paystack signs each webhook with the sending account's secret, and
 *    with many accounts we cannot know which secret to check until we know
 *    which fleet sent it. The token in the path tells us, so exactly one
 *    signature is ever computed and a forged webhook cannot be checked
 *    against the wrong account's key.
 *
 * A fleet with none of these set falls back to the platform's own environment
 * keys, which is what OnFleet Africa's own operation keeps doing. Nothing
 * about the existing production behaviour changes.
 */
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE organizations
      ADD COLUMN IF NOT EXISTS paystack_public_key TEXT,
      ADD COLUMN IF NOT EXISTS paystack_secret_key_encrypted TEXT,
      ADD COLUMN IF NOT EXISTS paystack_webhook_token TEXT,
      ADD COLUMN IF NOT EXISTS paystack_connected_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS paystack_connected_by INTEGER;
  `);

  // The token is the only thing identifying which fleet a webhook is for, so
  // two fleets must never share one.
  pgm.sql(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_organizations_paystack_webhook_token
      ON organizations (paystack_webhook_token)
      WHERE paystack_webhook_token IS NOT NULL;
  `);

  // Which account took a payment, recorded on the payment itself. Without it
  // a refund or a reconciliation months later has to guess, and by then the
  // fleet may have reconnected a different account.
  pgm.sql(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS collected_by_organization_id INTEGER;`);
};

exports.down = (pgm) => {
  pgm.sql(`DROP INDEX IF EXISTS idx_organizations_paystack_webhook_token;`);
  pgm.sql(`
    ALTER TABLE organizations
      DROP COLUMN IF EXISTS paystack_public_key,
      DROP COLUMN IF EXISTS paystack_secret_key_encrypted,
      DROP COLUMN IF EXISTS paystack_webhook_token,
      DROP COLUMN IF EXISTS paystack_connected_at,
      DROP COLUMN IF EXISTS paystack_connected_by;
  `);
  pgm.sql(`ALTER TABLE payments DROP COLUMN IF EXISTS collected_by_organization_id;`);
};
