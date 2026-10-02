'use strict';

// The dealership half of the workshop.
//
// Until now a part could only leave the building fitted to a motorcycle on a
// job card. Anything sold across the counter — which is a real part of this
// business — was recorded nowhere, and there was no notion of stock at all:
// no on-hand, no reorder level, and no buy price to set against a sell price.
// So "how much did we make on parts" could only ever be guessed at, and "what
// is running low" could not be asked.
//
// Four ideas, kept apart on purpose:
//
//   pricing    what a part costs us and what we sell it for. One answer per
//              part, because two branches quoting different prices for the
//              same part is a thing a business decides to do, not a thing a
//              schema should assume.
//   stock      how many are on a shelf, and which shelf. Per location,
//              because stock is physical and OnFix having six does not help
//              anyone standing in Bikerhouse.
//   movements  every reason a number changed: sold, received, fitted,
//              counted. This is the truth; on_hand is a cache of it.
//   sales      what went out of the door, to whom, and what it cost us at the
//              moment it went — so last year's margin stays last year's
//              margin when this year's prices change.
//
// The movements ledger is why this is worth doing properly rather than
// keeping a number and decrementing it. A number that drifts cannot be
// argued with; a ledger can be added up and compared, which is what the
// reconcile test does.

exports.up = (pgm) => {
  // ---------------------------------------------------------------- pricing
  pgm.createTable('parts_pricing', {
    id: 'id',
    part_number: { type: 'text', notNull: true },
    // The same normalisation the catalogue and the photographs already use:
    // 15410-KWB-601 and 15410KWB601 are one part.
    part_number_key: { type: 'text', notNull: true },
    description: { type: 'text' },
    cost_price_ex_vat: { type: 'numeric(12,2)', comment: 'What we pay for it' },
    sell_price_ex_vat: { type: 'numeric(12,2)', comment: 'What we charge for it' },
    updated_by: { type: 'integer', references: 'users', onDelete: 'SET NULL' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
  });
  pgm.createIndex('parts_pricing', 'part_number_key', { unique: true });

  // ------------------------------------------------------------------ stock
  pgm.createTable('parts_stock', {
    id: 'id',
    part_number: { type: 'text', notNull: true },
    part_number_key: { type: 'text', notNull: true },
    location_id: {
      type: 'integer',
      references: 'workshop_locations',
      onDelete: 'CASCADE',
      comment: 'Which workshop the shelf is in',
    },
    // A cache of the movements below, written in the same transaction as the
    // movement that changes it. The ledger is the truth; this is so a parts
    // list does not have to add up a year of history to draw one row.
    on_hand: { type: 'numeric(12,2)', notNull: true, default: 0 },
    reorder_level: { type: 'numeric(12,2)', notNull: true, default: 0 },
    bin: { type: 'text', comment: 'Where on the shelf' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
  });
  // NULLS NOT DISTINCT, and the whole feature turns on it.
  //
  // location_id is null for the main shelf, and Postgres treats nulls in a
  // unique index as distinct from one another by default. With the ordinary
  // index, ON CONFLICT (part_number_key, location_id) never matched a row
  // whose location was null — so every sale, receipt and count inserted
  // another row for the same part instead of updating the one that was there,
  // and on_hand read whichever one was found first. The ledger caught it: the
  // movements added up to the truth while the shelf said something else.
  pgm.sql(`CREATE UNIQUE INDEX parts_stock_part_location_unique
             ON parts_stock (part_number_key, location_id) NULLS NOT DISTINCT`);
  // Drawing the "what is low" list is the whole point of reorder_level, so it
  // gets an index rather than a sequential scan of the catalogue.
  pgm.createIndex('parts_stock', ['location_id', 'on_hand']);

  // -------------------------------------------------------------- movements
  pgm.createTable('parts_stock_movements', {
    id: 'id',
    part_number_key: { type: 'text', notNull: true },
    location_id: { type: 'integer', references: 'workshop_locations', onDelete: 'CASCADE' },
    // Signed: negative leaves the shelf, positive arrives on it. One column
    // rather than a quantity and a direction, because a direction that can
    // disagree with its sign is a bug waiting to be written.
    quantity: { type: 'numeric(12,2)', notNull: true },
    reason: { type: 'text', notNull: true },
    source_type: { type: 'text', comment: 'parts_sales, parts_orders, job_cards, adjustment' },
    source_id: { type: 'integer' },
    note: { type: 'text' },
    actor_id: { type: 'integer', references: 'users', onDelete: 'SET NULL' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
  });
  pgm.addConstraint('parts_stock_movements', 'parts_stock_movements_reason_check',
    "CHECK (reason IN ('sale', 'sale_void', 'receipt', 'fitted', 'fitted_removed', 'count', 'adjustment'))");
  pgm.createIndex('parts_stock_movements', ['part_number_key', 'location_id', 'created_at']);
  pgm.createIndex('parts_stock_movements', ['source_type', 'source_id']);

  // ------------------------------------------------------------------ sales
  pgm.createTable('parts_sales', {
    id: 'id',
    reference: { type: 'text', notNull: true },
    location_id: { type: 'integer', references: 'workshop_locations', onDelete: 'SET NULL' },
    // Two ways a part is sold, and they are not the same transaction.
    //
    //   counter  somebody walks in, pays, and leaves with it. There may be no
    //            name attached and that is fine — a cash sale to a stranger
    //            is still a sale, and demanding an account would mean the
    //            till never gets used.
    //   account  a fleet we invoice. The organisation is who owes us.
    channel: { type: 'text', notNull: true },
    organization_id: { type: 'integer', references: 'organizations', onDelete: 'SET NULL' },
    customer_name: { type: 'text' },
    customer_phone: { type: 'text' },
    payment_method: { type: 'text' },
    status: { type: 'text', notNull: true, default: 'completed' },
    subtotal_ex_vat: { type: 'numeric(12,2)', notNull: true, default: 0 },
    vat: { type: 'numeric(12,2)', notNull: true, default: 0 },
    total: { type: 'numeric(12,2)', notNull: true, default: 0 },
    // What the goods cost us at the moment they went out. Snapshotted rather
    // than looked up later, so last year's margin stays last year's margin
    // when this year's prices change.
    cost_total_ex_vat: { type: 'numeric(12,2)', notNull: true, default: 0 },
    note: { type: 'text' },
    sold_by: { type: 'integer', references: 'users', onDelete: 'SET NULL' },
    sold_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
    voided_at: { type: 'timestamptz' },
    voided_by: { type: 'integer', references: 'users', onDelete: 'SET NULL' },
    void_reason: { type: 'text' },
  });
  pgm.addConstraint('parts_sales', 'parts_sales_channel_check',
    "CHECK (channel IN ('counter', 'account'))");
  pgm.addConstraint('parts_sales', 'parts_sales_status_check',
    "CHECK (status IN ('completed', 'void'))");
  // An account sale has to say whose account.
  pgm.addConstraint('parts_sales', 'parts_sales_account_has_customer',
    "CHECK (channel <> 'account' OR organization_id IS NOT NULL)");
  pgm.createIndex('parts_sales', 'reference', { unique: true });
  pgm.createIndex('parts_sales', ['sold_at']);
  pgm.createIndex('parts_sales', ['organization_id', 'sold_at']);

  pgm.createTable('parts_sale_items', {
    id: 'id',
    sale_id: { type: 'integer', notNull: true, references: 'parts_sales', onDelete: 'CASCADE' },
    part_number: { type: 'text', notNull: true },
    part_number_key: { type: 'text', notNull: true },
    description: { type: 'text', notNull: true },
    quantity: { type: 'numeric(12,2)', notNull: true },
    unit_price_ex_vat: { type: 'numeric(12,2)', notNull: true },
    unit_cost_ex_vat: { type: 'numeric(12,2)', notNull: true, default: 0 },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('NOW()') },
  });
  pgm.createIndex('parts_sale_items', 'sale_id');
  pgm.createIndex('parts_sale_items', 'part_number_key');
};

exports.down = (pgm) => {
  pgm.dropTable('parts_sale_items');
  pgm.dropTable('parts_sales');
  pgm.dropTable('parts_stock_movements');
  pgm.dropTable('parts_stock');
  pgm.dropTable('parts_pricing');
};
