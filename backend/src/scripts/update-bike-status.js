#!/usr/bin/env node
require('dotenv').config();

const db = require('../db');
const { normalizeBikeStatus, BIKE_STATUS_OPTIONS, bikeHasActiveAgreement, setBikeStatus } = require('../utils/bikeStatus');

function readArg(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : '';
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function usage() {
  console.log(`
Usage:
  node src/scripts/update-bike-status.js --id 12 --status "Paid off"
  node src/scripts/update-bike-status.js --registration AB12CDGP --status "Repairs"
  node src/scripts/update-bike-status.js --vin VIN123 --status "Active"
  node src/scripts/update-bike-status.js --id 12 --status "Ready to go" --dry-run

Supported status values:
  ${BIKE_STATUS_OPTIONS.map((option) => `${option.label} -> ${option.value}`).join('\n  ')}

Import-friendly mappings:
  Active    -> active only if a current agreement exists, otherwise ready_to_go
  Repairs   -> repairs and pauses current active agreements
  Paid Off  -> paid_off
  Stolen    -> written_off
`);
}

const id = readArg('--id');
const registration = readArg('--registration');
const vin = readArg('--vin');
const rawStatus = readArg('--status');
const dryRun = hasFlag('--dry-run');

if (!rawStatus || (!id && !registration && !vin)) {
  usage();
  process.exit(1);
}

const bike = id
  ? db.prepare(`SELECT * FROM bikes WHERE id = ?`).get(id)
  : registration
    ? db.prepare(`SELECT * FROM bikes WHERE registration = ?`).get(registration)
    : db.prepare(`SELECT * FROM bikes WHERE vin = ?`).get(vin);

if (!bike) {
  console.error('Bike not found. Pass --id, --registration, or --vin for an existing bike.');
  process.exit(1);
}

const hasActiveAgreement = bikeHasActiveAgreement(bike.id);
const nextStatus = normalizeBikeStatus(rawStatus, { bikeId: bike.id, hasAllocation: hasActiveAgreement });
if (dryRun) {
  console.log(JSON.stringify({
    bike_id: bike.id,
    registration: bike.registration,
    vin: bike.vin,
    input_status: rawStatus,
    previous_status: bike.status,
    next_status: nextStatus,
    had_active_agreement: hasActiveAgreement,
    would_pause_agreements: nextStatus === 'repairs' ? (hasActiveAgreement ? 1 : 0) : 0,
    dry_run: true
  }, null, 2));
  process.exit(0);
}

try {
  const result = setBikeStatus(bike.id, rawStatus);
  console.log(JSON.stringify({
    bike_id: bike.id,
    registration: bike.registration,
    vin: bike.vin,
    input_status: rawStatus,
    ...result,
    dry_run: false
  }, null, 2));
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
