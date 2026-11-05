'use strict';
const path = require('path');
const Database = require('better-sqlite3');

// One connection per process. Tests pass ':memory:' through VERDANT_DB so
// each test file gets a clean database.
function open(file = process.env.VERDANT_DB || path.join(__dirname, '..', 'verdant.db')) {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY,
      email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      name          TEXT NOT NULL,
      phone         TEXT,
      role          TEXT NOT NULL CHECK (role IN ('customer','merchant','rider','admin')),
      id_number     TEXT,
      dob           TEXT,
      age_verified  INTEGER NOT NULL DEFAULT 0,
      suspended     INTEGER NOT NULL DEFAULT 0,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS cities (
      id   INTEGER PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      lat  REAL NOT NULL,
      lng  REAL NOT NULL
    );

    -- regulated = 1 means the category can only be listed by a store holding
    -- a verified licence for it, and only while the platform switch is on.
    CREATE TABLE IF NOT EXISTS categories (
      id        INTEGER PRIMARY KEY,
      slug      TEXT NOT NULL UNIQUE,
      name      TEXT NOT NULL,
      icon      TEXT NOT NULL,
      regulated INTEGER NOT NULL DEFAULT 0,
      sort      INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS stores (
      id                 INTEGER PRIMARY KEY,
      owner_id           INTEGER NOT NULL REFERENCES users(id),
      slug               TEXT NOT NULL UNIQUE,
      name               TEXT NOT NULL,
      description        TEXT NOT NULL DEFAULT '',
      city_id            INTEGER NOT NULL REFERENCES cities(id),
      address            TEXT NOT NULL,
      lat                REAL NOT NULL,
      lng                REAL NOT NULL,
      delivery_radius_km REAL NOT NULL DEFAULT 8,
      prep_minutes       INTEGER NOT NULL DEFAULT 10,
      status             TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','suspended')),
      is_open            INTEGER NOT NULL DEFAULT 1,
      licence_number     TEXT,
      licence_categories TEXT NOT NULL DEFAULT '[]',
      licence_verified   INTEGER NOT NULL DEFAULT 0,
      accent             TEXT NOT NULL DEFAULT '#2f855a',
      rating_sum         INTEGER NOT NULL DEFAULT 0,
      rating_count       INTEGER NOT NULL DEFAULT 0,
      created_at         TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS products (
      id          INTEGER PRIMARY KEY,
      store_id    INTEGER NOT NULL REFERENCES stores(id),
      category_id INTEGER NOT NULL REFERENCES categories(id),
      name        TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      price_cents INTEGER NOT NULL CHECK (price_cents > 0),
      unit        TEXT NOT NULL DEFAULT 'each',
      stock       INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
      thc_pct     REAL,
      cbd_pct     REAL,
      strain_type TEXT,
      active      INTEGER NOT NULL DEFAULT 1,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS riders (
      user_id    INTEGER PRIMARY KEY REFERENCES users(id),
      vehicle    TEXT NOT NULL DEFAULT 'motorbike',
      plate      TEXT,
      online     INTEGER NOT NULL DEFAULT 0,
      lat        REAL,
      lng        REAL,
      located_at TEXT
    );

    CREATE TABLE IF NOT EXISTS orders (
      id                 INTEGER PRIMARY KEY,
      code               TEXT NOT NULL UNIQUE,
      customer_id        INTEGER NOT NULL REFERENCES users(id),
      store_id           INTEGER NOT NULL REFERENCES stores(id),
      rider_id           INTEGER REFERENCES users(id),
      status             TEXT NOT NULL,
      subtotal_cents     INTEGER NOT NULL,
      delivery_fee_cents INTEGER NOT NULL,
      service_fee_cents  INTEGER NOT NULL,
      total_cents        INTEGER NOT NULL,
      vat_cents          INTEGER NOT NULL,
      address            TEXT NOT NULL,
      lat                REAL NOT NULL,
      lng                REAL NOT NULL,
      distance_km        REAL NOT NULL,
      eta_minutes        INTEGER NOT NULL,
      notes              TEXT NOT NULL DEFAULT '',
      payment_status     TEXT NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid','paid','refunded')),
      payment_ref        TEXT UNIQUE,
      handover_code      TEXT NOT NULL,
      id_checked         INTEGER NOT NULL DEFAULT 0,
      cancel_reason      TEXT,
      created_at         TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
      delivered_at       TEXT
    );
    CREATE INDEX IF NOT EXISTS orders_customer ON orders(customer_id);
    CREATE INDEX IF NOT EXISTS orders_store ON orders(store_id, status);
    CREATE INDEX IF NOT EXISTS orders_rider ON orders(rider_id, status);

    CREATE TABLE IF NOT EXISTS order_items (
      id          INTEGER PRIMARY KEY,
      order_id    INTEGER NOT NULL REFERENCES orders(id),
      product_id  INTEGER NOT NULL REFERENCES products(id),
      name        TEXT NOT NULL,
      price_cents INTEGER NOT NULL,
      qty         INTEGER NOT NULL CHECK (qty > 0)
    );

    CREATE TABLE IF NOT EXISTS order_events (
      id       INTEGER PRIMARY KEY,
      order_id INTEGER NOT NULL REFERENCES orders(id),
      status   TEXT NOT NULL,
      note     TEXT,
      at       TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS reviews (
      id          INTEGER PRIMARY KEY,
      order_id    INTEGER NOT NULL UNIQUE REFERENCES orders(id),
      customer_id INTEGER NOT NULL REFERENCES users(id),
      store_id    INTEGER NOT NULL REFERENCES stores(id),
      rating      INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
      comment     TEXT NOT NULL DEFAULT '',
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    INSERT OR IGNORE INTO settings (key, value) VALUES
      ('regulated_sales_enabled', 'false'),
      ('delivery_open_hour', '8'),
      ('delivery_close_hour', '22');

    CREATE TABLE IF NOT EXISTS audit_log (
      id       INTEGER PRIMARY KEY,
      user_id  INTEGER,
      action   TEXT NOT NULL,
      detail   TEXT,
      at       TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

module.exports = { open };
