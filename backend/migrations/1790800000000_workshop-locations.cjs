'use strict';

// A second workshop.
//
// The booking calendar shipped assuming one workshop, because that is how the
// request was phrased. There are two: OnFix in Johannesburg and Bikerhouse in
// Cape Town, which until now existed only as two hardcoded Google Calendar
// links on the rider's agreement page. A Cape Town rider offered Johannesburg
// slots is not a smaller version of the right answer, it is the wrong one.
//
// The important change is to the unique index that stops double booking.
// Before, one booking anywhere in the country held 09:30. Now both workshops
// can run a bike at 09:30, so the constraint is per location — get this wrong
// and the calendar silently halves its own capacity, which is the kind of bug
// that reads as "we are fully booked" rather than as an error.
//
// A bike still holds only one live booking in total. That index is unchanged
// on purpose: booking the same bike into both workshops on the same morning is
// a mistake in any location.
//
// Locations are a table rather than an enum because a third workshop should be
// a row an admin adds, not a migration.

exports.up = (pgm) => {
  pgm.createTable('workshop_locations', {
    id: 'id',
    name: { type: 'text', notNull: true },
    city: { type: 'text', notNull: true },
    // Matched against users.province to pick a rider's default workshop. Null
    // means "never offer this one as a default", which is what a third,
    // specialist site would want.
    province: { type: 'text' },
    address: { type: 'text' },
    phone: { type: 'text' },
    active: { type: 'boolean', notNull: true, default: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
  });

  // Seeded rather than left to an admin because the backfill below has to put
  // the existing week somewhere, and because a booking page with no locations
  // on it is broken rather than empty.
  //
  // Which workshops depends on the brand. OnFleet owns two and services its
  // own motorcycles at them; Pillion owns none and sells the platform to
  // companies that do, so a Pillion deployment seeded with OnFleet's workshop
  // names ships a competitor's branding to that competitor's customers. It
  // did exactly that, which is why this is no longer a fixed list.
  //
  // Editing a migration that has already run is normally a mistake. It is
  // safe here precisely because it has already run: a database carrying this
  // in pgmigrations will not run it again, so nothing that exists changes.
  // This decides what a database created from today gets, and nothing else.
  // The two rows already sitting in Pillion's production database are not
  // corrected by this and have to be renamed in the admin console.
  const { initialWorkshops } = require('../src/constants/workshopSeed');
  const { isDefault } = require('../src/brand');

  // pgm.sql takes no parameters, so the values are inlined. They come from a
  // constant in this repository rather than from anything a user typed, but
  // they are quoted properly regardless: a seed that breaks on an apostrophe
  // the day somebody adds "O'Brien Motors" is a bad way to find out.
  const lit = (v) => (v == null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);

  const rows = initialWorkshops(isDefault)
    .map((w) => `(${lit(w.name)}, ${lit(w.city)}, ${lit(w.province)})`)
    .join(',\n      ');
  pgm.sql(`
    INSERT INTO workshop_locations (name, city, province) VALUES
      ${rows}
  `);

  // Backfill in three steps — add nullable, fill, then constrain — because
  // adding a NOT NULL column to a table that already has rows fails outright,
  // and this migration runs at boot on a database where the previous one has
  // already seeded a week of opening hours.
  for (const table of ['service_slot_rules', 'service_closures', 'service_bookings']) {
    pgm.addColumns(table, {
      location_id: { type: 'integer', references: 'workshop_locations', onDelete: 'RESTRICT' },
    });
    // Everything that exists was created when there was only one workshop, so
    // it belongs to the first one.
    pgm.sql(`UPDATE ${table} SET location_id = (SELECT MIN(id) FROM workshop_locations) WHERE location_id IS NULL`);
    pgm.alterColumn(table, 'location_id', { notNull: true });
  }

  // Give the second workshop the same starting week as the first, so it is
  // usable on day one rather than showing every rider a closed calendar.
  pgm.sql(`
    INSERT INTO service_slot_rules (weekday, opens_at, closes_at, location_id)
    SELECT r.weekday, r.opens_at, r.closes_at, l.id
      FROM service_slot_rules r
      CROSS JOIN workshop_locations l
     WHERE r.location_id = (SELECT MIN(id) FROM workshop_locations)
       AND l.id <> (SELECT MIN(id) FROM workshop_locations)
  `);

  // The one that matters. Two workshops can each take a bike at 09:30.
  pgm.dropIndex('service_bookings', ['starts_at'], { name: 'service_bookings_one_bike_per_slot' });
  pgm.createIndex('service_bookings', ['location_id', 'starts_at'], {
    name: 'service_bookings_one_bike_per_slot',
    unique: true,
    where: `status IN ('booked', 'arrived')`,
  });

  // Closures are per workshop too: Bikerhouse doing a stocktake says nothing
  // about whether OnFix is open.
  pgm.dropConstraint('service_closures', 'service_closures_closed_on_key');
  pgm.addConstraint('service_closures', 'service_closures_one_per_location_per_day',
    'UNIQUE (location_id, closed_on)');

  pgm.createIndex('service_slot_rules', ['location_id', 'weekday']);
  pgm.createIndex('service_bookings', ['location_id', 'starts_at', 'status']);
};

exports.down = (pgm) => {
  pgm.dropIndex('service_bookings', ['location_id', 'starts_at', 'status']);
  pgm.dropIndex('service_slot_rules', ['location_id', 'weekday']);

  pgm.dropConstraint('service_closures', 'service_closures_one_per_location_per_day');
  // Reversing this loses data by definition: two workshops' closures on one
  // date cannot both survive a constraint that allows one. Keep the earliest.
  pgm.sql(`
    DELETE FROM service_closures a
     USING service_closures b
     WHERE a.closed_on = b.closed_on AND a.id > b.id
  `);
  pgm.addConstraint('service_closures', 'service_closures_closed_on_key', 'UNIQUE (closed_on)');

  pgm.dropIndex('service_bookings', ['location_id', 'starts_at'], { name: 'service_bookings_one_bike_per_slot' });
  // Same again: two workshops booked at the same instant cannot both keep it.
  pgm.sql(`
    DELETE FROM service_bookings a
     USING service_bookings b
     WHERE a.starts_at = b.starts_at AND a.id > b.id
       AND a.status IN ('booked','arrived') AND b.status IN ('booked','arrived')
  `);
  pgm.createIndex('service_bookings', ['starts_at'], {
    name: 'service_bookings_one_bike_per_slot',
    unique: true,
    where: `status IN ('booked', 'arrived')`,
  });

  pgm.sql(`DELETE FROM service_slot_rules WHERE location_id <> (SELECT MIN(id) FROM workshop_locations)`);
  for (const table of ['service_bookings', 'service_closures', 'service_slot_rules']) {
    pgm.dropColumns(table, ['location_id']);
  }
  pgm.dropTable('workshop_locations');
};
