'use strict';

/**
 * Insurance claims tracking — not an insurer API integration (none exists),
 * but a structured record of the claims process: what happened, which
 * tracking_alerts back up the story (theft/towing/night-movement alerts on
 * that bike), and how it was resolved. Turns the alert data the platform
 * already collects into something usable when actually talking to an insurer.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE insurance_claims (
      id SERIAL PRIMARY KEY,
      bike_id INTEGER NOT NULL REFERENCES bikes(id),
      agreement_id INTEGER REFERENCES agreements(id),
      claim_type TEXT NOT NULL CHECK (claim_type IN ('theft', 'damage', 'accident', 'fire', 'other')),
      status TEXT NOT NULL DEFAULT 'filed' CHECK (status IN ('filed', 'investigating', 'approved', 'rejected', 'paid', 'closed')),
      description TEXT NOT NULL,
      incident_date DATE,
      linked_alert_ids INTEGER[] NOT NULL DEFAULT '{}',
      payout_amount NUMERIC(12,2),
      filed_by INTEGER NOT NULL REFERENCES users(id),
      filed_at TIMESTAMPTZ DEFAULT NOW(),
      resolved_at TIMESTAMPTZ,
      notes TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX idx_insurance_claims_bike ON insurance_claims(bike_id);
    CREATE INDEX idx_insurance_claims_status ON insurance_claims(status);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS insurance_claims;`);
};
