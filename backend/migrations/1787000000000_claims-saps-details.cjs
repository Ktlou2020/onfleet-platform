'use strict';

/**
 * SAPS case number and police station, entered manually by the admin once
 * available — a theft claim is normally filed before the police report is
 * fully processed, so this is filled in after the fact rather than at
 * claim-creation time.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE insurance_claims ADD COLUMN saps_case_number TEXT;
    ALTER TABLE insurance_claims ADD COLUMN saps_police_station TEXT;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE insurance_claims DROP COLUMN IF EXISTS saps_case_number;
    ALTER TABLE insurance_claims DROP COLUMN IF EXISTS saps_police_station;
  `);
};
