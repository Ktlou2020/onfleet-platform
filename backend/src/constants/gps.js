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

module.exports = { MIN_TRUSTED_SATELLITES };
