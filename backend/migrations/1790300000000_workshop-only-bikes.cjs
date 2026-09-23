'use strict';

/**
 * Bikes that belong to the workshop, not to the fleet.
 *
 * A technician servicing a walk-in registers it so the bike has an identity
 * and its service history accumulates across visits. That bike is not an
 * OnFleet asset: nobody rents it, it carries no agreement, and it must never
 * appear in the fleet — not in the bike list, not in the counts, not in the
 * public API.
 *
 * Marked explicitly rather than inferred. It could almost be deduced from
 * status='not_available' with a null organisation, but both of those are
 * legitimate states for a real fleet bike, and a rule that works by accident
 * stops working the first time somebody changes a status.
 */
exports.up = (pgm) => {
  pgm.sql(`ALTER TABLE bikes ADD COLUMN IF NOT EXISTS workshop_only BOOLEAN NOT NULL DEFAULT FALSE;`);
  // The fleet-facing queries all filter it out, so the index is the one that
  // matters: it keeps "everything except workshop bikes" cheap.
  pgm.sql(`CREATE INDEX IF NOT EXISTS idx_bikes_workshop_only ON bikes (workshop_only) WHERE workshop_only = TRUE;`);
};

exports.down = (pgm) => {
  pgm.sql(`DROP INDEX IF EXISTS idx_bikes_workshop_only;`);
  pgm.sql(`ALTER TABLE bikes DROP COLUMN IF EXISTS workshop_only;`);
};
