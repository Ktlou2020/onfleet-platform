'use strict';

// Imports historical GPS data from another tracking platform's CSV export —
// built specifically for the "trip summary" export shape confirmed against
// a real file: a couple of metadata lines before the actual header row,
// per-row coordinates embedded in a Google Maps link rather than plain
// lat/lng columns, and occasional blank or summary-only rows mixed into the
// data. Tolerates all of that (skips what it can't use, doesn't error the
// whole file) rather than requiring the export be hand-reformatted first.

const pgDb = require('../pgDb');

const COORD_RE = /query=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/;

function splitCsvLine(line) {
  const values = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i += 1; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      values.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  values.push(current.trim());
  return values;
}

function parseDate(text) {
  if (!text) return null;
  const d = new Date(text);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Scans the first few lines for the real header row, since exports like this
// commonly lead with a title line and a timezone line before the columns.
function findHeaderRowIndex(lines) {
  for (let i = 0; i < Math.min(lines.length, 10); i += 1) {
    const lower = lines[i].toLowerCase();
    if (lower.includes('vehicle') && (lower.includes('start') || lower.includes('lat') || lower.includes('googlemaplink'))) return i;
  }
  return -1;
}

function parseGpsCsv(text) {
  const clean = String(text || '').replace(/^﻿/, '');
  const lines = clean.split(/\r?\n/).filter((l) => l.trim().length);
  const headerIdx = findHeaderRowIndex(lines);
  if (headerIdx === -1) throw new Error('Could not find a header row — expected columns like "Vehicle" and "Start" or a coordinates link');
  const headers = splitCsvLine(lines[headerIdx]).map((h) => h.trim());
  return { headers, dataLines: lines.slice(headerIdx + 1) };
}

// Returns a usable ping candidate for this row, or null if it can't be used
// (missing vehicle, no extractable coordinates, or no parseable timestamp).
function extractPing(headers, line) {
  const values = splitCsvLine(line);
  const row = {};
  headers.forEach((h, i) => { row[h] = values[i] || ''; });

  const vehicle = String(row.Vehicle || row.vehicle || row.Registration || row.registration || '').trim();
  if (!vehicle) return null;

  let lat = parseFloat(row.lat || row.Lat || row.Latitude);
  let lng = parseFloat(row.lng || row.Lng || row.Longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    const link = row.GoogleMapLink || row['Google Map Link'] || row.Link || '';
    const match = COORD_RE.exec(link);
    if (match) { lat = parseFloat(match[1]); lng = parseFloat(match[2]); }
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  const recordedAt = parseDate(row.End || row.end) || parseDate(row.Start || row.start) || parseDate(row.Date || row.date);
  if (!recordedAt) return null;

  return { vehicle, lat, lng, recorded_at: recordedAt.toISOString() };
}

function preview(text) {
  const { headers, dataLines } = parseGpsCsv(text);
  const pings = [];
  let skipped = 0;
  for (const line of dataLines) {
    const ping = extractPing(headers, line);
    if (ping) pings.push(ping); else skipped += 1;
  }
  return { headers, total_rows: dataLines.length, usable_rows: pings.length, skipped_rows: skipped, sample: pings.slice(0, 5) };
}

async function resolveBikeId(registration, cache) {
  const key = registration.toUpperCase();
  if (cache.has(key)) return cache.get(key);
  const { rows } = await pgDb.query(`SELECT id FROM bikes WHERE UPPER(COALESCE(registration, '')) = $1`, [key]);
  const id = rows[0]?.id || null;
  cache.set(key, id);
  return id;
}

async function importCsv(text) {
  const { dataLines, headers } = parseGpsCsv(text);
  const bikeCache = new Map();
  const summary = { imported: 0, duplicate: 0, skipped: 0, unresolved_bike: 0, errors: [] };

  for (const [index, line] of dataLines.entries()) {
    const ping = extractPing(headers, line);
    if (!ping) { summary.skipped += 1; continue; }

    const bikeId = await resolveBikeId(ping.vehicle, bikeCache);
    if (!bikeId) {
      summary.unresolved_bike += 1;
      summary.errors.push({ row: index + 1, error: `No bike found for registration "${ping.vehicle}"` });
      continue;
    }

    const { rows: existing } = await pgDb.query(
      'SELECT 1 FROM gps_pings WHERE bike_id = $1 AND recorded_at = $2 AND lat = $3 AND lng = $4 LIMIT 1',
      [bikeId, ping.recorded_at, ping.lat, ping.lng]
    );
    if (existing[0]) { summary.duplicate += 1; continue; }

    await pgDb.query(
      `INSERT INTO gps_pings (bike_id, lat, lng, recorded_at, source) VALUES ($1, $2, $3, $4, 'import')`,
      [bikeId, ping.lat, ping.lng, ping.recorded_at]
    );
    summary.imported += 1;
  }

  return summary;
}

module.exports = { preview, importCsv };
