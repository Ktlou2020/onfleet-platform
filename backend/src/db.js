const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const dbPath = process.env.DB_PATH || path.join(__dirname, '../data/onfleet.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

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
  status TEXT NOT NULL DEFAULT 'available' CHECK(status IN ('available','allocated','maintenance','sold','retired')),
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
  delivery_platforms TEXT, -- comma list: UberEats,MrD,Bolt
  has_riding_experience INTEGER DEFAULT 0,
  years_riding INTEGER,
  has_drivers_license INTEGER DEFAULT 0,
  references_json TEXT,
  status TEXT NOT NULL DEFAULT 'submitted' CHECK(status IN ('draft','submitted','under_review','approved','rejected','withdrawn')),
  rejection_reason TEXT,
  reviewed_by INTEGER,
  reviewed_at DATETIME,
  submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY(preferred_bike_id) REFERENCES bikes(id),
  FOREIGN KEY(reviewed_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS agreements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agreement_no TEXT UNIQUE NOT NULL,
  user_id INTEGER NOT NULL,
  bike_id INTEGER NOT NULL,
  application_id INTEGER,
  weekly_amount REAL NOT NULL,
  total_weeks INTEGER NOT NULL DEFAULT 78, -- 18 months ≈ 78 weeks
  total_amount REAL NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','completed','defaulted','cancelled','paused')),
  signed_at DATETIME,
  signature_data TEXT,
  contract_pdf_path TEXT,
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

CREATE INDEX IF NOT EXISTS idx_payments_agreement ON payments(agreement_id);
CREATE INDEX IF NOT EXISTS idx_schedule_agreement ON payment_schedules(agreement_id);
CREATE INDEX IF NOT EXISTS idx_kyc_user ON kyc_documents(user_id);
CREATE INDEX IF NOT EXISTS idx_apps_user ON applications(user_id);
CREATE INDEX IF NOT EXISTS idx_gps_bike ON gps_pings(bike_id);
`);

module.exports = db;
