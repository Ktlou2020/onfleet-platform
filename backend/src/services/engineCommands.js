'use strict';

// Teltonika setdigout target output differs by model — FMB965 switches digital
// output 2, everything else here uses output 1. Single source of truth: this
// used to be duplicated (and inconsistently cased/normalized) across
// geofenceService.js, routes/tracking.js, and routes/fleet.js.
const CUT_BY_MODEL     = { fmb920: 'setdigout 1 1', fmc920: 'setdigout 1 1', fmb965: 'setdigout 2 1' };
const RESTORE_BY_MODEL = { fmb920: 'setdigout 1 0', fmc920: 'setdigout 1 0', fmb965: 'setdigout 2 0' };

function normalizeModel(model) {
  return String(model || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function cutCommandForModel(model) {
  return CUT_BY_MODEL[normalizeModel(model)] || 'setdigout 1 1';
}

function restoreCommandForModel(model) {
  return RESTORE_BY_MODEL[normalizeModel(model)] || 'setdigout 1 0';
}

module.exports = { cutCommandForModel, restoreCommandForModel };
