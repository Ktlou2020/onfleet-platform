'use strict';

// Locking the fleet overnight.
//
// The curfew already cuts a bike that is confirmed as moving between midnight
// and four. This is the other half: a bike that is parked when the window
// opens is immobilised so it cannot be started at all. A thief does not get
// to ride off and stall at the first robot — the bike never starts.
//
// Why this is its own flag rather than reusing engine_cut_active:
//
//   engine_cut_active means "this bike stays cut until a person restores it",
//   and teltonikaServer re-asserts it on every reconnect, unconditionally.
//   That is right for a stolen bike and wrong for this. A night-locked bike
//   that reconnects while moving — because somebody pulled the battery and
//   rode off — would have setdigout fired at road speed, which is the exact
//   thing the curfew's walking-pace rule exists to prevent.
//
//   Keeping them apart also lets the four o'clock sweep be precise: it wakes
//   the bikes it put to sleep and leaves anything cut for theft or arrears
//   exactly where it is.
//
// released_until is how a rider working late gets their bike back without
// anybody being woken up. It is a per-bike pass for the rest of tonight, the
// same shape as night_curfew_reprieve_until, and it expires on its own.

exports.up = (pgm) => {
  pgm.addColumns('tracking_devices', {
    night_lock_active: {
      type: 'boolean',
      notNull: true,
      default: false,
      comment: 'Immobilised because it was parked when the overnight window opened',
    },
    night_locked_at: { type: 'timestamptz' },
  });

  // The sweeps ask "which devices are locked" and "which are lockable", and
  // both run against every device in the fleet at a fixed time.
  pgm.createIndex('tracking_devices', 'night_lock_active', {
    where: 'night_lock_active = TRUE',
    name: 'idx_tracking_devices_night_locked',
  });

  pgm.addColumns('bikes', {
    night_lock_released_until: {
      type: 'timestamptz',
      comment: 'A rider or the control room let this bike out for the rest of tonight',
    },
  });
};

exports.down = (pgm) => {
  pgm.dropColumns('bikes', ['night_lock_released_until']);
  pgm.dropIndex('tracking_devices', 'night_lock_active', { name: 'idx_tracking_devices_night_locked' });
  pgm.dropColumns('tracking_devices', ['night_lock_active', 'night_locked_at']);
};
