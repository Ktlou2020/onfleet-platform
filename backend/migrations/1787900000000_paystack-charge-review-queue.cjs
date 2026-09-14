'use strict';

/**
 * A review queue for Paystack charges the platform could not credit on its own.
 *
 * Debit orders for platform riders never reached the payments table. The
 * webhook's recurring-charge branch only records a charge it can tie to a
 * fleet organisation, and platform riders have none, so every one of their
 * subscription charges was dropped without a trace. Staff filled the gap by
 * typing each charge in as a manual payment — 1,026 of them since June, none
 * carrying the Paystack reference — and 38 charges (R31,723.91) slipped
 * through entirely.
 *
 * Crediting automatically would double-credit every rider whose charge is
 * also typed in by hand, so charges land here unconfirmed instead. Confirming
 * one creates the payment with the Paystack reference attached; dismissing one
 * records why (already entered by hand, refunded, not ours).
 */

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS paystack_charges (
      id                      SERIAL PRIMARY KEY,
      reference               TEXT NOT NULL UNIQUE,
      paystack_transaction_id BIGINT,
      customer_email          TEXT,
      customer_code           TEXT,
      subscription_code       TEXT,
      plan_code               TEXT,
      amount                  NUMERIC(12,2) NOT NULL,
      channel                 TEXT,
      paid_at                 TIMESTAMPTZ NOT NULL,
      rider_user_id           INTEGER REFERENCES users(id) ON DELETE SET NULL,
      agreement_id            INTEGER REFERENCES agreements(id) ON DELETE SET NULL,
      source                  TEXT NOT NULL DEFAULT 'webhook' CHECK (source IN ('webhook','backfill')),
      status                  TEXT NOT NULL DEFAULT 'unconfirmed' CHECK (status IN ('unconfirmed','confirmed','dismissed')),
      payment_id              INTEGER REFERENCES payments(id) ON DELETE SET NULL,
      resolved_by             INTEGER REFERENCES users(id) ON DELETE SET NULL,
      resolved_at             TIMESTAMPTZ,
      resolution_note         TEXT,
      raw                     JSONB,
      created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_paystack_charges_status ON paystack_charges (status, paid_at DESC);
    CREATE INDEX IF NOT EXISTS idx_paystack_charges_rider  ON paystack_charges (rider_user_id, paid_at DESC);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS paystack_charges;`);
};
