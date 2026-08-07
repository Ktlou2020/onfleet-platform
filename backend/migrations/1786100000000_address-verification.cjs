'use strict';

/**
 * Address verification: compares where a rider's bike is actually parked
 * overnight (00:00-04:00 SAST, clustered from gps_pings) against the
 * geocoded coordinates of the address they gave us — never the other way
 * around. We only ever store a match/mismatch/unverified status; the
 * geocoded address coordinates are cached here for comparison only and are
 * never exposed via the API (no new address is ever surfaced to staff).
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS address_lat DOUBLE PRECISION;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS address_lng DOUBLE PRECISION;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS address_geocode_hash TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS address_geocoded_at TIMESTAMPTZ;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS address_match_status TEXT NOT NULL DEFAULT 'unverified'
      CHECK (address_match_status IN ('unverified', 'match', 'mismatch'));
    ALTER TABLE users ADD COLUMN IF NOT EXISTS address_match_checked_at TIMESTAMPTZ;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE users DROP COLUMN IF EXISTS address_lat;
    ALTER TABLE users DROP COLUMN IF EXISTS address_lng;
    ALTER TABLE users DROP COLUMN IF EXISTS address_geocode_hash;
    ALTER TABLE users DROP COLUMN IF EXISTS address_geocoded_at;
    ALTER TABLE users DROP COLUMN IF EXISTS address_match_status;
    ALTER TABLE users DROP COLUMN IF EXISTS address_match_checked_at;
  `);
};
