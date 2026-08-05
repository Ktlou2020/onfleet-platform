'use strict';

// Teltonika setdigout target output differs by model — FMB965 switches digital
// output 2 (leaving output 1 untouched via '?'), everything else here uses
// output 1. Single source of truth: this used to be duplicated (and
// inconsistently cased/normalized) across geofenceService.js,
// routes/tracking.js, and routes/fleet.js.
//
// IMPORTANT: the trailing number in `setdigout <state> <N>` is a TIMEOUT IN
// SECONDS after which the output auto-reverts — it is NOT a second output's
// state. The previous 'setdigout 1 1' / 'setdigout 1 0' commands here held a
// cut for all of 1 second before auto-releasing, and "restored" by asking the
// device to turn DOUT back ON (state=1) with a 0s hold, which is why device
// command responses came back "DOUT1:Already set to 1" on every restore
// attempt — restore was silently never working. Omitting the timeout entirely
// holds the state indefinitely until an explicit opposite command is sent,
// which is what "stays cut until deactivated" requires.
const CUT_BY_MODEL     = { fmb920: 'setdigout 1',   fmc920: 'setdigout 1',   fmb965: 'setdigout ? 1' };
const RESTORE_BY_MODEL = { fmb920: 'setdigout 0',   fmc920: 'setdigout 0',   fmb965: 'setdigout ? 0' };

function normalizeModel(model) {
  return String(model || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function cutCommandForModel(model) {
  return CUT_BY_MODEL[normalizeModel(model)] || 'setdigout 1';
}

function restoreCommandForModel(model) {
  return RESTORE_BY_MODEL[normalizeModel(model)] || 'setdigout 0';
}

module.exports = { cutCommandForModel, restoreCommandForModel };
