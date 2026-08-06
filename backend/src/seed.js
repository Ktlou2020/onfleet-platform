require('dotenv').config();

if (process.env.NODE_ENV === 'production') {
  console.log('🌱 Seed skipped in production');
  process.exit(0);
}

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const pgDb = require('./pgDb');
const { generateAgreementNo, addDays } = require('./utils/helpers');
const { buildPaymentSchedule, recalcScheduleStatuses } = require('./utils/helpersPg');
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

function generatedPassword() {
  return crypto.randomBytes(12).toString('base64url');
}

async function main() {
  // Wipe (dev only). Children before parents to respect FK constraints.
  // gps_pings and the other legacy SQLite tracking tables have no Postgres
  // equivalent — the unified schema's tracking data lives in
  // trips/tracking_devices/geofences/tracking_alerts instead, seeded
  // separately (if at all), so there's nothing to wipe or reseed here.
  await pgDb.query(`
    DELETE FROM payments;
    DELETE FROM payment_schedules;
    DELETE FROM agreements;
    DELETE FROM application_documents;
    DELETE FROM applications;
    DELETE FROM kyc_documents;
    DELETE FROM service_records;
    DELETE FROM notifications;
    DELETE FROM audit_logs;
    DELETE FROM bikes;
    DELETE FROM users;
  `);

  const liveSuperadminEmail = (process.env.SUPERADMIN_EMAIL || 'superadmin@example.com').trim().toLowerCase();
  const liveSuperadminPassword = process.env.SUPERADMIN_PASSWORD || generatedPassword();
  const liveSuperadminName = (process.env.SUPERADMIN_FULL_NAME || 'OnFleet Platform Super User').trim();
  const liveSuperadminPhone = (process.env.SUPERADMIN_PHONE || '').trim() || null;
  const seedAdminPassword = process.env.SEED_ADMIN_PASSWORD || generatedPassword();
  const seedRiderPassword = process.env.SEED_RIDER_PASSWORD || generatedPassword();

  const adminHash = bcrypt.hashSync(liveSuperadminPassword, 10);
  const opsHash = bcrypt.hashSync(seedAdminPassword, 10);
  const riderHash = bcrypt.hashSync(seedRiderPassword, 10);

  const { rows: [admin] } = await pgDb.query(
    `INSERT INTO users (email, password_hash, full_name, phone, role) VALUES ($1,$2,$3,$4,'superadmin') RETURNING id`,
    [liveSuperadminEmail, adminHash, liveSuperadminName, liveSuperadminPhone]
  );
  await pgDb.query(
    `INSERT INTO users (email, password_hash, full_name, phone, role) VALUES ($1,$2,$3,$4,'admin')`,
    ['ops@onfleet.africa', opsHash, 'Operations Admin', '+27110000001']
  );

  const riders = [
    ['thabo@example.com', 'Thabo Mokoena', '+27821234567', '9001015800089', 'Soweto', 'Gauteng'],
    ['lerato@example.com', 'Lerato Dlamini', '+27838765432', '9203124500087', 'Tembisa', 'Gauteng'],
    ['sipho@example.com', 'Sipho Ndlovu', '+27844455667', '8807128800082', 'Durban', 'KwaZulu-Natal'],
    ['ayanda@example.com', 'Ayanda Khumalo', '+27719987654', '9505236900088', 'Cape Town', 'Western Cape']
  ];
  const riderIds = [];
  for (const [email, name, phone, idn, city, prov] of riders) {
    const { rows: [result] } = await pgDb.query(
      `INSERT INTO users (email, password_hash, full_name, phone, id_number, city, province, role)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'rider') RETURNING id`,
      [email, riderHash, name, phone, idn, city, prov]
    );
    riderIds.push(result.id);
  }

  const HONDA_ACE_125 = 'https://sspark.genspark.ai/cfimages?u1=2V8zlcfnZifzziUQK9rh1l1sgc2RIsb6xJtrcly3Bsd2xDJ%2BSkg4xX%2FLoM0PrKHXlQlMhNDqxKp0UN%2BAbRajElLU4oB7lEL%2Fr6tvAcHycSjQESI9VnPuMgfcM2Bzd6nz294qlT8cQzuHk8lJTVppjw%2BQ&u2=XvLOGgrkte6%2BrCPW&width=2560';
  const BAJAJ_BOXER_150 = 'https://sspark.genspark.ai/cfimages?u1=lgHvA0y07wJ7mD99LY5wwEKBFc5IKOUawXWNUyY1SpRMB9p%2FUPwTxS9YwDCfqCIyFDZfQqdHBPk4FZ624HfMS4TDtqXEdZ2Zz0IeDhrV0zFE32igpP2G%2FdzbZWGaDO2USCZ%2B&u2=sSztnceQ%2FgZdvX2B&width=2560';
  const TVS_HLX_125 = 'https://sspark.genspark.ai/cfimages?u1=2heoCv2XZbus%2FP8yo5trmHxxKEA%2Fbt3DpRV1UTLZydxIDf4MrSMYfOSqwF76LlSouGImVh%2B0%2Fgv40jlgq6daQZ3rynyLzfivIPBmupbLvRl%2FcJd8bRK3vet4Xuv2rjgynALbJAalY0XM5WwceFjD&u2=aIDZbxTuH3sEMEkU&width=2560';
  const HERO_ECO_150 = 'https://sspark.genspark.ai/cfimages?u1=WONp4EWQmNpZHr2dInW%2BslCx7BCx2gT1NMsuyZQObTyb2NAZZKDUHyLoMNthkpw6h0%2F9B4UxuC7674lMzihu4%2F%2BR6iyg%2BmEXOe2JJIDaze9bJdH1iNaWM%2FnfxPQyEHRV7396zrSD%2FfZeRaiL4Yp3CibWDjkVX0Jp00Hcm78y7BsHFOiS5t1F2Py%2BPDKGN96P&u2=5x0yW1Qk8c5gGCnB&width=2560';

  const bikes = [
    ['VINHA125001', 'GP-HA-1001', 'Honda', 'Ace 125', 2024, 125, 'Black', 'new', 21500, 850, 78, 'ready_to_go', HONDA_ACE_125],
    ['VINTV125002', 'GP-TV-2002', 'TVS', 'HLX 125', 2024, 125, 'Red', 'new', 22000, 850, 78, 'ready_to_go', TVS_HLX_125],
    ['VINBJ150003', 'GP-BJ-3003', 'Bajaj', 'Boxer 150', 2024, 150, 'Blue', 'new', 24500, 950, 78, 'ready_to_go', BAJAJ_BOXER_150],
    ['VINHE150004', 'GP-HE-4004', 'Hero', 'Eco 150', 2023, 150, 'Silver', 'used', 18000, 750, 65, 'ready_to_go', HERO_ECO_150],
    ['VINHA125005', 'GP-HA-5005', 'Honda', 'Ace 125', 2024, 125, 'White', 'new', 21500, 850, 78, 'active', HONDA_ACE_125],
    ['VINBJ150006', 'GP-BJ-6006', 'Bajaj', 'Boxer 150', 2023, 150, 'Black', 'used', 19500, 800, 65, 'active', BAJAJ_BOXER_150],
    ['VINTV125007', 'GP-TV-7007', 'TVS', 'HLX 125', 2024, 125, 'Black', 'new', 22000, 850, 78, 'repairs', TVS_HLX_125],
    ['VINHA125008', 'GP-HA-8008', 'Honda', 'Ace 125', 2024, 125, 'Red', 'new', 21500, 850, 78, 'ready_to_go', HONDA_ACE_125]
  ];
  const bikeIds = [];
  for (const [index, bikeRow] of bikes.entries()) {
    const img = bikeRow[bikeRow.length - 1];
    const attrs = bikeRow.slice(0, -1);
    const lat = -26.2041 + (Math.random() - 0.5) * 0.4;
    const lng = 28.0473 + (Math.random() - 0.5) * 0.4;
    const { rows: [result] } = await pgDb.query(
      `INSERT INTO bikes
        (vin, registration, make, model, year, engine_cc, color, condition, purchase_price, rental_weekly, total_weeks, status,
         gps_device_id, last_known_lat, last_known_lng, last_location_at, odometer_km, next_service_date, next_service_km,
         insurance_provider, insurance_policy_no, insurance_expiry, image_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, $13, $14, $15, NOW(), $16, $17, $18, $19, $20, $21, $22)
       RETURNING id`,
      [...attrs, `GPS-${1000 + index}`, lat, lng, 1200 + index * 500, addDays(new Date().toISOString().slice(0, 10), 14 + index * 5), 4000 + index * 500, 'Hollard', `POL-${20000 + index}`, addDays(new Date().toISOString().slice(0, 10), 200), img]
    );
    bikeIds.push(result.id);
  }

  async function insertApplicationDocument(applicationId, userId, docType, originalName, extractedAmount = null) {
    const safeName = `${applicationId}-${docType}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.html`;
    const filePath = writeDemoHtml(safeName, `${docType} document`, `${originalName}${extractedAmount ? ` · extracted total paid R${extractedAmount}` : ''}`);
    await pgDb.query(
      `INSERT INTO application_documents
        (application_id, user_id, doc_type, file_path, original_name, mime_type, extracted_amount, status, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [applicationId, userId, docType, filePath, originalName, 'text/html', extractedAmount, docType === 'signed_contract' ? 'signed' : 'verified', admin.id]
    );
    return filePath;
  }

  async function createActiveAgreementFor(userId, bikeId, weeklyAmount, weeks, startOffsetDays, paidWeeks, payslipAmounts) {
    const start = addDays(new Date().toISOString().slice(0, 10), startOffsetDays);
    const end = addDays(start, weeks * 7);
    const total = +(weeklyAmount * weeks).toFixed(2);
    const payslipTotal = payslipAmounts.reduce((sum, amount) => sum + amount, 0);
    const averageWeekly = +(payslipTotal / payslipAmounts.length).toFixed(2);
    const riderName = riders[userId - 3]?.[1] || 'Rider';
    const { rows: [applicationInfo] } = await pgDb.query(
      `INSERT INTO applications
        (user_id, preferred_bike_id, monthly_income, delivery_platforms, has_riding_experience, years_riding, has_drivers_license,
         payout_preference, bank_name, account_holder, account_number, branch_code, total_paid_last_3, average_weekly_earnings,
         auto_decision, status, reviewed_by, reviewed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'approved',$16,NOW())
       RETURNING id`,
      [
        userId, bikeId, 12000, 'Uber Eats,Mr D,Bolt Food', true, 3, true,
        'eft', 'Capitec', riderName, `800000${userId}`, '470010',
        payslipTotal, averageWeekly, 'pre_approved', admin.id
      ]
    );

    await insertApplicationDocument(applicationInfo.id, userId, 'id_document', 'id-document.html');
    await insertApplicationDocument(applicationInfo.id, userId, 'drivers_license', 'drivers-licence.html');
    for (const [index, amount] of payslipAmounts.entries()) {
      await insertApplicationDocument(applicationInfo.id, userId, 'payslip', `payslip-${index + 1}.html`, amount);
    }

    const { rows: [agreementInfo] } = await pgDb.query(
      `INSERT INTO agreements
        (agreement_no, user_id, bike_id, application_id, weekly_amount, total_weeks, total_amount, start_date, end_date, status, signed_at, signature_data, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'active',NOW(),$10,$11)
       RETURNING id`,
      [generateAgreementNo(), userId, bikeId, applicationInfo.id, weeklyAmount, weeks, total, start, end, `${riderName} electronic signature`, admin.id]
    );
    await buildPaymentSchedule(agreementInfo.id, weeklyAmount, weeks, start);
    await pgDb.query(`UPDATE bikes SET status = 'active' WHERE id = $1`, [bikeId]);

    const { rows: [rider] } = await pgDb.query('SELECT * FROM users WHERE id = $1', [userId]);
    const { rows: [bike] } = await pgDb.query('SELECT * FROM bikes WHERE id = $1', [bikeId]);
    const { rows: [agreement] } = await pgDb.query('SELECT * FROM agreements WHERE id = $1', [agreementInfo.id]);
    const { rows: [application] } = await pgDb.query('SELECT * FROM applications WHERE id = $1', [applicationInfo.id]);
    const unsignedPath = writeContractSnapshot({ agreement, rider, bike, application, kind: 'unsigned' });
    const signedPath = writeContractSnapshot({ agreement, rider, bike, application, signatureData: agreement.signature_data, kind: 'signed' });
    await pgDb.query(
      `UPDATE agreements SET contract_file_path = $1, contract_pdf_path = $2, signed_contract_path = $3 WHERE id = $4`,
      [unsignedPath, unsignedPath, signedPath, agreementInfo.id]
    );
    await insertApplicationDocument(applicationInfo.id, userId, 'signed_contract', `${agreement.agreement_no}-signed.html`);

    const { rows: schedule } = await pgDb.query(`SELECT * FROM payment_schedules WHERE agreement_id = $1 ORDER BY week_number`, [agreementInfo.id]);
    for (let i = 0; i < paidWeeks && i < schedule.length; i += 1) {
      const sched = schedule[i];
      await pgDb.query(
        `INSERT INTO payments (agreement_id, user_id, amount, currency, method, reference, status, paid_at, schedule_id)
         VALUES ($1,$2,$3,'ZAR','paystack',$4,'success',$5,$6)`,
        [agreementInfo.id, userId, weeklyAmount, `SEED-${agreementInfo.id}-${i}`, sched.due_date, sched.id]
      );
      await pgDb.query(`UPDATE payment_schedules SET amount_paid = $1, status = 'paid', paid_at = $2 WHERE id = $3`, [weeklyAmount, sched.due_date, sched.id]);
    }
    await recalcScheduleStatuses(agreementInfo.id);
  }

  await createActiveAgreementFor(riderIds[0], bikeIds[4], 850, 78, -84, 12, [1500, 1420, 1650]);
  await createActiveAgreementFor(riderIds[1], bikeIds[5], 800, 65, -42, 6, [1200, 1280, 1180]);

  const siphoPays = [1350, 1220, 1410];
  const siphoTotal = siphoPays.reduce((sum, amount) => sum + amount, 0);
  const { rows: [siphoApp] } = await pgDb.query(
    `INSERT INTO applications
      (user_id, preferred_bike_id, monthly_income, delivery_platforms, has_riding_experience, years_riding, has_drivers_license,
       payout_preference, ewallet_number, total_paid_last_3, average_weekly_earnings, auto_decision, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     RETURNING id`,
    [riderIds[2], bikeIds[0], 12000, 'Uber Eats,Takealot', true, 5, true, 'ewallet', '+27844455667', siphoTotal, +(siphoTotal / 3).toFixed(2), 'pre_approved', 'under_review']
  );
  await insertApplicationDocument(siphoApp.id, riderIds[2], 'id_document', 'sipho-id.html');
  await insertApplicationDocument(siphoApp.id, riderIds[2], 'drivers_license', 'sipho-licence.html');
  for (const [index, amount] of siphoPays.entries()) {
    await insertApplicationDocument(siphoApp.id, riderIds[2], 'payslip', `sipho-payslip-${index + 1}.html`, amount);
  }

  const ayandaPays = [700, 850, 900];
  const ayandaTotal = ayandaPays.reduce((sum, amount) => sum + amount, 0);
  const retryAfter = addDays(new Date().toISOString().slice(0, 10), 14);
  const { rows: [ayandaApp] } = await pgDb.query(
    `INSERT INTO applications
      (user_id, preferred_bike_id, monthly_income, delivery_platforms, has_riding_experience, years_riding, has_drivers_license,
       payout_preference, bank_name, account_holder, account_number, branch_code, total_paid_last_3, average_weekly_earnings,
       auto_decision, status, rejection_reason, retry_after_date)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     RETURNING id`,
    [riderIds[3], bikeIds[1], 7800, 'Mr D', true, 1, true, 'eft', 'FNB', 'Ayanda Khumalo', '62123456789', '250655', ayandaTotal, +(ayandaTotal / 3).toFixed(2), 'auto_declined', 'rejected', `Average weekly earnings below R1000. Retry after ${retryAfter}.`, retryAfter]
  );
  await insertApplicationDocument(ayandaApp.id, riderIds[3], 'id_document', 'ayanda-id.html');
  await insertApplicationDocument(ayandaApp.id, riderIds[3], 'drivers_license', 'ayanda-licence.html');
  for (const [index, amount] of ayandaPays.entries()) {
    await insertApplicationDocument(ayandaApp.id, riderIds[3], 'payslip', `ayanda-payslip-${index + 1}.html`, amount);
  }

  await pgDb.query(
    `INSERT INTO service_records (bike_id, service_date, odometer_km, service_type, description, cost, performed_by, invoice_file_path, invoice_original_name)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [bikeIds[4], addDays(new Date().toISOString().slice(0, 10), -30), 1200, 'monthly', 'Free monthly service - oil change, brake check', 0, 'OnFleet Workshop', writeDemoInvoice('service-thabo.html'), 'service-thabo.html']
  );
  await pgDb.query(
    `INSERT INTO service_records (bike_id, service_date, odometer_km, service_type, description, cost, performed_by, invoice_file_path, invoice_original_name)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [bikeIds[5], addDays(new Date().toISOString().slice(0, 10), -18), 3800, 'repair', 'Clutch cable replacement and labour', 450, 'MotoFix Durban', writeDemoInvoice('repair-lerato.html'), 'repair-lerato.html']
  );

  console.log('✅ Seed complete');
  console.log(`   Super Admin email: ${liveSuperadminEmail}`);
  console.log(`   Super Admin password source: ${process.env.SUPERADMIN_PASSWORD ? 'SUPERADMIN_PASSWORD env var' : 'generated at seed time'}`);
  console.log(`   Seed admin password source: ${process.env.SEED_ADMIN_PASSWORD ? 'SEED_ADMIN_PASSWORD env var' : 'generated at seed time'}`);
  console.log(`   Seed rider password source: ${process.env.SEED_RIDER_PASSWORD ? 'SEED_RIDER_PASSWORD env var' : 'generated at seed time'}`);
  console.log('   Sample riders seeded: thabo@example.com, lerato@example.com, sipho@example.com, ayanda@example.com');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
