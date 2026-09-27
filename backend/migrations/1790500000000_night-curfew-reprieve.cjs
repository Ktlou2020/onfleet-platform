'use strict';

// A way to say "not tonight" to the overnight curfew.
//
// Bike MJ71MRGP moved after midnight, the curfew cut it — correctly — and when
// the control room restored the engine it was cut again, and again. Nothing
// was wrong with any single decision: night_movement re-fired after its
// fifteen-minute cooldown, re-armed the curfew, and the bike was cut the next
// time it slowed to walking pace. The operator was arguing with a loop.
//
// night_curfew_exempt already exists but is permanent, and permanent is the
// wrong shape: somebody has to remember to switch it back, and the night they
// forget is the night a bike goes missing. A timestamp expires on its own.
//
// Set to the end of the current curfew window when a person restores an engine
// during it. The protection returns at 04:00 without anybody doing anything.

exports.up = (pgm) => {
  pgm.addColumns('bikes', {
    night_curfew_reprieve_until: { type: 'timestamptz' },
  });
};

exports.down = (pgm) => {
  pgm.dropColumns('bikes', ['night_curfew_reprieve_until']);
};
