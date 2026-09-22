'use strict';

/**
 * Charging a fleet for the bikes it actually has.
 *
 * Paystack subscription plans charge a fixed amount, which cannot express
 * "R379 a bike" for a fleet whose bike count changes every month. So the
 * platform works the amount out itself and charges a card the fleet has
 * already authorised — Paystack's charge_authorization, the same mechanism
 * behind any usage-based bill.
 *
 * Two things this stores.
 *
 * The authorisation: a reusable token Paystack returns the first time a
 * customer pays. It is not a card number, but it can move money on their card,
 * so it is encrypted at rest exactly as a fleet's own Paystack secret is. The
 * card's last four digits and expiry are kept in the clear, because a fleet
 * needs to recognise which card is on file and be warned before it expires.
 *
 * The invoices: one row per charge attempt, carrying the rate, the bike count
 * and the bikes excluded from it. An invoice that says only "R15 160" is an
 * argument waiting to happen; one that says "40 bikes x R379, 3 paid-off bikes
 * not counted" answers itself.
 */
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE organizations
      ADD COLUMN IF NOT EXISTS subscription_tier TEXT,
      ADD COLUMN IF NOT EXISTS subscription_cycle TEXT NOT NULL DEFAULT 'monthly',
      ADD COLUMN IF NOT EXISTS subscription_status TEXT NOT NULL DEFAULT 'none',
      ADD COLUMN IF NOT EXISTS billing_authorization_encrypted TEXT,
      ADD COLUMN IF NOT EXISTS billing_card_last4 TEXT,
      ADD COLUMN IF NOT EXISTS billing_card_brand TEXT,
      ADD COLUMN IF NOT EXISTS billing_card_expiry TEXT,
      ADD COLUMN IF NOT EXISTS billing_email TEXT,
      ADD COLUMN IF NOT EXISTS next_billing_date DATE,
      ADD COLUMN IF NOT EXISTS billing_failure_count INTEGER NOT NULL DEFAULT 0;
  `);

  pgm.sql(`
    CREATE TABLE IF NOT EXISTS subscription_invoices (
      id SERIAL PRIMARY KEY,
      organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      reference TEXT NOT NULL UNIQUE,
      tier TEXT NOT NULL,
      cycle TEXT NOT NULL,
      per_bike_monthly NUMERIC(10,2) NOT NULL,
      bikes INTEGER NOT NULL,
      charged_bikes INTEGER NOT NULL,
      months_charged INTEGER NOT NULL DEFAULT 1,
      amount NUMERIC(12,2) NOT NULL,
      description TEXT,
      bike_breakdown TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      failure_reason TEXT,
      paystack_reference TEXT,
      period_start DATE,
      period_end DATE,
      charged_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  pgm.sql(`CREATE INDEX IF NOT EXISTS idx_subscription_invoices_org ON subscription_invoices (organization_id, created_at DESC);`);

  // A retry must never charge twice for the same period. One successful
  // invoice per organisation per period is enforced here rather than hoped for
  // in the scheduler.
  pgm.sql(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_subscription_invoices_period
      ON subscription_invoices (organization_id, period_start)
      WHERE status = 'paid' AND period_start IS NOT NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS subscription_invoices;`);
  pgm.sql(`
    ALTER TABLE organizations
      DROP COLUMN IF EXISTS subscription_tier,
      DROP COLUMN IF EXISTS subscription_cycle,
      DROP COLUMN IF EXISTS subscription_status,
      DROP COLUMN IF EXISTS billing_authorization_encrypted,
      DROP COLUMN IF EXISTS billing_card_last4,
      DROP COLUMN IF EXISTS billing_card_brand,
      DROP COLUMN IF EXISTS billing_card_expiry,
      DROP COLUMN IF EXISTS billing_email,
      DROP COLUMN IF EXISTS next_billing_date,
      DROP COLUMN IF EXISTS billing_failure_count;
  `);
};
