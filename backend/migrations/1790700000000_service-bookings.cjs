'use strict';

// Letting a rider book their own service slot.
//
// Servicing has been arranged by phone. The workshop's day is a WhatsApp
// thread, riders turn up when it suits them, and serviceDue.js can tell you a
// bike is 400 km overdue without there being anywhere to send the rider.
//
// Three tables, and the shape of each is a decision worth stating:
//
//   service_slot_rules  — the weekly template the admin keeps. Several rows
//                         per weekday are allowed on purpose: a workshop that
//                         shuts for lunch has two windows, not one, and
//                         modelling that as one row with a break in the middle
//                         means inventing a second pair of columns. A weekday
//                         with no rows is a day the workshop does not take
//                         bookings, so "closed on Sunday" is the absence of a
//                         row rather than a flag somebody has to remember to
//                         set.
//
//   service_closures    — the exceptions. A public holiday should not require
//                         editing the weekly template and then remembering to
//                         put it back, which is how a workshop ends up shut on
//                         every future Monday.
//
//   service_bookings    — the bookings themselves.
//
// Slots are generated from the rules rather than stored: 30 minutes of work
// then a 15-minute gap, so a window from 08:00 lands slots at 08:00, 08:45,
// 09:30 and so on. Storing every slot would mean a row for every 45 minutes of
// every working day for ever, all of them empty, and an admin who shortens
// Tuesday afternoons would need them all rebuilt. Generating them means the
// rules are the truth and a booking is the only thing worth a row.

exports.up = (pgm) => {
  pgm.createTable('service_slot_rules', {
    id: 'id',
    // 0 = Sunday, matching JavaScript's getDay() and Postgres's EXTRACT(DOW).
    // Two conventions for weekdays in one codebase is a bug waiting to happen.
    weekday: { type: 'smallint', notNull: true },
    opens_at: { type: 'time', notNull: true },
    closes_at: { type: 'time', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
    updated_by: { type: 'integer', references: 'users', onDelete: 'SET NULL' },
  });
  pgm.addConstraint('service_slot_rules', 'service_slot_rules_weekday_range',
    'CHECK (weekday BETWEEN 0 AND 6)');
  // A window that ends before it starts silently produces no slots at all, so
  // the admin sees an empty calendar and no reason for it.
  pgm.addConstraint('service_slot_rules', 'service_slot_rules_window_forward',
    'CHECK (closes_at > opens_at)');
  pgm.createIndex('service_slot_rules', ['weekday']);

  pgm.createTable('service_closures', {
    id: 'id',
    closed_on: { type: 'date', notNull: true, unique: true },
    reason: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
    created_by: { type: 'integer', references: 'users', onDelete: 'SET NULL' },
  });

  pgm.createTable('service_bookings', {
    id: 'id',
    bike_id: { type: 'integer', notNull: true, references: 'bikes', onDelete: 'CASCADE' },
    // Who made it — a rider for their own bike, or an admin for anybody's.
    booked_by: { type: 'integer', references: 'users', onDelete: 'SET NULL' },
    starts_at: { type: 'timestamptz', notNull: true },
    status: { type: 'text', notNull: true, default: 'booked' },
    // What the rider says is wrong with it, so the workshop can plan the day
    // rather than finding out at the counter.
    note: { type: 'text' },
    // Filled in when the bike actually arrives and a technician opens a card.
    // Null until then, on purpose: an open job card is work happening, and
    // creating one at booking time means every no-show leaves a stale card
    // somebody has to find and close.
    job_card_id: { type: 'integer', references: 'job_cards', onDelete: 'SET NULL' },
    cancelled_at: { type: 'timestamptz' },
    cancelled_by: { type: 'integer', references: 'users', onDelete: 'SET NULL' },
    cancel_reason: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
  });

  pgm.addConstraint('service_bookings', 'service_bookings_status_known',
    `CHECK (status IN ('booked', 'arrived', 'completed', 'cancelled', 'no_show'))`);

  // The one that matters.
  //
  // Two riders open the booking page, both see 09:30 free, both tap it. Any
  // check in application code is a read followed by a write with a gap in the
  // middle, and under two requests that gap is where the double booking
  // happens. The database is the only place that can settle it, so the second
  // INSERT fails on this index and the route turns that into "somebody just
  // took that slot" rather than a bike arriving to find the bay occupied.
  //
  // Cancelled and completed bookings are excluded so a freed slot is genuinely
  // bookable again, and so history accumulates without blocking anything.
  pgm.createIndex('service_bookings', ['starts_at'], {
    name: 'service_bookings_one_bike_per_slot',
    unique: true,
    where: `status IN ('booked', 'arrived')`,
  });

  // And a bike holds one live booking at a time. Without this a rider who
  // wants a different time books the new slot and leaves the old one sitting
  // there, which costs the workshop a bay and shows up as a no-show. Moving a
  // booking updates this row instead.
  pgm.createIndex('service_bookings', ['bike_id'], {
    name: 'service_bookings_one_live_per_bike',
    unique: true,
    where: `status IN ('booked', 'arrived')`,
  });

  // The workshop's day view and the rider's calendar both read a date range.
  pgm.createIndex('service_bookings', ['starts_at', 'status']);
  pgm.createIndex('service_bookings', ['bike_id', 'starts_at']);

  // A sensible week to start from, so the calendar is not empty on the day
  // this ships and the first admin to open it is editing something rather than
  // building it from nothing. Weekdays 08:00–12:00 and 13:00–16:00 (the gap is
  // lunch), Saturday mornings, closed Sunday.
  pgm.sql(`
    INSERT INTO service_slot_rules (weekday, opens_at, closes_at) VALUES
      (1, '08:00', '12:00'), (1, '13:00', '16:00'),
      (2, '08:00', '12:00'), (2, '13:00', '16:00'),
      (3, '08:00', '12:00'), (3, '13:00', '16:00'),
      (4, '08:00', '12:00'), (4, '13:00', '16:00'),
      (5, '08:00', '12:00'), (5, '13:00', '16:00'),
      (6, '08:00', '12:00')
  `);
};

exports.down = (pgm) => {
  pgm.dropTable('service_bookings');
  pgm.dropTable('service_closures');
  pgm.dropTable('service_slot_rules');
};
