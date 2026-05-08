const fs = require('fs');
const path = require('path');
const db = require('./src/db');
const { importLegacyBundle } = require('./src/services/csvImports');

const ridersFile = { buffer: fs.readFileSync('/home/user/imports/drivers.csv') };
const bikesFile = { buffer: fs.readFileSync('/home/user/imports/fleet.csv') };
const paymentsFile = { buffer: fs.readFileSync('/home/user/imports/collections.csv') };

const summary = importLegacyBundle({ ridersFile, bikesFile, paymentsFile, recordedBy: 1 });
const counts = {
  riders: db.prepare("SELECT COUNT(*) count FROM users WHERE deleted_at IS NULL AND role = 'rider'").get().count,
  bikes: db.prepare("SELECT COUNT(*) count FROM bikes").get().count,
  agreements: db.prepare("SELECT COUNT(*) count FROM agreements").get().count,
  payments: db.prepare("SELECT COUNT(*) count FROM payments").get().count,
  selfies: db.prepare("SELECT COUNT(*) count FROM kyc_documents WHERE doc_type = 'selfie'").get().count,
  countries: db.prepare("SELECT COUNT(*) count FROM users WHERE country_of_origin IS NOT NULL AND trim(country_of_origin) != ''").get().count
};

console.log(JSON.stringify({ summary, counts }, null, 2));
