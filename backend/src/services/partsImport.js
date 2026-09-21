'use strict';

// Reading a supplier's parts price list into the catalogue.
//
// Hero sends dealers a spreadsheet per model — a Parts sheet with every part
// on the bike, and a Kits sheet with the assemblies a workshop actually orders
// (chain and sprocket, oil seal, valve). Column headings vary between lists,
// so they are matched by meaning rather than by position, and anything not
// recognised is reported instead of quietly dropped.
//
// Part numbers matter more here than anywhere else in the platform: Hero
// supplies "only according to the part number requested by a dealer" (their
// ordering SOP), so an old or mistyped number is a rejected order. That is why
// the superseded number is kept alongside the current one and both are
// searchable.

const pgDb = require('../pgDb');
const { readWorkbook, rowsAsObjects } = require('./xlsxReader');

// header (lowercased, punctuation-free) → field
const COLUMN_ALIASES = {
  partcode: 'part_number', partno: 'part_number', partnumber: 'part_number', part: 'part_number',
  partdescription: 'description', description: 'description', partdesc: 'description',
  model: 'model',
  groupno: 'group_code', group: 'group_code', groupcode: 'group_code',
  groupdesc: 'group_name', groupdescription: 'group_name', groupname: 'group_name',
  sequenceno: 'ref_no', seqno: 'ref_no', refno: 'ref_no', sno: 'line_no', serialno: 'line_no',
  status: 'status', partstatus: 'status',
  supercedenceoldpart: 'supersedes', supercedence: 'supersedes', supersedence: 'supersedes',
  supersession: 'supersedes', oldpartno: 'supersedes',
  alternatepartno: 'alternate_part_number', alternatepart: 'alternate_part_number',
  recommendedretailpriceexvat: 'price_ex_vat', retailpriceexvat: 'price_ex_vat',
  retailprice: 'price_ex_vat', priceexvat: 'price_ex_vat', price: 'price_ex_vat',
};

const normaliseHeader = (h) => String(h || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const clean = (v) => {
  const s = String(v ?? '').trim();
  return s === '-' || s === '' ? null : s;
};

function parsePrice(value) {
  if (value == null || value === '') return null;
  const n = Number(String(value).replace(/[^\d.-]/g, ''));
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100) / 100; // the lists carry float noise: 314.82000000000005
}

function mapRecord(record) {
  const out = {};
  for (const [header, value] of Object.entries(record)) {
    const field = COLUMN_ALIASES[normaliseHeader(header)];
    if (field) out[field] = value;
  }
  return out;
}

// A sheet is worth importing if its headers include a part number and a
// description; anything else (cover sheets, notes) is skipped by name.
function sheetToParts(sheet, { make, model, isKit }) {
  const { headers, records } = rowsAsObjects(sheet.rows);
  const mappedHeaders = headers.map(normaliseHeader).map((h) => COLUMN_ALIASES[h]).filter(Boolean);
  if (!mappedHeaders.includes('part_number') || !mappedHeaders.includes('description')) return null;

  const parts = [];
  const skipped = [];
  for (const record of records) {
    const row = mapRecord(record);
    const partNumber = clean(row.part_number);
    const description = clean(row.description);
    if (!partNumber || !description) {
      if (partNumber || description) skipped.push({ part_number: partNumber, description, reason: 'Missing a part number or a description' });
      continue;
    }
    parts.push({
      make,
      // The model chosen at import wins over the sheet's own wording: one list
      // says "ECO 150 (Dec, 2019)" on its parts sheet and "Eco 150" on its kits
      // sheet, and neither matches how the bikes are recorded. A catalogue that
      // doesn't match the bikes can't be searched from a job card.
      model,
      sheet_model: clean(row.model),
      part_number: partNumber.toUpperCase(),
      description,
      group_code: clean(row.group_code) || (isKit ? 'KIT' : 'UNGROUPED'),
      group_name: clean(row.group_name) || (isKit ? 'KITS' : 'UNGROUPED'),
      ref_no: clean(row.ref_no),
      status: clean(row.status),
      supersedes: clean(row.supersedes),
      alternate_part_number: clean(row.alternate_part_number),
      price_ex_vat: parsePrice(row.price_ex_vat),
      is_kit: !!isKit,
    });
  }
  return { parts, skipped };
}

// Parse without touching the database, so an import can be previewed first.
function parseWorkbook(buffer, { make, model }) {
  const sheets = readWorkbook(buffer);
  const parts = [];
  const skipped = [];
  const sheetSummary = [];
  for (const sheet of sheets) {
    const isKit = /kit/i.test(sheet.name);
    const result = sheetToParts(sheet, { make, model, isKit });
    if (!result) {
      sheetSummary.push({ sheet: sheet.name, used: false, reason: 'No part number and description columns' });
      continue;
    }
    parts.push(...result.parts);
    skipped.push(...result.skipped);
    sheetSummary.push({ sheet: sheet.name, used: true, kits: isKit, parts: result.parts.length });
  }
  // The same part can appear under two groups in one list; the last wins, but
  // a price is never overwritten with a blank.
  const byIdentity = new Map();
  for (const part of parts) {
    const key = `${part.part_number}|${part.group_code}|${part.ref_no || ''}`;
    const existing = byIdentity.get(key);
    byIdentity.set(key, existing ? { ...existing, ...part, price_ex_vat: part.price_ex_vat ?? existing.price_ex_vat } : part);
  }
  return { parts: [...byIdentity.values()], skipped, sheets: sheetSummary };
}

async function importParts(buffer, { make, model, source = 'dealer_list', db = pgDb }) {
  // 'catalogue' is the OCR'd manufacturer book, which predates the uniqueness
  // rule and keeps its duplicates; an import must be its own source.
  if (source === 'catalogue') throw new Error('Imported lists need their own source name');
  const parsed = parseWorkbook(buffer, { make, model });
  if (!parsed.parts.length) {
    return { ...parsed, added: 0, updated: 0, error: 'No parts found in that spreadsheet' };
  }

  let added = 0;
  let updated = 0;
  for (const part of parsed.parts) {
    const { rows } = await db.query(
      `INSERT INTO parts_catalog
         (make, model, group_code, group_name, ref_no, part_number, description,
          status, supersedes, alternate_part_number, price_ex_vat, is_kit, source, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW())
       ON CONFLICT (make, model, part_number, source, COALESCE(ref_no, ''), COALESCE(group_code, ''))
         WHERE source <> 'catalogue'
       DO UPDATE SET description = EXCLUDED.description, group_name = EXCLUDED.group_name,
                     status = EXCLUDED.status, supersedes = EXCLUDED.supersedes,
                     alternate_part_number = EXCLUDED.alternate_part_number,
                     price_ex_vat = COALESCE(EXCLUDED.price_ex_vat, parts_catalog.price_ex_vat),
                     is_kit = EXCLUDED.is_kit, updated_at = NOW()
       RETURNING (xmax = 0) AS inserted`,
      [part.make, part.model, part.group_code, part.group_name, part.ref_no, part.part_number,
        part.description, part.status, part.supersedes, part.alternate_part_number,
        part.price_ex_vat, part.is_kit, source]);
    if (rows[0]?.inserted) added += 1; else updated += 1;
  }
  return { ...parsed, added, updated, total: parsed.parts.length };
}

// Search that works with what a technician has in front of them: a part number
// with or without dashes, a description, or the old number printed on the part
// that came off the bike.
async function searchParts({ q, make = null, model = null, limit = 50, offset = 0, db = pgDb }) {
  const text = String(q || '').trim();
  if (text.length < 2) return { results: [], total: 0 };

  // A technician types what the part is called on the floor, which is rarely
  // what the manufacturer calls it in the book: "brake pads" against "KIT,
  // BRAKE SHOE". Each word is matched separately and rows are ranked by how
  // many words they match, so a partly-right phrase still finds the part
  // instead of returning nothing.
  const words = text.toLowerCase().split(/[\s,]+/).filter((w) => w.length >= 2);
  const plain = text.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const params = [];
  const matches = [];

  for (const word of words.length ? words : [text.toLowerCase()]) {
    params.push(`%${word}%`);
    const i = params.length;
    matches.push(`(LOWER(p.description) LIKE $${i} OR LOWER(p.group_name) LIKE $${i}
                  OR LOWER(COALESCE(sched.description, '')) LIKE $${i})`);
  }
  params.push(`%${plain}%`);
  const numberMatch = `(UPPER(REGEXP_REPLACE(p.part_number, '[^A-Za-z0-9]', '', 'g')) LIKE $${params.length}
      OR UPPER(REGEXP_REPLACE(COALESCE(p.supersedes, ''), '[^A-Za-z0-9]', '', 'g')) LIKE $${params.length}
      OR UPPER(REGEXP_REPLACE(COALESCE(p.alternate_part_number, ''), '[^A-Za-z0-9]', '', 'g')) LIKE $${params.length})`;

  // How many of the typed words this row matches — the ranking, and the filter.
  const score = `(${matches.map((m) => `CASE WHEN ${m} THEN 1 ELSE 0 END`).join(' + ')})`;
  const where = [`(${score} > 0 OR ${numberMatch})`];
  if (make) { params.push(make); where.push(`LOWER(p.make) = LOWER($${params.length})`); }
  if (model) { params.push(model); where.push(`LOWER(p.model) = LOWER($${params.length})`); }

  // The service schedule's own wording for a part ("Brake Pads Front") is
  // searchable too, and comes back so a technician sees the name they know.
  const from = `parts_catalog p
     LEFT JOIN LATERAL (
       SELECT description FROM service_schedule_parts ssp
        WHERE UPPER(REGEXP_REPLACE(ssp.part_number, '[^A-Za-z0-9]', '', 'g'))
            = UPPER(REGEXP_REPLACE(p.part_number, '[^A-Za-z0-9]', '', 'g'))
        LIMIT 1
     ) sched ON TRUE`;

  const { rows: [count] } = await db.query(
    `SELECT COUNT(*)::int AS total FROM ${from} WHERE ${where.join(' AND ')}`, params);
  params.push(plain, Math.min(Number(limit) || 50, 200), Math.max(Number(offset) || 0, 0));
  const { rows } = await db.query(
    `SELECT p.id, p.make, p.model, p.group_code, p.group_name, p.ref_no, p.part_number, p.description,
            p.remark, p.qty_required, p.diagram_image_path, p.price_ex_vat, p.status, p.supersedes,
            p.alternate_part_number, p.is_kit, p.source, sched.description AS schedule_name,
            ${score} AS words_matched
       FROM ${from}
      WHERE ${where.join(' AND ')}
      ORDER BY
        -- an exact part number first; then the priced dealer list ahead of the
        -- older OCR'd catalogue, since the same part can be in both and only
        -- the dealer list can be ordered against; then by how much of what was
        -- typed the row matches, then kits, then by name
        (UPPER(REGEXP_REPLACE(p.part_number, '[^A-Za-z0-9]', '', 'g')) = $${params.length - 2}) DESC,
        ${score} DESC, (p.price_ex_vat IS NOT NULL) DESC, p.is_kit DESC, p.description
      LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  return { results: rows, total: count.total };
}

// The catalogue entries closest to a part number that isn't in it — for the
// case where a schedule and a price list disagree by a character (the Eco 150
// schedule's spark plug 31916KRM4099S against the list's 31916KRM84099S).
// Offered as a question, never applied: Hero supply against the number asked
// for, so guessing would turn a typo into a rejected order.
async function nearestParts(partNumber, { make = null, model = null, db = pgDb } = {}) {
  const plain = String(partNumber || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (plain.length < 5) return [];
  const params = [`${plain.slice(0, 5)}%`, `%${plain.slice(-4)}`];
  const where = [`(UPPER(REGEXP_REPLACE(part_number, '[^A-Za-z0-9]', '', 'g')) LIKE $1
                   OR UPPER(REGEXP_REPLACE(part_number, '[^A-Za-z0-9]', '', 'g')) LIKE $2)`,
    `price_ex_vat IS NOT NULL`];
  if (make) { params.push(make); where.push(`LOWER(make) = LOWER($${params.length})`); }
  if (model) { params.push(model); where.push(`LOWER(model) = LOWER($${params.length})`); }
  const { rows } = await db.query(
    `SELECT part_number, description, price_ex_vat FROM parts_catalog
      WHERE ${where.join(' AND ')} ORDER BY part_number LIMIT 25`, params);

  // Closest first: how much of the number is shared, front and back.
  const shared = (a, b, reverse) => {
    const x = reverse ? [...a].reverse().join('') : a;
    const y = reverse ? [...b].reverse().join('') : b;
    let i = 0;
    while (i < x.length && i < y.length && x[i] === y[i]) i += 1;
    return i;
  };
  return rows
    .map((row) => {
      const candidate = row.part_number.toUpperCase().replace(/[^A-Z0-9]/g, '');
      return { ...row, closeness: shared(plain, candidate, false) + shared(plain, candidate, true) };
    })
    .sort((a, z) => z.closeness - a.closeness)
    .slice(0, 3);
}

module.exports = { importParts, parseWorkbook, searchParts, nearestParts, parsePrice };
