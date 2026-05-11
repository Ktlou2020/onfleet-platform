#!/usr/bin/env node
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const db = require('../db');
const { normalizeBikeStatus, bikeHasActiveAgreement, setBikeStatus } = require('../utils/bikeStatus');

function readArg(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : '';
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function splitCsvLine(line) {
  const values = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      values.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  values.push(current);
  return values;
}

function parseCsv(text) {
  const rows = [];
  const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) return rows;
  const headers = splitCsvLine(lines.shift()).map((header) => header.trim());
  for (const line of lines) {
    const values = splitCsvLine(line);
    const row = {};
    headers.forEach((header, index) => {
      row[header] = String(values[index] || '').trim();
    });
    rows.push(row);
  }
  return rows;
}

function normalizeKey(value) {
  return String(value || '').trim().toLowerCase().replace(/[_\-]+/g, ' ');
}

function pick(row, candidates) {
  const keys = Object.keys(row || {});
  for (const candidate of candidates) {
    const exact = keys.find((key) => normalizeKey(key) === normalizeKey(candidate));
    if (exact && String(row[exact] || '').trim()) return String(row[exact] || '').trim();
  }
  for (const candidate of candidates) {
    const fuzzy = keys.find((key) => normalizeKey(key).includes(normalizeKey(candidate)));
    if (fuzzy && String(row[fuzzy] || '').trim()) return String(row[fuzzy] || '').trim();
  }
  return '';
}

function findBike(row) {
  const id = pick(row, ['id', 'bike id', 'bike_id']);
  const registration = pick(row, ['registration', 'vehicle reg', 'bike registration']);
  const vin = pick(row, ['vin']);
  if (id) return db.prepare(`SELECT * FROM bikes WHERE id = ?`).get(id);
  if (registration) return db.prepare(`SELECT * FROM bikes WHERE registration = ?`).get(registration);
  if (vin) return db.prepare(`SELECT * FROM bikes WHERE vin = ?`).get(vin);
  return null;
}

function usage() {
  console.log(`
Usage:
  node src/scripts/update-bike-statuses-from-csv.js --file ./bike-statuses.csv
  node src/scripts/update-bike-statuses-from-csv.js --file ./bike-statuses.csv --dry-run

CSV must include a status column plus one bike identifier column:
  - id or bike_id
  - registration / vehicle reg
  - vin
`);
}

const filePath = readArg('--file');
const dryRun = hasFlag('--dry-run');
if (!filePath) {
  usage();
  process.exit(1);
}

const resolvedPath = path.resolve(process.cwd(), filePath);
if (!fs.existsSync(resolvedPath)) {
  console.error(`CSV file not found: ${resolvedPath}`);
  process.exit(1);
}

const rows = parseCsv(fs.readFileSync(resolvedPath, 'utf8'));
const summary = {
  file: resolvedPath,
  dry_run: dryRun,
  total_rows: rows.length,
  updated: 0,
  paused_agreements: 0,
  not_found: 0,
  missing_status: 0,
  missing_identifier: 0,
  errors: []
};

for (let index = 0; index < rows.length; index += 1) {
  const row = rows[index];
  const rawStatus = pick(row, ['status', 'bike status']);
  if (!rawStatus) {
    summary.missing_status += 1;
    summary.errors.push({ row: index + 2, error: 'Missing status value' });
    continue;
  }

  const hasAnyIdentifier = Boolean(pick(row, ['id', 'bike id', 'bike_id', 'registration', 'vehicle reg', 'bike registration', 'vin']));
  if (!hasAnyIdentifier) {
    summary.missing_identifier += 1;
    summary.errors.push({ row: index + 2, error: 'Missing bike identifier (id, registration, or vin)' });
    continue;
  }

  const bike = findBike(row);
  if (!bike) {
    summary.not_found += 1;
    summary.errors.push({ row: index + 2, error: 'Bike not found', registration: pick(row, ['registration', 'vehicle reg', 'bike registration']) || null, vin: pick(row, ['vin']) || null });
    continue;
  }

  try {
    if (dryRun) {
      const hasActiveAgreement = bikeHasActiveAgreement(bike.id);
      const nextStatus = normalizeBikeStatus(rawStatus, { bikeId: bike.id, hasAllocation: hasActiveAgreement });
      summary.updated += 1;
      if (nextStatus === 'repairs' && hasActiveAgreement) summary.paused_agreements += 1;
      continue;
    }

    const result = setBikeStatus(bike.id, rawStatus);
    summary.updated += 1;
    summary.paused_agreements += result.paused_agreements || 0;
  } catch (error) {
    summary.errors.push({ row: index + 2, bike_id: bike.id, error: error.message });
  }
}

console.log(JSON.stringify(summary, null, 2));
