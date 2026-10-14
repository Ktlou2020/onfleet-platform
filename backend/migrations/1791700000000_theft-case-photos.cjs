'use strict';

// Photographs on a theft case.
//
// The platform could already say a bike was recovered. It could not show it.
// Closing a case as 'recovered' recorded a status, a date and a sentence typed
// by whoever took the call — and a year later, an insurer asking what state
// the bike came back in had only that sentence to go on. The same gap the
// theft case itself was built to close ("85 bikes stolen, but how many
// recovered?") reappeared one level down: recovered, but recovered how, and
// in what condition?
//
// `stage` is what makes a gallery worth having rather than a pile. A
// photograph taken while the case was open is a sighting: a bike spotted in a
// yard, a cut lock, a plate on a trailer. One attached as the case was closed
// is the outcome itself, and that is the set an insurer, a fleet owner or a
// magistrate actually asks for. Keeping both in one table means the whole
// story sits in one place; telling them apart by stage means the evidence
// that matters is not buried in the middle of it.
//
// Note on where the files live: NOT under the public upload tree. See
// services/theftCasePhotos.js for why that was a deliberate departure.

exports.up = (pgm) => {
  pgm.createTable('theft_case_photos', {
    id: 'id',
    case_id: {
      type: 'integer',
      notNull: true,
      references: 'theft_cases',
      onDelete: 'CASCADE',
    },
    // The generated filename, not an absolute path: the directory it sits in
    // is configuration (a Railway volume in production, the repo in dev) and
    // baking it into a row would break every photograph the first time that
    // configuration changed.
    file_path: { type: 'text', notNull: true },
    original_name: { type: 'text' },
    caption: { type: 'text' },
    stage: {
      type: 'text',
      notNull: true,
      default: 'sighting',
      comment: "'sighting' while the case was open, 'outcome' when it was closed",
    },
    created_by: { type: 'integer', references: 'users' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
  });

  pgm.addConstraint('theft_case_photos', 'theft_case_photos_stage_check',
    "CHECK (stage IN ('sighting', 'outcome'))");

  // Every read is "the photographs on this case, oldest first", because the
  // gallery is a story in order.
  pgm.createIndex('theft_case_photos', ['case_id', 'created_at']);
};

exports.down = (pgm) => {
  pgm.dropTable('theft_case_photos');
};
