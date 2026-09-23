'use strict';

const pgDb = require('../pgDb');

// Photographs of parts, keyed on the part number rather than a catalogue row.
//
// See the migration for why. The short version: the same physical part exists
// as two rows — the OCR'd manufacturer book and the priced dealer list — and
// the search shows the priced one. A photo hung on a row id would be invisible
// about half the time.

/**
 * The same normalisation the catalogue's own index uses:
 * UPPER(REGEXP_REPLACE(part_number, '[^A-Za-z0-9]', '', 'g')).
 *
 * 15410-KWB-601 and 15410KWB601 are one part, and a technician typing either
 * should see the same photograph.
 */
function partKey(partNumber) {
  return String(partNumber || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** How a stored photo is addressed over HTTP. */
function photoUrl(filePath) {
  return `/uploads/part-photos/${String(filePath).replace(/\\/g, '/')}`;
}

function shape(row) {
  return {
    id: row.id,
    part_number: row.part_number,
    url: photoUrl(row.file_path),
    caption: row.caption || null,
    created_at: row.created_at,
    created_by: row.created_by,
    taken_by: row.taken_by || null,
  };
}

/**
 * Every photo for a set of part numbers on one model, as a map keyed by the
 * normalised number.
 *
 * Asked for the whole result page at once rather than per row: a parts search
 * returns up to sixty rows, and sixty round trips to decorate a list is how a
 * picker becomes unusable on a phone.
 */
async function photosForParts({ make, model, partNumbers, db = pgDb }) {
  const keys = [...new Set((partNumbers || []).map(partKey).filter(Boolean))];
  if (!keys.length) return {};

  const { rows } = await db.query(
    `SELECT p.*, u.full_name AS taken_by
       FROM part_photos p
       LEFT JOIN users u ON u.id = p.created_by
      WHERE LOWER(p.make) = LOWER($1) AND LOWER(p.model) = LOWER($2)
        AND p.part_number_key = ANY($3)
      ORDER BY p.created_at DESC`,
    [make || '', model || '', keys]);

  const byKey = {};
  for (const row of rows) {
    (byKey[row.part_number_key] ||= []).push(shape(row));
  }
  return byKey;
}

/** Every photo of one part, newest first. */
async function photosForPart({ make, model, partNumber, db = pgDb }) {
  const byKey = await photosForParts({ make, model, partNumbers: [partNumber], db });
  return byKey[partKey(partNumber)] || [];
}

/**
 * File a photograph against a part.
 *
 * `clientRequestId` is set by a phone replaying an upload it queued while
 * offline. The same id twice stores one photograph: a request that reached
 * the server and lost its reply looks exactly like one that never arrived,
 * and the unique index is what tells them apart rather than a check that
 * somebody has to remember to write.
 */
async function addPhoto({ make, model, partNumber, filePath, originalName, caption, userId, clientRequestId = null, db = pgDb }) {
  const key = partKey(partNumber);
  if (!key) throw new Error('A part number is needed to file a photograph against');

  const { rows } = await db.query(
    `INSERT INTO part_photos (make, model, part_number, part_number_key, file_path, original_name, caption, created_by, client_request_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (client_request_id) WHERE client_request_id IS NOT NULL DO NOTHING
     RETURNING *`,
    [make, model, String(partNumber).toUpperCase(), key, filePath, originalName || null, caption || null, userId || null, clientRequestId]);

  if (rows[0]) return shape(rows[0]);

  // Nothing inserted means this exact upload is already stored. Hand back what
  // is there, so the phone sees the success it actually got.
  const { rows: existing } = await db.query(
    'SELECT * FROM part_photos WHERE client_request_id = $1', [clientRequestId]);
  if (!existing[0]) throw new Error('Could not store that photograph');
  return shape(existing[0]);
}

async function deletePhoto(id, db = pgDb) {
  const { rows } = await db.query('DELETE FROM part_photos WHERE id = $1 RETURNING file_path', [id]);
  return rows[0] || null;
}

/**
 * The parts this workshop actually fits, most-used first.
 *
 * With thousands of parts in the book, search is the fallback and this is the
 * shortcut: a workshop turns over the same few dozen parts, and the one a
 * technician wants is usually one they fitted last week. Counted from real
 * job cards rather than guessed.
 *
 * Scoped to the bike's model, because a part that is common on an ACE 125 is
 * irrelevant on anything else.
 */
async function mostFitted({ make, model, limit = 12, db = pgDb }) {
  const { rows } = await db.query(
    `SELECT jci.part_number,
            COUNT(*)::int AS times_fitted,
            MAX(jc.created_at) AS last_fitted_at,
            (ARRAY_AGG(jci.description ORDER BY jc.created_at DESC))[1] AS description,
            (ARRAY_AGG(jci.unit_cost ORDER BY jc.created_at DESC))[1] AS last_cost
       FROM job_card_items jci
       JOIN job_cards jc ON jc.id = jci.job_card_id
      WHERE jci.part_number IS NOT NULL AND jci.part_number <> ''
        AND ($1::text IS NULL OR LOWER(jc.make) = LOWER($1))
        AND ($2::text IS NULL OR LOWER(jc.model) = LOWER($2))
      GROUP BY jci.part_number
      ORDER BY times_fitted DESC, last_fitted_at DESC
      LIMIT $3`,
    [make || null, model || null, limit]);

  const byKey = await photosForParts({
    make, model, partNumbers: rows.map((r) => r.part_number), db,
  });

  return rows.map((r) => ({
    part_number: r.part_number,
    description: r.description,
    times_fitted: r.times_fitted,
    last_fitted_at: r.last_fitted_at,
    last_cost: r.last_cost == null ? null : Number(r.last_cost),
    photos: byKey[partKey(r.part_number)] || [],
  }));
}

module.exports = { partKey, photoUrl, photosForParts, photosForPart, addPhoto, deletePhoto, mostFitted };
