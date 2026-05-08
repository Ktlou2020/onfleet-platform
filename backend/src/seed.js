require('dotenv').config();
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const db = require('./db');
const { generateAgreementNo, buildPaymentSchedule, addDays, recalcScheduleStatuses } = require('./utils/helpers');
const { writeContractSnapshot } = require('./services/contracts');

console.log('🌱 Seeding database...');

const uploadBase = path.join(__dirname, '../uploads');
const appUploadDir = path.join(uploadBase, 'applications');
const invoiceUploadDir = path.join(uploadBase, 'service-invoices');
fs.mkdirSync(appUploadDir, { recursive: true });
fs.mkdirSync(invoiceUploadDir, { recursive: true });

function writeDemoHtml(filename, title, body) {
  const filePath = path.join(appUploadDir, filename);
  fs.writeFileSync(filePath, `<!doctype html><html><body style="font-family:Arial;padding:24px"><h1>${title}</h1><p>${body}</p></body></html>`);
  return `/uploads/applications/${filename}`;
}

function writeDemoInvoice(filename) {
  const filePath = path.join(invoiceUploadDir, filename);
  fs.writeFileSync(filePath, `<!doctype html><html><body style="font-family:Arial;padding:24px"><h1>Workshop Invoice</h1><p>${filename}</p></body></html>`);
  return `/uploads/service-invoices/${filename}`;
}

// Wipe (dev only)
db.exec(`DELETE FROM payments; DELETE FROM payment_schedules; DELETE FROM agreements;
DELETE FROM application_documents; DELETE FROM applications; DELETE FROM kyc_documents; DELETE FROM service_records;
DELETE FROM gps_pings; DELETE FROM notifications; DELETE FROM audit_logs; DELETE FROM bikes; DELETE FROM users;`);

const adminHash = bcrypt.hashSync('OnfleetAdmin2026!', 10);
const opsHash = bcrypt.hashSync('ops12345', 10);
const riderHash = bcrypt.hashSync('rider123', 10);

const admin = db.prepare(`INSERT INTO users (email, password_hash, full_name, phone, role)
  VALUES (?,?,?,?, 'superadmin')`).run('admin@onfleet.africa', adminHash, 'OnFleet Super Admin', '+27110000000');
const opsAdmin = db.prepare(`INSERT INTO users (email, password_hash, full_name, phone, role)
  VALUES (?,?,?,?, 'admin')`).run('ops@onfleet.africa', opsHash, 'Operations Admin', '+27110000001');

const riders = [
  ['thabo@example.com', 'Thabo Mokoena', '+27821234567', '9001015800089', 'Soweto', 'Gauteng'],
  ['lerato@example.com', 'Lerato Dlamini', '+27838765432', '9203124500087', 'Tembisa', 'Gauteng'],
  ['sipho@example.com', 'Sipho Ndlovu', '+27844455667', '8807128800082', 'Durban', 'KwaZulu-Natal'],
  ['ayanda@example.com', 'Ayanda Khumalo', '+27719987654', '9505236900088', 'Cape Town', 'Western Cape']
];
const riderIds = [];
for (const [email, name, phone, idn, city, prov] of riders) {
  const result = db.prepare(`INSERT INTO users (email, password_hash, full_name, phone, id_number, city, province, role)
    VALUES (?,?,?,?,?,?,?, 'rider')`).run(email, riderHash, name, phone, idn, city, prov);
  riderIds.push(result.lastInsertRowid);
}

const HONDA_ACE_125 = 'https://sspark.genspark.ai/cfimages?u1=2V8zlcfnZifzziUQK9rh1l1sgc2RIsb6xJtrcly3Bsd2xDJ%2BSkg4xX%2FLoM0PrKHXlQlMhNDqxKp0UN%2BAbRajElLU4oB7lEL%2Fr6tvAcHycSjQESI9VnPuMgfcM2Bzd6nz294qlT8cQzuHk8lJTVppjw%2BQ&u2=XvLOGgrkte6%2BrCPW&width=2560';
const BAJAJ_BOXER_150 = 'https://sspark.genspark.ai/cfimages?u1=lgHvA0y07wJ7mD99LY5wwEKBFc5IKOUawXWNUyY1SpRMB9p%2FUPwTxS9YwDCfqCIyFDZfQqdHBPk4FZ624HfMS4TDtqXEdZ2Zz0IeDhrV0zFE32igpP2G%2FdzbZWGaDO2USCZ%2B&u2=sSztnceQ%2FgZdvX2B&width=2560';
const TVS_HLX_125 = 'https://sspark.genspark.ai/cfimages?u1=2heoCv2XZbus%2FP8yo5trmHxxKEA%2Fbt3DpRV1UTLZydxIDf4MrSMYfOSqwF76LlSouGImVh%2B0%2Fgv40jlgq6daQZ3rynyLzfivIPBmupbLvRl%2FcJd8bRK3vet4Xuv2rjgynALbJAalY0XM5WwceFjD&u2=aIDZbxTuH3sEMEkU&width=2560';
const HERO_ECO_150 = 'https://sspark.genspark.ai/cfimages?u1=WONp4EWQmNpZHr2dInW%2BslCx7BCx2gT1NMsuyZQObTyb2NAZZKDUHyLoMNthkpw6h0%2F9B4UxuC7674lMzihu4%2F%2BR6iyg%2BmEXOe2JJIDaze9bJdH1iNaWM%2FnfxPQyEHRV7396zrSD%2FfZeRaiL4Yp3CibWDjkVX0Jp00Hcm78y7BsHFOiS5t1F2Py%2BPDKGN96P&u2=5x0yW1Qk8c5gGCnB&width=2560';

const bikes = [
  ['VINHA125001', 'GP-HA-1001', 'Honda', 'Ace 125', 2024, 125, 'Black', 'new', 21500, 850, 78, 'available', HONDA_ACE_125],
  ['VINTV125002', 'GP-TV-2002', 'TVS', 'HLX 125', 2024, 125, 'Red', 'new', 22000, 850, 78, 'available', TVS_HLX_125],
  ['VINBJ150003', 'GP-BJ-3003', 'Bajaj', 'Boxer 150', 2024, 150, 'Blue', 'new', 24500, 950, 78, 'available', BAJAJ_BOXER_150],
  ['VINHE150004', 'GP-HE-4004', 'Hero', 'Eco 150', 2023, 150, 'Silver', 'used', 18000, 750, 65, 'available', HERO_ECO_150],
  ['VINHA125005', 'GP-HA-5005', 'Honda', 'Ace 125', 2024, 125, 'White', 'new', 21500, 850, 78, 'allocated', HONDA_ACE_125],
  ['VINBJ150006', 'GP-BJ-6006', 'Bajaj', 'Boxer 150', 2023, 150, 'Black', 'used', 19500, 800, 65, 'allocated', BAJAJ_BOXER_150],
  ['VINTV125007', 'GP-TV-7007', 'TVS', 'HLX 125', 2024, 125, 'Black', 'new', 22000, 850, 78, 'maintenance', TVS_HLX_125],
  ['VINHA125008', 'GP-HA-8008', 'Honda', 'Ace 125', 2024, 125, 'Red', 'new', 21500, 850, 78, 'available', HONDA_ACE_125]
];
const bikeIds = [];
const insertBike = db.prepare(`INSERT INTO bikes
  (vin, registration, make, model, year, engine_cc, color, condition, purchase_price, rental_weekly, total_weeks, status,
   gps_device_id, last_known_lat, last_known_lng, last_location_at, odometer_km, next_service_date, next_service_km,
   insurance_provider, insurance_policy_no, insurance_expiry, image_url)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?, ?, ?, ?, ?, ?)`);
for (const [index, bikeRow] of bikes.entries()) {
  const img = bikeRow[bikeRow.length - 1];
  const attrs = bikeRow.slice(0, -1);
  const lat = -26.2041 + (Math.random() - 0.5) * 0.4;
  const lng = 28.0473 + (Math.random() - 0.5) * 0.4;
  const result = insertBike.run(...attrs, `GPS-${1000 + index}`, lat, lng, 1200 + index * 500, addDays(new Date().toISOString().slice(0, 10), 14 + index * 5), 4000 + index * 500, 'Hollard', `POL-${20000 + index}`, addDays(new Date().toISOString().slice(0, 10), 200), img);
  bikeIds.push(result.lastInsertRowid);
}

function insertApplicationDocument(applicationId, userId, docType, originalName, extractedAmount = null) {
  const safeName = `${applicationId}-${docType}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.html`;
  const filePath = writeDemoHtml(safeName, `${docType} document`, `${originalName}${extractedAmount ? ` · extracted total paid R${extractedAmount}` : ''}`);
  db.prepare(`INSERT INTO application_documents
    (application_id, user_id, doc_type, file_path, original_name, mime_type, extracted_amount, status, uploaded_by)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(applicationId, userId, docType, filePath, originalName, 'text/html', extractedAmount, docType === 'signed_contract' ? 'signed' : 'verified', admin.lastInsertRowid);
  return filePath;
}

function createActiveAgreementFor(userId, bikeId, weeklyAmount, weeks, startOffsetDays, paidWeeks, payslipAmounts) {
  const start = addDays(new Date().toISOString().slice(0, 10), startOffsetDays);
  const end = addDays(start, weeks * 7);
  const total = +(weeklyAmount * weeks).toFixed(2);
  const payslipTotal = payslipAmounts.reduce((sum, amount) => sum + amount, 0);
  const averageWeekly = +(payslipTotal / payslipAmounts.length).toFixed(2);
  const applicationInfo = db.prepare(`INSERT INTO applications
    (user_id, preferred_bike_id, monthly_income, delivery_platforms, has_riding_experience, years_riding, has_drivers_license,
     payout_preference, bank_name, account_holder, account_number, branch_code, total_paid_last_3, average_weekly_earnings,
     auto_decision, status, reviewed_by, reviewed_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'approved', ?, CURRENT_TIMESTAMP)`).run(
      userId, bikeId, 12000, 'Uber Eats,Mr D,Bolt Food', 1, 3, 1,
      'eft', 'Capitec', riders[userId - 3]?.[1] || 'Rider', `800000${userId}`, '470010',
      payslipTotal, averageWeekly, 'pre_approved', admin.lastInsertRowid
    );

  insertApplicationDocument(applicationInfo.lastInsertRowid, userId, 'id_document', 'id-document.html');
  insertApplicationDocument(applicationInfo.lastInsertRowid, userId, 'drivers_license', 'drivers-licence.html');
  payslipAmounts.forEach((amount, index) => insertApplicationDocument(applicationInfo.lastInsertRowid, userId, 'payslip', `payslip-${index + 1}.html`, amount));

  const agreementInfo = db.prepare(`INSERT INTO agreements
    (agreement_no, user_id, bike_id, application_id, weekly_amount, total_weeks, total_amount, start_date, end_date, status, signed_at, signature_data, created_by)
    VALUES (?,?,?,?,?,?,?,?,?, 'active', CURRENT_TIMESTAMP, ?, ?)`).run(
      generateAgreementNo(), userId, bikeId, applicationInfo.lastInsertRowid, weeklyAmount, weeks, total, start, end, `${riders[userId - 3]?.[1] || 'Rider'} electronic signature`, admin.lastInsertRowid
    );
  buildPaymentSchedule(agreementInfo.lastInsertRowid, weeklyAmount, weeks, start);
  db.prepare(`UPDATE bikes SET status = 'allocated' WHERE id = ?`).run(bikeId);

  const rider = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  const bike = db.prepare('SELECT * FROM bikes WHERE id = ?').get(bikeId);
  const agreement = db.prepare('SELECT * FROM agreements WHERE id = ?').get(agreementInfo.lastInsertRowid);
  const unsignedPath = writeContractSnapshot({ agreement, rider, bike, application: db.prepare('SELECT * FROM applications WHERE id = ?').get(applicationInfo.lastInsertRowid), kind: 'unsigned' });
  const signedPath = writeContractSnapshot({ agreement, rider, bike, application: db.prepare('SELECT * FROM applications WHERE id = ?').get(applicationInfo.lastInsertRowid), signatureData: agreement.signature_data, kind: 'signed' });
  db.prepare(`UPDATE agreements SET contract_file_path = ?, contract_pdf_path = ?, signed_contract_path = ? WHERE id = ?`).run(unsignedPath, unsignedPath, signedPath, agreementInfo.lastInsertRowid);
  insertApplicationDocument(applicationInfo.lastInsertRowid, userId, 'signed_contract', `${agreement.agreement_no}-signed.html`);

  const schedule = db.prepare(`SELECT * FROM payment_schedules WHERE agreement_id = ? ORDER BY week_number`).all(agreementInfo.lastInsertRowid);
  for (let i = 0; i < paidWeeks && i < schedule.length; i += 1) {
    const sched = schedule[i];
    db.prepare(`INSERT INTO payments (agreement_id, user_id, amount, currency, method, reference, status, paid_at, schedule_id)
      VALUES (?,?,?, 'ZAR', 'paystack', ?, 'success', ?, ?)`).run(agreementInfo.lastInsertRowid, userId, weeklyAmount, `SEED-${agreementInfo.lastInsertRowid}-${i}`, sched.due_date, sched.id);
    db.prepare(`UPDATE payment_schedules SET amount_paid = ?, status = 'paid', paid_at = ? WHERE id = ?`).run(weeklyAmount, sched.due_date, sched.id);
  }
  recalcScheduleStatuses(agreementInfo.lastInsertRowid);
}

createActiveAgreementFor(riderIds[0], bikeIds[4], 850, 78, -84, 12, [1500, 1420, 1650]);
createActiveAgreementFor(riderIds[1], bikeIds[5], 800, 65, -42, 6, [1200, 1280, 1180]);

const siphoPays = [1350, 1220, 1410];
const siphoTotal = siphoPays.reduce((sum, amount) => sum + amount, 0);
const siphoApp = db.prepare(`INSERT INTO applications
  (user_id, preferred_bike_id, monthly_income, delivery_platforms, has_riding_experience, years_riding, has_drivers_license,
   payout_preference, ewallet_number, total_paid_last_3, average_weekly_earnings, auto_decision, status)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    riderIds[2], bikeIds[0], 12000, 'Uber Eats,Takealot', 1, 5, 1, 'ewallet', '+27844455667', siphoTotal, +(siphoTotal / 3).toFixed(2), 'pre_approved', 'under_review'
  );
insertApplicationDocument(siphoApp.lastInsertRowid, riderIds[2], 'id_document', 'sipho-id.html');
insertApplicationDocument(siphoApp.lastInsertRowid, riderIds[2], 'drivers_license', 'sipho-licence.html');
siphoPays.forEach((amount, index) => insertApplicationDocument(siphoApp.lastInsertRowid, riderIds[2], 'payslip', `sipho-payslip-${index + 1}.html`, amount));

const ayandaPays = [700, 850, 900];
const ayandaTotal = ayandaPays.reduce((sum, amount) => sum + amount, 0);
const retryAfter = addDays(new Date().toISOString().slice(0, 10), 14);
const ayandaApp = db.prepare(`INSERT INTO applications
  (user_id, preferred_bike_id, monthly_income, delivery_platforms, has_riding_experience, years_riding, has_drivers_license,
   payout_preference, bank_name, account_holder, account_number, branch_code, total_paid_last_3, average_weekly_earnings,
   auto_decision, status, rejection_reason, retry_after_date)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    riderIds[3], bikeIds[1], 7800, 'Mr D', 1, 1, 1, 'eft', 'FNB', 'Ayanda Khumalo', '62123456789', '250655', ayandaTotal, +(ayandaTotal / 3).toFixed(2), 'auto_declined', 'rejected', `Average weekly earnings below R1000. Retry after ${retryAfter}.`, retryAfter
  );
insertApplicationDocument(ayandaApp.lastInsertRowid, riderIds[3], 'id_document', 'ayanda-id.html');
insertApplicationDocument(ayandaApp.lastInsertRowid, riderIds[3], 'drivers_license', 'ayanda-licence.html');
ayandaPays.forEach((amount, index) => insertApplicationDocument(ayandaApp.lastInsertRowid, riderIds[3], 'payslip', `ayanda-payslip-${index + 1}.html`, amount));

for (const bikeId of [bikeIds[4], bikeIds[5]]) {
  for (let i = 0; i < 30; i += 1) {
    const lat = -26.2041 + (Math.random() - 0.5) * 0.3;
    const lng = 28.0473 + (Math.random() - 0.5) * 0.3;
    db.prepare(`INSERT INTO gps_pings (bike_id, lat, lng, speed_kmh, recorded_at) VALUES (?,?,?,?, datetime('now', ?))`).run(bikeId, lat, lng, Math.floor(Math.random() * 60), `-${i * 2} hours`);
  }
}

db.prepare(`INSERT INTO service_records (bike_id, service_date, odometer_km, service_type, description, cost, performed_by, invoice_file_path, invoice_original_name)
  VALUES (?,?,?,?,?,?,?,?,?)`).run(
    bikeIds[4], addDays(new Date().toISOString().slice(0, 10), -30), 1200, 'monthly', 'Free monthly service - oil change, brake check', 0, 'OnFleet Workshop', writeDemoInvoice('service-thabo.html'), 'service-thabo.html'
  );
db.prepare(`INSERT INTO service_records (bike_id, service_date, odometer_km, service_type, description, cost, performed_by, invoice_file_path, invoice_original_name)
  VALUES (?,?,?,?,?,?,?,?,?)`).run(
    bikeIds[5], addDays(new Date().toISOString().slice(0, 10), -18), 3800, 'repair', 'Clutch cable replacement and labour', 450, 'MotoFix Durban', writeDemoInvoice('repair-lerato.html'), 'repair-lerato.html'
  );

console.log('✅ Seed complete');
console.log('   Super Admin: admin@onfleet.africa / OnfleetAdmin2026!');
console.log('   Admin: ops@onfleet.africa / ops12345');
console.log('   Rider: thabo@example.com / rider123 (active agreement, signed contract)');
console.log('   Rider: lerato@example.com / rider123 (active agreement, signed contract)');
console.log('   Rider: sipho@example.com / rider123 (pre-approved application)');
console.log('   Rider: ayanda@example.com / rider123 (auto-declined, retry in 2 weeks)');
