'use strict';

// How many satellites a fix needs before the platform will act on it.
//
// Below four, a Teltonika position can be a kilometre out and the speed that
// comes with it can be nonsense — a parked bike reporting 106 km/h. The same
// line was already drawn independently in geofenceService (which refuses to
// open or close a zone) and in deviceHealth (which refuses to call a weak fix
// a fault), and trips drew no line at all, so one bad ping could set a trip's
// top speed for ever.
//
// One number, named once, because the interesting bugs in this codebase have
// all been two places reading the same reading and meaning different things by
// it.
const MIN_TRUSTED_SATELLITES = 4;

// How old a fix may be and still justify sending an immobilise.
//
// A different question from the staleness bounds used for reporting, and a
// much shorter leash, because this one ends with a motorcycle's engine being
// cut. A Teltonika that sleeps or loses coverage buffers its records and
// dumps them oldest-first when it next dials in, so a position stamped an
// hour ago can arrive now. "Speed 0, an hour ago" is not evidence that a bike
// is standing still: one parked at 23:34 and ridden at 00:35 reports exactly
// that, and bike 457 replayed a 02:03 fix at 11:42 while it was accelerating
// away from a stop.
//
// Named here, next to MIN_TRUSTED_SATELLITES, for the reason that file-level
// comment already gives. The night lock and the overnight curfew both decide
// whether to cut an engine from a reading, and the two must not answer "is
// this reading current" differently.
const MAX_ACTIONABLE_FIX_AGE_MS = 5 * 60 * 1000;

module.exports = { MIN_TRUSTED_SATELLITES, MAX_ACTIONABLE_FIX_AGE_MS };
