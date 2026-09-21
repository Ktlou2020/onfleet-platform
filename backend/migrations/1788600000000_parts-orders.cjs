'use strict';

/**
 * Parts ordering, on the supplier's terms.
 *
 * Hero's dealer ordering SOP is specific: orders are only accepted by email,
 * on their RFQ form, with the exact OEM part numbers — "Hero SA will only
 * supply according to the part number requested by a dealer", and "no
 * quotations will be issued if the OEM part numbers are not supplied in RFQ".
 * So an order here is a request for quotation that carries part numbers,
 * quantities and the bike model, and then follows their flow: quote, accept or
 * amend or reject, purchase order, delivery or collection, back orders.
 *
 * The lines come from the work itself — bikes whose service is due, and parts
 * the workshop has put on open job cards — so nobody has to remember to order
 * until the bike is already stripped.
 */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS parts_orders (
      id SERIAL PRIMARY KEY,
      reference TEXT NOT NULL UNIQUE,
      supplier TEXT NOT NULL DEFAULT 'Hero SA',
      supplier_email TEXT,
      status TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'sent', 'quoted', 'ordered', 'received', 'cancelled')),
      make TEXT,
      model TEXT,
      delivery_method TEXT CHECK (delivery_method IN ('collect', 'courier_hero', 'courier_own')),
      delivery_address TEXT,
      needed_by DATE,
      notes TEXT,
      created_by INTEGER REFERENCES users(id),
      created_automatically BOOLEAN NOT NULL DEFAULT FALSE,
      sent_at TIMESTAMPTZ,
      sent_by INTEGER REFERENCES users(id),
      sent_to TEXT,
      quote_reference TEXT,
      quoted_total_ex_vat NUMERIC(12,2),
      received_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS parts_order_items (
      id SERIAL PRIMARY KEY,
      order_id INTEGER NOT NULL REFERENCES parts_orders(id) ON DELETE CASCADE,
      part_number TEXT NOT NULL,
      description TEXT NOT NULL,
      qty INTEGER NOT NULL CHECK (qty > 0),
      bike_model TEXT,
      unit_price_ex_vat NUMERIC(12,2),
      job_card_id INTEGER REFERENCES job_cards(id) ON DELETE SET NULL,
      bike_id INTEGER REFERENCES bikes(id) ON DELETE SET NULL,
      reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_parts_order_items_order ON parts_order_items(order_id);
    CREATE INDEX IF NOT EXISTS idx_parts_orders_status ON parts_orders(status, created_at DESC);
  `);

  // A job card's parts were free text, so what a technician fitted could never
  // be matched to a catalogue number — and therefore never ordered from one.
  pgm.sql(`ALTER TABLE job_card_items ADD COLUMN IF NOT EXISTS part_number TEXT;`);
  pgm.sql(`ALTER TABLE job_card_items ADD COLUMN IF NOT EXISTS ordered_in INTEGER REFERENCES parts_orders(id) ON DELETE SET NULL;`);
  pgm.sql(`CREATE INDEX IF NOT EXISTS idx_job_card_items_part_number ON job_card_items(part_number) WHERE part_number IS NOT NULL;`);
};

exports.down = (pgm) => {
  pgm.sql(`ALTER TABLE job_card_items DROP COLUMN IF EXISTS ordered_in;`);
  pgm.sql(`ALTER TABLE job_card_items DROP COLUMN IF EXISTS part_number;`);
  pgm.sql(`DROP TABLE IF EXISTS parts_order_items;`);
  pgm.sql(`DROP TABLE IF EXISTS parts_orders;`);
};
