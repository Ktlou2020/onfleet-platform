'use strict';

const pgDb = require('../pgDb');

// Stock, and the one door everything moves through.
//
// The ledger is the truth. parts_stock.on_hand is a cache of it, written in
// the same transaction as the movement that changes it, so a parts list can
// draw a row without adding up a year of history. A cache that can drift from
// its source is a bug waiting to happen, which is why every change goes
// through move() and why reconcile() exists to prove the two still agree.
//
// Nothing here decides whether a sale is allowed, who may adjust a count, or
// what a part costs. That is the route's business. This moves numbers and
// records why.

const VAT_RATE = 0.15;

/** The same normalisation the catalogue, the photographs and the import use. */
const partKey = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

const REASONS = ['sale', 'sale_void', 'receipt', 'fitted', 'fitted_removed', 'count', 'adjustment'];

/**
 * Move stock, and say why.
 *
 * `quantity` is signed: negative leaves the shelf, positive arrives on it.
 * One column rather than a quantity and a direction, because a direction that
 * can disagree with its sign is a bug waiting to be written.
 *
 * Takes a transaction client when it is part of something larger — a sale
 * moves several parts and writes a sale row, and half of that happening is
 * worse than none of it.
 */
async function move({ partNumber, locationId = null, quantity, reason, sourceType = null, sourceId = null, note = null, actorId = null, description = null, db = pgDb }) {
  if (!REASONS.includes(reason)) throw Object.assign(new Error(`Unknown reason: ${reason}`), { status: 400 });
  const qty = Number(quantity);
  if (!Number.isFinite(qty) || qty === 0) {
    throw Object.assign(new Error('A movement has to move something'), { status: 400 });
  }
  const key = partKey(partNumber);
  if (!key) throw Object.assign(new Error('Which part?'), { status: 400 });

  // The shelf row is created on first touch rather than needing a part to be
  // "set up" before it can be received or counted. A workshop that has to
  // register a part before it can put it on a shelf will keep its stock in a
  // notebook instead.
  const { rows } = await db.query(
    `INSERT INTO parts_stock (part_number, part_number_key, location_id, on_hand)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (part_number_key, location_id)
     DO UPDATE SET on_hand = parts_stock.on_hand + $4, updated_at = NOW()
     RETURNING id, on_hand`,
    [String(partNumber).trim(), key, locationId, qty]);

  await db.query(
    `INSERT INTO parts_stock_movements
       (part_number_key, location_id, quantity, reason, source_type, source_id, note, actor_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [key, locationId, qty, reason, sourceType, sourceId, note, actorId]);

  if (description) {
    await db.query(
      `INSERT INTO parts_pricing (part_number, part_number_key, description)
       VALUES ($1,$2,$3) ON CONFLICT (part_number_key)
       DO UPDATE SET description = COALESCE(parts_pricing.description, EXCLUDED.description)`,
      [String(partNumber).trim(), key, description]);
  }

  return { on_hand: Number(rows[0].on_hand), stock_id: rows[0].id };
}

/** What is on the shelf right now, from the cache. */
async function onHand(partNumber, locationId = null, db = pgDb) {
  const { rows } = await db.query(
    `SELECT on_hand FROM parts_stock WHERE part_number_key = $1 AND location_id IS NOT DISTINCT FROM $2`,
    [partKey(partNumber), locationId]);
  return rows[0] ? Number(rows[0].on_hand) : 0;
}

/**
 * Does the cache still agree with the ledger?
 *
 * Returns the rows where it does not. Should always be empty; a test asserts
 * it after a run of sales, receipts and voids, and an operator can call it
 * when a count comes out wrong and they want to know whether to believe the
 * screen.
 */
async function reconcile(db = pgDb) {
  const { rows } = await db.query(`
    SELECT s.part_number, s.location_id, s.on_hand,
           COALESCE(m.total, 0)::numeric AS ledger
      FROM parts_stock s
      LEFT JOIN (
        SELECT part_number_key, location_id, SUM(quantity) AS total
          FROM parts_stock_movements GROUP BY part_number_key, location_id
      ) m ON m.part_number_key = s.part_number_key
         AND m.location_id IS NOT DISTINCT FROM s.location_id
     WHERE s.on_hand <> COALESCE(m.total, 0)`);
  return rows;
}

/** Ex-VAT, VAT and total for a set of sale lines. */
function priceLines(lines) {
  const subtotal = lines.reduce((sum, l) => sum + Number(l.quantity) * Number(l.unit_price_ex_vat), 0);
  const cost = lines.reduce((sum, l) => sum + Number(l.quantity) * Number(l.unit_cost_ex_vat || 0), 0);
  const vat = +(subtotal * VAT_RATE).toFixed(2);
  return {
    subtotal_ex_vat: +subtotal.toFixed(2),
    vat,
    total: +(subtotal + vat).toFixed(2),
    cost_total_ex_vat: +cost.toFixed(2),
  };
}

/**
 * What a part costs and sells for.
 *
 * Falls back to the Hero catalogue for cost where nobody has set one, because
 * 860 parts arrived with a list price and making somebody type each one in
 * before the margin works would mean the margin never works.
 */
async function priceFor(partNumber, db = pgDb) {
  const key = partKey(partNumber);
  const { rows } = await db.query(
    `SELECT p.part_number, p.description, p.cost_price_ex_vat, p.sell_price_ex_vat,
            c.price_ex_vat AS catalogue_price, c.description AS catalogue_description
       FROM (SELECT $1::text AS k) q
       LEFT JOIN parts_pricing p ON p.part_number_key = q.k
       LEFT JOIN LATERAL (
         SELECT price_ex_vat, description FROM parts_catalog
          WHERE UPPER(REGEXP_REPLACE(part_number, '[^A-Za-z0-9]', '', 'g')) = q.k
            AND price_ex_vat IS NOT NULL
          ORDER BY id LIMIT 1
       ) c ON TRUE`, [key]);
  const r = rows[0] || {};
  return {
    description: r.description || r.catalogue_description || null,
    cost_price_ex_vat: r.cost_price_ex_vat != null ? Number(r.cost_price_ex_vat)
      : (r.catalogue_price != null ? Number(r.catalogue_price) : null),
    sell_price_ex_vat: r.sell_price_ex_vat != null ? Number(r.sell_price_ex_vat) : null,
    cost_is_catalogue: r.cost_price_ex_vat == null && r.catalogue_price != null,
  };
}

module.exports = { move, onHand, reconcile, priceLines, priceFor, partKey, VAT_RATE, REASONS };
