const path = require('path');
const fs = require('fs');

// In production point UPLOAD_DIR at the Railway persistent volume,
// e.g. UPLOAD_DIR=/app/backend/data/uploads (same volume as the DB).
// Falls back to the repo-relative path for local development.
const UPLOAD_BASE = process.env.UPLOAD_DIR
  ? path.resolve(process.env.UPLOAD_DIR)
  : path.join(__dirname, '../uploads');

const UPLOAD_DIRS = {
  base:            UPLOAD_BASE,
  applications:    path.join(UPLOAD_BASE, 'applications'),
  profiles:        path.join(UPLOAD_BASE, 'profiles'),
  kyc:             path.join(UPLOAD_BASE, 'kyc'),
  bikes:           path.join(UPLOAD_BASE, 'bikes'),
  serviceInvoices: path.join(UPLOAD_BASE, 'service-invoices'),
  bikeDocuments:   path.join(UPLOAD_BASE, 'bike-documents'),
  branding:        path.join(UPLOAD_BASE, 'branding'),
  contracts:       path.join(UPLOAD_BASE, 'contracts'),
};

// Create all directories on first require
Object.values(UPLOAD_DIRS).forEach((dir) => fs.mkdirSync(dir, { recursive: true }));

module.exports = UPLOAD_DIRS;
