#!/usr/bin/env node
require('dotenv').config();

const pgDb = require('../pgDb');
const { normalizeBikeStatus, BIKE_STATUS_OPTIONS } = require('../utils/bikeStatus');
const { bikeHasActiveAgreement, setBikeStatus } = require('../utils/bikeStatusPg');

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

async function main() {
  const id = readArg('--id');
  const registration = readArg('--registration');
  const vin = readArg('--vin');
  const rawStatus = readArg('--status');
  const dryRun = hasFlag('--dry-run');

  if (!rawStatus || (!id && !registration && !vin)) {
    usage();
    process.exit(1);
  }

  const { rows } = id
    ? await pgDb.query(`SELECT * FROM bikes WHERE id = $1`, [id])
    : registration
      ? await pgDb.query(`SELECT * FROM bikes WHERE registration = $1`, [registration])
      : await pgDb.query(`SELECT * FROM bikes WHERE vin = $1`, [vin]);
  const bike = rows[0];

  if (!bike) {
    console.error('Bike not found. Pass --id, --registration, or --vin for an existing bike.');
    process.exit(1);
  }

  const hasActiveAgreement = await bikeHasActiveAgreement(bike.id);
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
    const result = await setBikeStatus(bike.id, rawStatus);
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
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
