const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const dbPath = process.env.DB_PATH || path.join(__dirname, '../data/onfleet.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function tableHasColumn(table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column);
}

function ensureColumn(table, column, definition) {
  if (!tableHasColumn(table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function ensureBikeStatusSchema() {
  const schemaRow = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'bikes'`).get();
  const schemaSql = String(schemaRow?.sql || '');
  const expectedConstraint = `CHECK(status IN ('active','not_available','sold','paid_off','written_off','repairs','ready_to_go','stationary'))`;
  if (!schemaSql || schemaSql.includes(expectedConstraint)) return;

  db.exec(`
    PRAGMA foreign_keys = OFF;
    BEGIN TRANSACTION;
    CREATE TABLE bikes_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vin TEXT UNIQUE NOT NULL,
      registration TEXT UNIQUE,
      make TEXT NOT NULL,
      model TEXT NOT NULL,
      year INTEGER,
      engine_cc INTEGER,
      color TEXT,
      condition TEXT NOT NULL DEFAULT 'new' CHECK(condition IN ('new','used')),
      purchase_price REAL,
      rental_weekly REAL NOT NULL,
      total_weeks INTEGER NOT NULL DEFAULT 78,
      status TEXT NOT NULL DEFAULT 'ready_to_go' CHECK(status IN ('active','not_available','sold','paid_off','written_off','repairs','ready_to_go','stationary')),
      gps_device_id TEXT,
      last_known_lat REAL,
      last_known_lng REAL,
      last_location_at DATETIME,
      odometer_km INTEGER DEFAULT 0,
      next_service_km INTEGER,
      next_service_date TEXT,
      insurance_provider TEXT,
      insurance_policy_no TEXT,
      insurance_expiry TEXT,
      license_disc_no TEXT,
      license_disc_expiry TEXT,
      image_url TEXT,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO bikes_new (
      id, vin, registration, make, model, year, engine_cc, color, condition, purchase_price,
      rental_weekly, total_weeks, status, gps_device_id, last_known_lat, last_known_lng, last_location_at,
      odometer_km, next_service_km, next_service_date, insurance_provider, insurance_policy_no,
      insurance_expiry, license_disc_no, license_disc_expiry, image_url, notes, created_at
    )
    SELECT
      id, vin, registration, make, model, year, engine_cc, color, condition, purchase_price,
      rental_weekly, total_weeks,
      CASE status
        WHEN 'available' THEN 'ready_to_go'
        WHEN 'allocated' THEN 'active'
        WHEN 'maintenance' THEN 'repairs'
        WHEN 'sold' THEN 'paid_off'
        WHEN 'retired' THEN 'written_off'
        ELSE status
      END,
      gps_device_id, last_known_lat, last_known_lng, last_location_at,
      odometer_km, next_service_km, next_service_date, insurance_provider, insurance_policy_no,
      insurance_expiry, license_disc_no, license_disc_expiry, image_url, notes, created_at
    FROM bikes;
    DROP TABLE bikes;
    ALTER TABLE bikes_new RENAME TO bikes;
    COMMIT;
    PRAGMA foreign_keys = ON;
  `);
}

// ---------- SCHEMA ----------
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  phone TEXT,
  password_hash TEXT NOT NULL,
  full_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'rider' CHECK(role IN ('rider','admin','superadmin')),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended')),
  id_number TEXT,
  date_of_birth TEXT,
  address TEXT,
  city TEXT,
  province TEXT,
  postal_code TEXT,
  emergency_contact_name TEXT,
  emergency_contact_phone TEXT,
  avatar_url TEXT,
  country_of_origin TEXT,
  user_tags TEXT,
  deleted_at TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS kyc_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  doc_type TEXT NOT NULL CHECK(doc_type IN ('id_document','proof_of_address','drivers_license','bank_statement','selfie','other')),
  file_path TEXT NOT NULL,
  original_name TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
  rejection_reason TEXT,
  reviewed_by INTEGER,
  reviewed_at DATETIME,
  uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY(reviewed_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS bikes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vin TEXT UNIQUE NOT NULL,
  registration TEXT UNIQUE,
  make TEXT NOT NULL,
  model TEXT NOT NULL,
  year INTEGER,
  engine_cc INTEGER,
  color TEXT,
  condition TEXT NOT NULL DEFAULT 'new' CHECK(condition IN ('new','used')),
  purchase_price REAL,
  rental_weekly REAL NOT NULL,
  total_weeks INTEGER NOT NULL DEFAULT 78,
  status TEXT NOT NULL DEFAULT 'ready_to_go' CHECK(status IN ('active','not_available','sold','paid_off','written_off','repairs','ready_to_go','stationary')),
  gps_device_id TEXT,
  last_known_lat REAL,
  last_known_lng REAL,
  last_location_at DATETIME,
  odometer_km INTEGER DEFAULT 0,
  next_service_km INTEGER,
  next_service_date TEXT,
  insurance_provider TEXT,
  insurance_policy_no TEXT,
  insurance_expiry TEXT,
  license_disc_no TEXT,
  license_disc_expiry TEXT,
  image_url TEXT,
  notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  preferred_bike_id INTEGER,
  employment_status TEXT,
  monthly_income REAL,
  delivery_platforms TEXT,
  has_riding_experience INTEGER DEFAULT 0,
  years_riding INTEGER,
  has_drivers_license INTEGER DEFAULT 0,
  references_json TEXT,
  payout_preference TEXT,
  bank_name TEXT,
  account_holder TEXT,
  account_number TEXT,
  branch_code TEXT,
  ewallet_number TEXT,
  total_paid_last_3 REAL DEFAULT 0,
  average_weekly_earnings REAL DEFAULT 0,
  auto_decision TEXT,
  retry_after_date TEXT,
  status TEXT NOT NULL DEFAULT 'submitted' CHECK(status IN ('draft','submitted','under_review','approved','rejected','withdrawn')),
  rejection_reason TEXT,
  reviewed_by INTEGER,
  reviewed_at DATETIME,
  submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY(preferred_bike_id) REFERENCES bikes(id),
  FOREIGN KEY(reviewed_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS application_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  doc_type TEXT NOT NULL CHECK(doc_type IN ('id_document','drivers_license','payslip','signed_contract','unsigned_contract','other')),
  file_path TEXT NOT NULL,
  original_name TEXT,
  mime_type TEXT,
  extracted_amount REAL,
  extracted_text TEXT,
  status TEXT NOT NULL DEFAULT 'uploaded' CHECK(status IN ('uploaded','verified','rejected','signed')),
  uploaded_by INTEGER,
  uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(application_id) REFERENCES applications(id) ON DELETE CASCADE,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY(uploaded_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS agreements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agreement_no TEXT UNIQUE NOT NULL,
  user_id INTEGER NOT NULL,
  bike_id INTEGER NOT NULL,
  application_id INTEGER,
  weekly_amount REAL NOT NULL,
  total_weeks INTEGER NOT NULL DEFAULT 78,
  total_amount REAL NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','completed','defaulted','cancelled','paused')),
  signed_at DATETIME,
  signature_data TEXT,
  contract_pdf_path TEXT,
  contract_file_path TEXT,
  signed_contract_path TEXT,
  notes TEXT,
  created_by INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id),
  FOREIGN KEY(bike_id) REFERENCES bikes(id),
  FOREIGN KEY(application_id) REFERENCES applications(id),
  FOREIGN KEY(created_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS payment_schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agreement_id INTEGER NOT NULL,
  week_number INTEGER NOT NULL,
  due_date TEXT NOT NULL,
  amount_due REAL NOT NULL,
  amount_paid REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','paid','partial','overdue','waived')),
  paid_at DATETIME,
  FOREIGN KEY(agreement_id) REFERENCES agreements(id) ON DELETE CASCADE,
  UNIQUE(agreement_id, week_number)
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agreement_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  schedule_id INTEGER,
  amount REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'ZAR',
  method TEXT NOT NULL CHECK(method IN ('paystack','eft','cash','card','other')),
  reference TEXT UNIQUE,
  paystack_reference TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','success','failed','refunded')),
  paid_at DATETIME,
  recorded_by INTEGER,
  notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(agreement_id) REFERENCES agreements(id),
  FOREIGN KEY(user_id) REFERENCES users(id),
  FOREIGN KEY(schedule_id) REFERENCES payment_schedules(id),
  FOREIGN KEY(recorded_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS service_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bike_id INTEGER NOT NULL,
  agreement_id INTEGER,
  service_date TEXT NOT NULL,
  odometer_km INTEGER,
  service_type TEXT NOT NULL,
  description TEXT,
  cost REAL DEFAULT 0,
  next_service_km INTEGER,
  next_service_date TEXT,
  performed_by TEXT,
  invoice_file_path TEXT,
  invoice_original_name TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(bike_id) REFERENCES bikes(id),
  FOREIGN KEY(agreement_id) REFERENCES agreements(id)
);

CREATE TABLE IF NOT EXISTS gps_pings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bike_id INTEGER NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  speed_kmh REAL,
  heading REAL,
  recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(bike_id) REFERENCES bikes(id)
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  channel TEXT NOT NULL CHECK(channel IN ('email','sms','whatsapp','in_app')),
  type TEXT NOT NULL,
  title TEXT,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sent','failed','read')),
  sent_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id INTEGER,
  action TEXT NOT NULL,
  entity TEXT,
  entity_id INTEGER,
  metadata TEXT,
  ip TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(actor_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at DATETIME NOT NULL,
  used_at DATETIME,
  requested_ip TEXT,
  user_agent TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_payments_agreement ON payments(agreement_id);
CREATE INDEX IF NOT EXISTS idx_schedule_agreement ON payment_schedules(agreement_id);
CREATE INDEX IF NOT EXISTS idx_kyc_user ON kyc_documents(user_id);
CREATE INDEX IF NOT EXISTS idx_apps_user ON applications(user_id);
CREATE INDEX IF NOT EXISTS idx_appdocs_application ON application_documents(application_id);
CREATE INDEX IF NOT EXISTS idx_appdocs_user ON application_documents(user_id);
CREATE INDEX IF NOT EXISTS idx_gps_bike ON gps_pings(bike_id);
CREATE INDEX IF NOT EXISTS idx_password_reset_user ON password_reset_tokens(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_password_reset_expires ON password_reset_tokens(expires_at);
`);

// ---------- LIGHTWEIGHT MIGRATIONS FOR EXISTING DEPLOYS ----------
ensureColumn('users', 'deleted_at', 'TEXT');
ensureColumn('users', 'country_of_origin', 'TEXT');
ensureColumn('users', 'user_tags', 'TEXT');
ensureColumn('applications', 'payout_preference', 'TEXT');
ensureColumn('applications', 'bank_name', 'TEXT');
ensureColumn('applications', 'account_holder', 'TEXT');
ensureColumn('applications', 'account_number', 'TEXT');
ensureColumn('applications', 'branch_code', 'TEXT');
ensureColumn('applications', 'ewallet_number', 'TEXT');
ensureColumn('applications', 'total_paid_last_3', 'REAL DEFAULT 0');
ensureColumn('applications', 'average_weekly_earnings', 'REAL DEFAULT 0');
ensureColumn('applications', 'auto_decision', 'TEXT');
ensureColumn('applications', 'retry_after_date', 'TEXT');
ensureColumn('agreements', 'contract_file_path', 'TEXT');
ensureColumn('agreements', 'signed_contract_path', 'TEXT');
ensureColumn('service_records', 'invoice_file_path', 'TEXT');
ensureColumn('service_records', 'invoice_original_name', 'TEXT');
ensureColumn('payments', 'fee_amount', 'REAL DEFAULT 0');
ensureColumn('payments', 'net_amount', 'REAL DEFAULT 0');
ensureColumn('bikes', 'license_disc_no', 'TEXT');
ensureColumn('bikes', 'license_disc_expiry', 'TEXT');
ensureBikeStatusSchema();

module.exports = db;
