'use strict';

// Whose workshop is it.
//
// workshop_locations has been a single global list since bookings shipped.
// On OnFleet that is right: OnFleet owns the workshops and services every
// fleet's motorcycles at them, so one list shared by all is the truth.
//
// On Pillion it is wrong, and wrong in the way that matters for a product
// sold to companies that compete with each other. Every fleet owner saw every
// other fleet's workshops. They shared slots, so one fleet booking 09:30 took
// it from another. And because which slots are gone is visible, a fleet could
// read off how busy a competitor's workshop was. None of that is a leak of
// records, which is why the tenant-isolation work did not catch it — it is a
// leak through a shared resource.
//
// A nullable column rather than a required one, because both meanings are
// real and the difference between them is the whole point:
//
//   NULL            a workshop the platform offers to everybody on it. That
//                   is OnFix and Bikerhouse on OnFleet, and it is what a
//                   Pillion partner workshop would be.
//
//   an org's id     a workshop that belongs to one fleet. Only they see it,
//                   only they book it, and its diary is theirs.
//
// Existing rows stay NULL, so OnFleet's two workshops keep behaving exactly
// as they do today and nothing already booked moves.
//
// ON DELETE CASCADE is deliberate and narrow: if an organisation is deleted,
// its private workshops go with it. A shared workshop has no organisation to
// lose, so it is untouched by any such delete.

exports.up = (pgm) => {
  pgm.addColumns('workshop_locations', {
    organization_id: {
      type: 'integer',
      references: 'organizations',
      onDelete: 'CASCADE',
      comment: 'The fleet this workshop belongs to. NULL means the platform offers it to everybody.',
    },
  });

  // Every visibility check is "mine or everybody's", so the index carries
  // both the owner and whether it is switched on.
  pgm.createIndex('workshop_locations', ['organization_id', 'active']);
};

exports.down = (pgm) => {
  pgm.dropIndex('workshop_locations', ['organization_id', 'active']);
  pgm.dropColumns('workshop_locations', ['organization_id']);
};
