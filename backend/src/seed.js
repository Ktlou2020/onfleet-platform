require('dotenv').config();
const bcrypt = require('bcryptjs');
const db = require('./db');
const { generateAgreementNo, buildPaymentSchedule, addDays, recalcScheduleStatuses } = require('./utils/helpers');

console.log('🌱 Seeding database...');

// Wipe (dev only)
db.exec(`DELETE FROM payments; DELETE FROM payment_schedules; DELETE FROM agreements;
         DELETE FROM applications; DELETE FROM kyc_documents; DELETE FROM service_records;
         DELETE FROM gps_pings; DELETE FROM notifications; DELETE FROM audit_logs;
         DELETE FROM bikes; DELETE FROM users;`);

// Users
const adminHash = bcrypt.hashSync('admin123', 10);
const riderHash = bcrypt.hashSync('rider123', 10);

const admin = db.prepare(`INSERT INTO users (email, password_hash, full_name, phone, role)
                          VALUES (?,?,?,?, 'superadmin')`).run('admin@onfleet.africa', adminHash, 'OnFleet Admin', '+27110000000');

const riders = [
  ['thabo@example.com', 'Thabo Mokoena', '+27821234567', '9001015800089', 'Soweto', 'Gauteng'],
  ['lerato@example.com', 'Lerato Dlamini', '+27838765432', '9203124500087', 'Tembisa', 'Gauteng'],
  ['sipho@example.com', 'Sipho Ndlovu', '+27844455667', '8807128800082', 'Durban', 'KwaZulu-Natal'],
  ['ayanda@example.com', 'Ayanda Khumalo', '+27719987654', '9505236900088', 'Cape Town', 'Western Cape']
];
const riderIds = [];
for (const [email, name, phone, idn, city, prov] of riders) {
  const r = db.prepare(`INSERT INTO users (email, password_hash, full_name, phone, id_number, city, province, role)
                        VALUES (?,?,?,?,?,?,?, 'rider')`)
                .run(email, riderHash, name, phone, idn, city, prov);
  riderIds.push(r.lastInsertRowid);
}

// Bikes
// Real bike images from manufacturer / dealer sites
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
for (const [i, b] of bikes.entries()) {
  const img = b.pop();
  const lat = -26.2041 + (Math.random() - 0.5) * 0.4;
  const lng = 28.0473 + (Math.random() - 0.5) * 0.4;
  const r = insertBike.run(...b, `GPS-${1000+i}`, lat, lng, 1200 + i*500,
    addDays(new Date().toISOString().slice(0,10), 14 + i*5), 4000 + i*500,
    'Hollard', `POL-${20000+i}`, addDays(new Date().toISOString().slice(0,10), 200), img);
  bikeIds.push(r.lastInsertRowid);
}

// KYC docs (placeholder filenames)
for (const uid of riderIds) {
  db.prepare(`INSERT INTO kyc_documents (user_id, doc_type, file_path, original_name, status)
              VALUES (?,?,?,?, ?)`).run(uid, 'id_document', 'placeholder.jpg', 'id.jpg', 'approved');
  db.prepare(`INSERT INTO kyc_documents (user_id, doc_type, file_path, original_name, status)
              VALUES (?,?,?,?, ?)`).run(uid, 'proof_of_address', 'placeholder.jpg', 'poa.jpg', 'approved');
  db.prepare(`INSERT INTO kyc_documents (user_id, doc_type, file_path, original_name, status)
              VALUES (?,?,?,?, ?)`).run(uid, 'drivers_license', 'placeholder.jpg', 'license.jpg', 'pending');
}

// Applications & agreements for first 2 riders
function createAgreementFor(userId, bikeId, weeklyAmount, weeks, startOffsetDays, paidWeeks) {
  const start = addDays(new Date().toISOString().slice(0,10), startOffsetDays);
  const end = addDays(start, weeks * 7);
  const total = +(weeklyAmount * weeks).toFixed(2);
  const appInfo = db.prepare(`INSERT INTO applications (user_id, preferred_bike_id, employment_status,
                              monthly_income, delivery_platforms, has_riding_experience, years_riding,
                              has_drivers_license, status, reviewed_by, reviewed_at)
                              VALUES (?,?,?,?,?,?,?,?, 'approved', ?, CURRENT_TIMESTAMP)`)
                    .run(userId, bikeId, 'self_employed', 8500, 'UberEats,MrD,Bolt', 1, 3, 1, admin.lastInsertRowid);

  const ag = db.prepare(`INSERT INTO agreements (agreement_no, user_id, bike_id, application_id,
                         weekly_amount, total_weeks, total_amount, start_date, end_date, status,
                         signed_at, created_by)
                         VALUES (?,?,?,?, ?, ?, ?, ?, ?, 'active', CURRENT_TIMESTAMP, ?)`)
                 .run(generateAgreementNo(), userId, bikeId, appInfo.lastInsertRowid,
                      weeklyAmount, weeks, total, start, end, admin.lastInsertRowid);
  buildPaymentSchedule(ag.lastInsertRowid, weeklyAmount, weeks, start);

  // Mark bike allocated
  db.prepare(`UPDATE bikes SET status = 'allocated' WHERE id = ?`).run(bikeId);

  // Simulate paid weeks
  const schedule = db.prepare(`SELECT * FROM payment_schedules WHERE agreement_id = ? ORDER BY week_number`)
                      .all(ag.lastInsertRowid);
  for (let i = 0; i < paidWeeks && i < schedule.length; i++) {
    const s = schedule[i];
    db.prepare(`INSERT INTO payments (agreement_id, user_id, amount, currency, method, reference, status, paid_at, schedule_id)
                VALUES (?,?,?, 'ZAR', 'paystack', ?, 'success', ?, ?)`)
      .run(ag.lastInsertRowid, userId, weeklyAmount, `SEED-${ag.lastInsertRowid}-${i}`, s.due_date, s.id);
    db.prepare(`UPDATE payment_schedules SET amount_paid = ?, status = 'paid', paid_at = ? WHERE id = ?`)
      .run(weeklyAmount, s.due_date, s.id);
  }
  recalcScheduleStatuses(ag.lastInsertRowid);
  return ag.lastInsertRowid;
}

createAgreementFor(riderIds[0], bikeIds[4], 850, 78, -84, 12); // Thabo - 12 weeks paid
createAgreementFor(riderIds[1], bikeIds[5], 800, 65, -42, 6);  // Lerato - 6 weeks paid

// Pending application for rider 3
db.prepare(`INSERT INTO applications (user_id, preferred_bike_id, employment_status, monthly_income,
            delivery_platforms, has_riding_experience, years_riding, has_drivers_license, status)
            VALUES (?,?,?,?,?,?,?,?, 'submitted')`)
  .run(riderIds[2], bikeIds[0], 'employed', 12000, 'UberEats', 1, 5, 1);

// GPS pings for allocated bikes
for (const bid of [bikeIds[4], bikeIds[5]]) {
  for (let i = 0; i < 30; i++) {
    const lat = -26.2041 + (Math.random() - 0.5) * 0.3;
    const lng = 28.0473 + (Math.random() - 0.5) * 0.3;
    db.prepare(`INSERT INTO gps_pings (bike_id, lat, lng, speed_kmh, recorded_at)
                VALUES (?,?,?,?, datetime('now', ?))`)
      .run(bid, lat, lng, Math.floor(Math.random() * 60), `-${i*2} hours`);
  }
}

// Service records
db.prepare(`INSERT INTO service_records (bike_id, service_date, odometer_km, service_type, description, cost, performed_by)
            VALUES (?,?,?,?,?,?,?)`).run(bikeIds[4], addDays(new Date().toISOString().slice(0,10), -30),
                                          1200, 'monthly', 'Free monthly service - oil change, brake check', 0, 'OnFleet Workshop');

console.log('✅ Seed complete');
console.log('   Admin: admin@onfleet.africa / admin123');
console.log('   Rider: thabo@example.com / rider123 (active agreement, 12 weeks paid)');
console.log('   Rider: lerato@example.com / rider123 (active agreement, 6 weeks paid)');
console.log('   Rider: sipho@example.com / rider123 (pending application)');
console.log('   Rider: ayanda@example.com / rider123 (no application yet)');
