'use strict';

// Ordering parts from Hero, the way Hero asks for them.
//
// Their dealer SOP: orders by email only, on their RFQ form, with the exact
// OEM part numbers — no part numbers, no quotation. So this gathers what the
// workshop actually needs, turns it into a request for quotation on their own
// template, and tracks what comes back.
//
// What the workshop needs is not a guess: bikes whose service is due have a
// published parts list for the kilometres they are on (services/servicePlan.js),
// and open job cards carry the parts a technician has already asked for. Both
// are gathered, added up per part number, and anything already on an open
// order is left off so the same part isn't ordered twice.

const fs = require('fs');
const path = require('path');
const pgDb = require('../pgDb');
const { fillTemplate } = require('./xlsxWriter');
const { servicePlanFor } = require('./servicePlan');
const { bikesDueForService } = require('./serviceDue');

const TEMPLATE_PATH = path.join(__dirname, '..', '..', 'assets', 'hero-rfq-template.xlsx');
const SUPPLIER_EMAIL = process.env.HERO_PARTS_EMAIL || 'parts@heromotorcycles.co.za';

// Where the finished form says to send the quote back to.
const DEALER = {
  name: process.env.DEALER_NAME || 'OnFleet Africa',
  contact: process.env.DEALER_CONTACT || 'Workshop Manager',
  email: process.env.DEALER_EMAIL || 'workshop@onfleet.africa',
  phone: process.env.DEALER_PHONE || '010 141 1165',
  address: process.env.DEALER_ADDRESS || 'Johannesburg, Gauteng',
  vat: process.env.DEALER_VAT || '',
};

// Cells on Hero's RFQ form. Their template, their layout — the form is filled
// in, never redrawn, so what lands in their inbox is the document they asked
// for. Row 19 is the header; lines run from row 21.
const RFQ_CELLS = {
  date: 'G5', quoteDueBy: 'G7', deliveryDate: 'G8',
  dealerName: 'B13', contactPerson: 'B14', email: 'B15', telephone: 'B16', address: 'B17', vat: 'B18',
  attention: 'G17', contact: 'G18',
};
const FIRST_ITEM_ROW = 21;
const TEMPLATE_ITEM_ROWS = 40;

const OPEN_ORDER_STATUSES = ['draft', 'sent', 'quoted', 'ordered'];
const isoDay = (d) => d.toISOString().slice(0, 10);
const plain = (value) => String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

async function nextReference(db = pgDb) {
  const year = new Date().getFullYear();
  const { rows } = await db.query(
    `SELECT reference FROM parts_orders WHERE reference LIKE $1 ORDER BY id DESC LIMIT 1`, [`RFQ-${year}-%`]);
  const last = rows[0] ? Number(String(rows[0].reference).split('-').pop()) : 0;
  return `RFQ-${year}-${String(last + 1).padStart(4, '0')}`;
}

// Part numbers already on an order that hasn't been received yet.
async function alreadyOnOrder(db = pgDb) {
  const { rows } = await db.query(
    `SELECT UPPER(REGEXP_REPLACE(i.part_number, '[^A-Za-z0-9]', '', 'g')) AS key, SUM(i.qty)::int AS qty
       FROM parts_order_items i JOIN parts_orders o ON o.id = i.order_id
      WHERE o.status = ANY($1) GROUP BY 1`, [OPEN_ORDER_STATUSES]);
  return new Map(rows.map((r) => [r.key, r.qty]));
}

// Everything the workshop needs but hasn't got on order.
async function suggestOrder({ make = 'Hero', model = 'Eco 150', db = pgDb } = {}) {
  const onOrder = await alreadyOnOrder(db);
  const needs = new Map(); // part number → line

  const add = (part, { qty = 1, reason, bikeId = null, jobCardId = null, bikeModel }) => {
    const key = plain(part.part_number);
    if (!key) return;
    const line = needs.get(key) || {
      part_number: part.part_number,
      description: part.description || part.catalogue_description || '',
      qty: 0,
      bike_model: bikeModel,
      unit_price_ex_vat: part.price_ex_vat ?? null,
      reasons: [],
      bikes: [],
      job_cards: [],
    };
    line.qty += qty;
    if (line.unit_price_ex_vat == null && part.price_ex_vat != null) line.unit_price_ex_vat = part.price_ex_vat;
    if (!line.reasons.includes(reason)) line.reasons.push(reason);
    if (bikeId && !line.bikes.includes(bikeId)) line.bikes.push(bikeId);
    if (jobCardId && !line.job_cards.includes(jobCardId)) line.job_cards.push(jobCardId);
    needs.set(key, line);
  };

  // 1. Bikes whose service is due — what the schedule says to fit at their
  //    current kilometres.
  const due = (await bikesDueForService()).filter((b) => (b.make || '').toLowerCase() === make.toLowerCase()
    && (b.model || '').toLowerCase() === model.toLowerCase());
  const services = [];
  for (const bike of due) {
    const plan = await servicePlanFor({ make, model, odometerKm: bike.odometer_km || 0, bikeId: bike.id, db });
    if (!plan.has_schedule) continue;
    services.push({ bike, plan });
    for (const part of plan.parts_due) {
      add(part, { qty: part.qty || 1, reason: 'Service due', bikeId: bike.id, bikeModel: `${make} ${model}` });
    }
  }

  // 2. Parts a technician has already put on an open job card.
  const { rows: jobParts } = await db.query(
    `SELECT jci.id, jci.job_card_id, jci.part_number, jci.description, jci.quantity, jc.bike_id,
            jc.make, jc.model, jc.registration
       FROM job_card_items jci
       JOIN job_cards jc ON jc.id = jci.job_card_id
      WHERE jci.item_type = 'part' AND jci.part_number IS NOT NULL
        AND jc.status IN ('open', 'in_progress') AND jci.ordered_in IS NULL`);
  for (const item of jobParts) {
    add({ part_number: item.part_number, description: item.description },
      { qty: Number(item.quantity) || 1, reason: 'On a job card', bikeId: item.bike_id, jobCardId: item.job_card_id,
        bikeModel: [item.make, item.model].filter(Boolean).join(' ') || `${make} ${model}` });
  }

  // Prices and current part numbers from the dealer catalogue: ordering a
  // superseded number gets the order rejected.
  const keys = [...needs.keys()];
  if (keys.length) {
    const { rows } = await db.query(
      `SELECT UPPER(REGEXP_REPLACE(part_number, '[^A-Za-z0-9]', '', 'g')) AS key,
              part_number, description, price_ex_vat, status, supersedes
         FROM parts_catalog
        WHERE UPPER(REGEXP_REPLACE(part_number, '[^A-Za-z0-9]', '', 'g')) = ANY($1)
           OR UPPER(REGEXP_REPLACE(COALESCE(supersedes, ''), '[^A-Za-z0-9]', '', 'g')) = ANY($1)`, [keys]);
    for (const row of rows) {
      const direct = needs.get(row.key);
      if (direct) {
        // The supplier's own wording goes on the form — their parts desk picks
        // against their catalogue, and "Brake Pads Front" is our name for what
        // they call "KIT, BRAKE SHOE".
        if (row.description) {
          if (direct.description && direct.description !== row.description) direct.our_name = direct.description;
          direct.description = row.description;
        }
        if (direct.unit_price_ex_vat == null) direct.unit_price_ex_vat = row.price_ex_vat == null ? null : Number(row.price_ex_vat);
        direct.in_catalogue = true;
        continue;
      }
      // The need is recorded against the number this part replaces
      const old = needs.get(plain(row.supersedes));
      if (old) {
        old.replaced_by = row.part_number;
        old.note = `${old.part_number} has been replaced by ${row.part_number}`;
      }
    }
  }

  const lines = [...needs.values()].map((line) => {
    const already = onOrder.get(plain(line.part_number)) || 0;
    return { ...line, already_on_order: already, qty_to_order: Math.max(0, line.qty - already) };
  }).filter((line) => line.qty_to_order > 0)
    .sort((a, z) => z.qty_to_order - a.qty_to_order || a.description.localeCompare(z.description));

  // A line the price list doesn't carry can't be ordered as it stands, so the
  // nearest entries come with it — usually the manufacturer's own documents
  // disagreeing by a character.
  const { nearestParts } = require('./partsImport');
  for (const line of lines) {
    if (line.in_catalogue) continue;
    line.did_you_mean = await nearestParts(line.part_number, { make, model, db });
  }

  return {
    make,
    model,
    lines,
    total_ex_vat: +lines.reduce((sum, l) => sum + (l.unit_price_ex_vat || 0) * l.qty_to_order, 0).toFixed(2),
    bikes_due: services.length,
    job_cards: [...new Set(jobParts.map((j) => j.job_card_id))].length,
    not_in_catalogue: lines.filter((l) => !l.in_catalogue).map((l) => l.part_number),
  };
}

// Which of these part numbers the supplier actually sells. Hero quote and ship
// against the exact number requested — "no quotations will be issued if the OEM
// part numbers are not supplied in RFQ" — so a number that isn't in their price
// list is a rejected line and a bike waiting for a part that was never coming.
async function checkAgainstPriceList(lines, { make, model, db = pgDb } = {}) {
  const numbers = [...new Set(lines.map((l) => plain(l.part_number)).filter(Boolean))];
  if (!numbers.length) return { known: new Set(), blocked: [] };

  const { rows } = await db.query(
    `SELECT UPPER(REGEXP_REPLACE(part_number, '[^A-Za-z0-9]', '', 'g')) AS key
       FROM parts_catalog
      WHERE source <> 'catalogue'
        AND UPPER(REGEXP_REPLACE(part_number, '[^A-Za-z0-9]', '', 'g')) = ANY($1)`, [numbers]);
  const known = new Set(rows.map((r) => r.key));

  const { nearestParts } = require('./partsImport');
  const blocked = [];
  for (const line of lines) {
    if (known.has(plain(line.part_number))) continue;
    if (line.override_reason) continue;
    blocked.push({
      part_number: line.part_number,
      description: line.description || null,
      did_you_mean: line.did_you_mean || await nearestParts(line.part_number, { make, model, db }),
    });
  }
  return { known, blocked };
}

async function createOrder({ lines, make = 'Hero', model = 'Eco 150', actorId = null, automatic = false,
  deliveryMethod = null, neededBy = null, notes = null, db = pgDb } = {}) {
  const usable = (lines || []).filter((l) => l.part_number && (l.qty_to_order || l.qty) > 0);
  if (!usable.length) return null;

  const { blocked } = await checkAgainstPriceList(usable, { make, model, db });
  if (blocked.length) return { blocked };

  const reference = await nextReference(db);
  const { rows } = await db.query(
    `INSERT INTO parts_orders (reference, supplier, supplier_email, make, model, created_by,
                               created_automatically, delivery_method, needed_by, notes)
     VALUES ($1, 'Hero SA', $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [reference, SUPPLIER_EMAIL, make, model, actorId, automatic, deliveryMethod, neededBy, notes]);
  const order = rows[0];

  for (const line of usable) {
    await db.query(
      `INSERT INTO parts_order_items (order_id, part_number, description, qty, bike_model,
                                      unit_price_ex_vat, job_card_id, bike_id, reason, override_reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [order.id, line.part_number, line.description || line.part_number, line.qty_to_order || line.qty,
        line.bike_model || `${make} ${model}`, line.unit_price_ex_vat ?? null,
        line.job_cards?.[0] || line.job_card_id || null, line.bikes?.[0] || line.bike_id || null,
        (line.reasons || []).join(', ') || line.reason || null,
        line.override_reason || null]);
    if (line.job_cards?.length) {
      await db.query(`UPDATE job_card_items SET ordered_in = $1
                       WHERE job_card_id = ANY($2) AND part_number = $3 AND ordered_in IS NULL`,
        [order.id, line.job_cards, line.part_number]);
    }
  }
  return getOrder(order.id, db);
}

async function getOrder(orderId, db = pgDb) {
  const { rows } = await db.query(
    `SELECT o.*, u.full_name AS created_by_name, s.full_name AS sent_by_name
       FROM parts_orders o
       LEFT JOIN users u ON u.id = o.created_by
       LEFT JOIN users s ON s.id = o.sent_by
      WHERE o.id = $1`, [orderId]);
  const order = rows[0];
  if (!order) return null;
  const { rows: items } = await db.query(
    `SELECT i.*, b.registration FROM parts_order_items i
       LEFT JOIN bikes b ON b.id = i.bike_id
      WHERE i.order_id = $1 ORDER BY i.id`, [orderId]);
  const total = items.reduce((sum, i) => sum + (Number(i.unit_price_ex_vat) || 0) * i.qty, 0);
  return { ...order, items, total_ex_vat: +total.toFixed(2) };
}

// The order as Hero's own RFQ form, ready to attach to an email.
function renderRfq(order, { dealer = DEALER, today = new Date() } = {}) {
  const template = fs.readFileSync(TEMPLATE_PATH);
  const quoteDue = new Date(today.getTime() + 2 * 86400000);
  const delivery = order.needed_by ? new Date(order.needed_by) : new Date(today.getTime() + 7 * 86400000);

  const values = {
    [RFQ_CELLS.date]: isoDay(today),
    [RFQ_CELLS.quoteDueBy]: isoDay(quoteDue),
    [RFQ_CELLS.deliveryDate]: isoDay(delivery),
    [RFQ_CELLS.dealerName]: dealer.name,
    [RFQ_CELLS.contactPerson]: dealer.contact,
    [RFQ_CELLS.email]: dealer.email,
    [RFQ_CELLS.telephone]: dealer.phone,
    [RFQ_CELLS.address]: order.delivery_address || dealer.address,
    [RFQ_CELLS.vat]: dealer.vat,
    [RFQ_CELLS.attention]: 'Parts Department',
    [RFQ_CELLS.contact]: dealer.contact,
  };

  order.items.forEach((item, index) => {
    const row = FIRST_ITEM_ROW + index;
    if (index >= TEMPLATE_ITEM_ROWS) values[`A${row}`] = String(index + 1); // past the form's own numbering
    values[`B${row}`] = item.part_number;
    values[`C${row}`] = item.description;
    values[`D${row}`] = item.qty;
    values[`E${row}`] = item.bike_model || `${order.make} ${order.model}`;
  });

  return fillTemplate(template, values);
}

function rfqFileName(order) {
  return `${order.reference}-${(order.supplier || 'supplier').replace(/\s+/g, '-')}.xlsx`;
}

// The covering email. Their SOP asks for the delivery term to be stated, so it
// is, and for back orders to be answered — which is why the quote reference
// comes back onto the order rather than into somebody's inbox.
function rfqEmailBody(order, { dealer = DEALER } = {}) {
  const delivery = {
    collect: 'We will collect from your Sandton premises.',
    courier_hero: 'Please arrange courier delivery to our address and include the cost in your quotation.',
    courier_own: 'We will arrange our own courier for collection.',
  }[order.delivery_method] || 'Please advise on collection and courier options.';

  return `Good day\n\nPlease find attached our request for quotation ${order.reference} `
    + `for ${order.items.length} line${order.items.length === 1 ? '' : 's'} `
    + `(${order.make} ${order.model}).\n\n${delivery}\n\n`
    + `${order.needed_by ? `We need these parts by ${isoDay(new Date(order.needed_by))}.\n\n` : ''}`
    + `${order.notes ? `${order.notes}\n\n` : ''}`
    + `Kind regards\n${dealer.contact}\n${dealer.name}\n${dealer.phone}\n${dealer.email}`;
}

async function markSent({ orderId, actorId, sentTo, db = pgDb }) {
  const { rows } = await db.query(
    `UPDATE parts_orders SET status = 'sent', sent_at = NOW(), sent_by = $1, sent_to = $2, updated_at = NOW()
      WHERE id = $3 AND status = 'draft' RETURNING *`, [actorId, sentTo, orderId]);
  return rows[0] || null;
}

async function setStatus({ orderId, status, quoteReference = null, quotedTotal = null, db = pgDb }) {
  const allowed = ['draft', 'sent', 'quoted', 'ordered', 'received', 'cancelled'];
  if (!allowed.includes(status)) throw new Error(`"${status}" is not a status an order can take`);
  const { rows } = await db.query(
    `UPDATE parts_orders
        SET status = $1,
            quote_reference = COALESCE($2, quote_reference),
            quoted_total_ex_vat = COALESCE($3, quoted_total_ex_vat),
            received_at = CASE WHEN $1 = 'received' THEN NOW() ELSE received_at END,
            updated_at = NOW()
      WHERE id = $4 RETURNING *`, [status, quoteReference, quotedTotal, orderId]);
  return rows[0] || null;
}

module.exports = {
  suggestOrder, createOrder, checkAgainstPriceList, getOrder, renderRfq, rfqFileName, rfqEmailBody, markSent, setStatus,
  nextReference, DEALER, SUPPLIER_EMAIL, RFQ_CELLS, FIRST_ITEM_ROW,
};
