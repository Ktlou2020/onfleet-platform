'use strict';

// Telling the technician what the control room already knows.
//
// A bike throwing towing alerts because its ignition wire is on the wrong
// terminal is a fact the control room learns from the map and the technician
// learns from nobody. bike_notes already existed, but it was written and read
// only from the tracking side — a technician opening a job card for that bike
// saw none of it, replaced a brake pad, and sent it back still miswired.
//
// Two columns, and the second matters as much as the first:
//
//   for_workshop  — not every note belongs in a workshop. "Rider says he will
//                   pay Friday" is a control-room note. Surfacing all of them
//                   to a technician buries the one that matters, and a banner
//                   nobody can act on is a banner nobody reads.
//
//   resolved_at   — an instruction has a life. "Rewire the ignition feed" is
//                   outstanding until somebody does it, and then it must stop
//                   appearing. Without this every future job card shows every
//                   instruction ever written, which is how a workshop learns
//                   to ignore the notes panel entirely.
//
// The row is kept after it is resolved. What was wrong with a bike and when it
// was put right is the bike's history, and the next person deserves it.

exports.up = (pgm) => {
  pgm.addColumns('bike_notes', {
    for_workshop: { type: 'boolean', notNull: true, default: false },
    resolved_at: { type: 'timestamptz' },
    resolved_by: { type: 'integer', references: 'users', onDelete: 'SET NULL' },
  });

  // The job card reads the open ones for a bike on every open, so it is worth
  // an index rather than a scan of every note the bike has ever had.
  pgm.createIndex('bike_notes', ['bike_id'], {
    name: 'bike_notes_open_workshop_idx',
    where: 'for_workshop = TRUE AND resolved_at IS NULL',
  });
};

exports.down = (pgm) => {
  pgm.dropIndex('bike_notes', ['bike_id'], { name: 'bike_notes_open_workshop_idx' });
  pgm.dropColumns('bike_notes', ['for_workshop', 'resolved_at', 'resolved_by']);
};
