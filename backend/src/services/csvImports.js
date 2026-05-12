const { v4: uuid } = require('uuid');
const db = require('../db');
const africanCountries = require('../constants/africanCountries');
const { addDays, buildPaymentSchedule, generateAgreementNo } = require('../utils/helpers');
const { normalizeBikeStatus } = require('../utils/bikeStatus');

function parseCsv(text) {
  const rows = [];
  const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) return rows;
  const headers = splitCsvLine(lines.shift()).map((header) => header.trim());
  for (const line of lines) {
    const values = splitCsvLine(line);
    const row = {};
    headers.forEach((header, index) => {
      row[header] = (values[index] || '').trim();
    });
    rows.push(row);
  }
  return rows;
}

function splitCsvLine(line) {
  const values = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      values.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  values.push(current);
  return values;
}

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeKey(value) {
  return normalizeText(value).toLowerCase().replace(/\s+/g, ' ');
}

function slugify(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || `legacy-${uuid().slice(0, 8)}`;
}

function parseMoney(value) {
  const cleaned = normalizeText(value).replace(/,/g, '').replace(/R/gi, '').replace(/\s+/g, '');
  if (!cleaned) return 0;
  const amount = Number(cleaned);
  return Number.isFinite(amount) ? +amount.toFixed(2) : 0;
}

function parseInteger(value, fallback = null) {
  const cleaned = normalizeText(value).replace(/[^0-9-]/g, '');
  if (!cleaned) return fallback;
  const parsed = Number.parseInt(cleaned, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseDateFlexible(value, fallback = null) {
  const raw = normalizeText(value);
  if (!raw || raw.toLowerCase() === 'nan') return fallback;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const parts = raw.split(/[\/\-]/).map((part) => part.trim());
  if (parts.length === 3) {
    if (parts[0].length === 4) {
      const [year, month, day] = parts;
      return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
    }
    const [month, day, year] = parts;
    if (year.length === 4) return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return fallback;
  return parsed.toISOString().slice(0, 10);
}

function sanitizeReferencePart(value) {
  return normalizeText(value).replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

function buildImportedPaymentReference(row, fallbackPrefix = 'LEG-PAY') {
  const baseReference = sanitizeReferencePart(row.reference || row['Bike and Date']) || `${fallbackPrefix}-${uuid().slice(0, 8)}`;
  const registration = sanitizeReferencePart(row.registration || row.Bike || row['Vehicle Reg'] || row['Bike Registration']);
  const paidAtToken = sanitizeReferencePart((parseDateFlexible(row['Date Created'] || row.paid_at) || '').replace(/[^0-9]/g, ''));
  return [baseReference, registration, paidAtToken].filter(Boolean).join('-');
}

function extractFirstUrl(value) {
  const raw = normalizeText(value);
  if (!raw) return null;
  const match = raw.match(/https?:\/\/[^)\s]+/i);
  return match ? match[0] : null;
}

function mapBikeStatus(value, options = {}) {
  return normalizeBikeStatus(value, options);
}

function mapAgreementStatus(value) {
  const status = normalizeKey(value);
  if (!status) return 'active';
  if (status.includes('paid off')) return 'completed';
  if (status.includes('stolen')) return 'discontinued';
  if (status.includes('cancel')) return 'cancelled';
  if (status.includes('pause')) return 'paused';
  return 'active';
}

function mapApplicationStatus(value) {
  const status = normalizeKey(value);
  if (!status) return 'submitted';
  if (status.includes('approved')) return 'approved';
  if (status.includes('declin') || status.includes('reject')) return 'rejected';
  if (status.includes('review')) return 'under_review';
  if (status.includes('draft')) return 'draft';
  return 'submitted';
}

function inferPayoutPreference(row) {
  const paymentMethod = normalizeKey(row['Which payment option do you prefer?'] || row['Payment Method']);
  if (paymentMethod.includes('wallet') || paymentMethod.includes('money transfer')) return 'ewallet';
  if (paymentMethod.includes('bank') || paymentMethod.includes('debit')) return 'eft';
  return row['eWallet Number'] ? 'ewallet' : (row['Account Number'] ? 'eft' : null);
}

function normalizeCountry(value) {
  const raw = normalizeText(value);
  if (!raw) return null;
  const matched = africanCountries.find((country) => country.toLowerCase() === raw.toLowerCase());
  return matched || raw;
}

function normalizeEmail(value) {
  return normalizeText(value).toLowerCase();
}

function pickEmailField(row) {
  if (!row || typeof row !== 'object') return '';
  const preferredHeaders = ['Email', 'email', 'E-mail', 'e-mail', 'Email Address', 'email_address', 'email address'];
  for (const header of preferredHeaders) {
    if (normalizeEmail(row[header])) return row[header];
  }
  const discoveredHeader = Object.keys(row).find((key) => normalizeKey(key).includes('email'));
  return discoveredHeader ? row[discoveredHeader] : '';
}

function mergeTagString(existingValue, tagToAdd) {
  const normalizedTag = normalizeText(tagToAdd);
  if (!normalizedTag) return normalizeText(existingValue) || null;
  const tags = String(existingValue || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  if (tags.some((tag) => tag.toLowerCase() === normalizedTag.toLowerCase())) {
    return tags.join(', ');
  }
  return [...tags, normalizedTag].join(', ');
}

function addUserTagByEmail(email, tag) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) return { status: 'missing_email' };
  const user = db.prepare(`SELECT id, email, user_tags, status FROM users WHERE email = ? AND deleted_at IS NULL`).get(normalizedEmail);
  if (!user) return { status: 'not_found', email: normalizedEmail };
  const nextTags = mergeTagString(user.user_tags, tag);
  if (normalizeText(nextTags) === normalizeText(user.user_tags)) {
    return { status: 'already_tagged', id: user.id, email: user.email, user_tags: user.user_tags || '' };
  }
  db.prepare(`UPDATE users SET user_tags = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(nextTags, user.id);
  return { status: 'tagged', id: user.id, email: user.email, user_tags: nextTags, account_status: user.status };
}

function findUser({ email, fullName }) {
  const normalizedEmail = normalizeText(email).toLowerCase();
  const normalizedName = normalizeKey(fullName);
  if (normalizedEmail) {
    const byEmail = db.prepare(`SELECT * FROM users WHERE email = ? AND deleted_at IS NULL`).get(normalizedEmail);
    if (byEmail) return byEmail;
  }
  if (normalizedName) {
    return db.prepare(`SELECT * FROM users WHERE lower(trim(full_name)) = ? AND deleted_at IS NULL ORDER BY id DESC`).get(normalizedName);
  }
  return null;
}

function buildLegacyEmail(row) {
  const provided = normalizeText(row.Email).toLowerCase();
  if (provided && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(provided)) return provided;
  const base = `${slugify(row['Full Name'] || row.Driver || 'rider')}@legacy.onfleet.africa`;
  if (!db.prepare(`SELECT 1 FROM users WHERE email = ?`).get(base)) return base;
  return `${slugify(row['Full Name'] || row.Driver || 'rider')}-${uuid().slice(0, 6)}@legacy.onfleet.africa`;
}

function upsertUserFromDriverRow(row) {
  const fullName = normalizeText(row['Full Name']);
  if (!fullName) throw new Error('Full Name is required');
  const email = buildLegacyEmail(row);
  const existing = findUser({ email, fullName });
  const payload = {
    email,
    phone: normalizeText(row['Mobile Phone']) || null,
    full_name: fullName,
    id_number: normalizeText(row['ID/Passport Number']) || null,
    address: normalizeText(row.Address) || null,
    province: normalizeText(row['Province'] || row['Which Province Are Located In?']) || null,
    country_of_origin: normalizeCountry(row['Which Country Are You From?']),
    avatar_url: extractFirstUrl(row['Profile Picture']) || null,
    status: normalizeKey(row.Status) === 'suspended' ? 'suspended' : 'active'
  };

  if (existing) {
    db.prepare(`UPDATE users SET
      email = ?,
      phone = COALESCE(?, phone),
      full_name = ?,
      id_number = COALESCE(?, id_number),
      address = COALESCE(?, address),
      province = COALESCE(?, province),
      country_of_origin = COALESCE(?, country_of_origin),
      avatar_url = COALESCE(?, avatar_url),
      role = 'rider',
      status = ?,
      updated_at = CURRENT_TIMESTAMP
      WHERE id = ?`).run(
      payload.email,
      payload.phone,
      payload.full_name,
      payload.id_number,
      payload.address,
      payload.province,
      payload.country_of_origin,
      payload.avatar_url,
      payload.status,
      existing.id
    );
    return db.prepare(`SELECT * FROM users WHERE id = ?`).get(existing.id);
  }

  const passwordHash = `imported:${uuid()}`;
  const info = db.prepare(`INSERT INTO users
    (email, phone, password_hash, full_name, role, status, id_number, address, province, country_of_origin, avatar_url)
    VALUES (?,?,?,?, 'rider', ?, ?, ?, ?, ?, ?)`)
    .run(
      payload.email,
      payload.phone,
      passwordHash,
      payload.full_name,
      payload.status,
      payload.id_number,
      payload.address,
      payload.province,
      payload.country_of_origin,
      payload.avatar_url
    );
  return db.prepare(`SELECT * FROM users WHERE id = ?`).get(info.lastInsertRowid);
}

function getOrCreateApplicationForUser(userId, row = {}) {
  const existing = db.prepare(`SELECT * FROM applications WHERE user_id = ? ORDER BY id DESC LIMIT 1`).get(userId);
  if (existing) {
    db.prepare(`UPDATE applications SET
      payout_preference = COALESCE(?, payout_preference),
      bank_name = COALESCE(?, bank_name),
      account_number = COALESCE(?, account_number),
      ewallet_number = COALESCE(?, ewallet_number),
      delivery_platforms = COALESCE(?, delivery_platforms),
      status = COALESCE(?, status)
      WHERE id = ?`).run(
      inferPayoutPreference(row),
      normalizeText(row['Bank Name']) || null,
      normalizeText(row['Account Number']) || null,
      normalizeText(row['eWallet Number']) || null,
      normalizeText(row['Which Platform Do You Use?'] || row['My Fleet']) || null,
      mapApplicationStatus(row['Application Status']),
      existing.id
    );
    return db.prepare(`SELECT * FROM applications WHERE id = ?`).get(existing.id);
  }

  const info = db.prepare(`INSERT INTO applications
    (user_id, delivery_platforms, payout_preference, bank_name, account_number, ewallet_number, status)
    VALUES (?,?,?,?,?,?,?)`).run(
      userId,
      normalizeText(row['Which Platform Do You Use?'] || row['My Fleet']) || null,
      inferPayoutPreference(row),
      normalizeText(row['Bank Name']) || null,
      normalizeText(row['Account Number']) || null,
      normalizeText(row['eWallet Number']) || null,
      mapApplicationStatus(row['Application Status'])
    );
  return db.prepare(`SELECT * FROM applications WHERE id = ?`).get(info.lastInsertRowid);
}

function upsertKycDoc(userId, docType, rawValue) {
  const url = extractFirstUrl(rawValue);
  if (!url) return false;
  const existing = db.prepare(`SELECT id FROM kyc_documents WHERE user_id = ? AND doc_type = ? AND file_path = ?`).get(userId, docType, url);
  if (existing) return false;
  db.prepare(`INSERT INTO kyc_documents (user_id, doc_type, file_path, original_name, status)
    VALUES (?,?,?,?, 'approved')`).run(userId, docType, url, normalizeText(rawValue).slice(0, 255) || docType);
  return true;
}

function upsertApplicationDoc(applicationId, userId, docType, rawValue, extra = {}) {
  const filePath = extractFirstUrl(rawValue);
  if (!filePath) return false;
  const existing = db.prepare(`SELECT id FROM application_documents WHERE application_id = ? AND doc_type = ? AND file_path = ?`).get(applicationId, docType, filePath);
  if (existing) return false;
  db.prepare(`INSERT INTO application_documents
    (application_id, user_id, doc_type, file_path, original_name, mime_type, extracted_amount, extracted_text, status, uploaded_by)
    VALUES (?,?,?,?,?,?,?,?, 'verified', ?)`)
    .run(
      applicationId,
      userId,
      docType,
      filePath,
      normalizeText(rawValue).slice(0, 255) || docType,
      filePath.endsWith('.pdf') ? 'application/pdf' : 'image/jpeg',
      extra.extracted_amount ?? null,
      extra.extracted_text ?? null,
      userId
    );
  return true;
}

function resolveBike(row) {
  const registration = normalizeText(row.Bike || row['Vehicle Reg'] || row.registration || row['Bike Registration']);
  const vin = normalizeText(row.VIN || row.vin);
  if (vin) {
    const byVin = db.prepare(`SELECT * FROM bikes WHERE vin = ?`).get(vin);
    if (byVin) return byVin;
  }
  if (registration) {
    return db.prepare(`SELECT * FROM bikes WHERE registration = ?`).get(registration);
  }
  return null;
}

function upsertBikeFromFleetRow(row) {
  const vin = normalizeText(row.VIN) || `LEGACY-VIN-${uuid().slice(0, 8)}`;
  const registration = normalizeText(row['Vehicle Reg']) || null;
  const existing = resolveBike(row);
  const payload = {
    vin,
    registration,
    make: normalizeText(row.Make) || 'Unknown',
    model: normalizeText(row.Model) || 'Unknown',
    fleet: normalizeText(row.Fleet) || null,
    year: parseInteger(row['Year Model']),
    color: normalizeText(row.Colour) || null,
    rental_weekly: parseMoney(row['Payment to be collected']) || 850,
    total_weeks: Math.max(1, parseInteger(row['Number of Months Remaining'], 0) ? parseInteger(row['Number of Months Remaining']) * 4 : 78),
    status: mapBikeStatus(row.STATUS, { row }),
    notes: [
      normalizeText(row.Driver) ? `Legacy driver: ${normalizeText(row.Driver)}` : null,
      normalizeText(row.Fleet) ? `Fleet: ${normalizeText(row.Fleet)}` : null,
      extractFirstUrl(row['Certificate of Registration']) ? `Certificate: ${extractFirstUrl(row['Certificate of Registration'])}` : null,
      extractFirstUrl(row['License disc']) ? `Licence disc: ${extractFirstUrl(row['License disc'])}` : null,
      extractFirstUrl(row['Date of bike hand over']) ? `Legacy handover: ${normalizeText(row['Date of bike hand over'])}` : null,
      parseMoney(row['Outstanding Balance']) ? `Outstanding balance: R${parseMoney(row['Outstanding Balance']).toFixed(2)}` : null
    ].filter(Boolean).join(' | ') || null
  };

  if (existing) {
    db.prepare(`UPDATE bikes SET
      registration = COALESCE(?, registration),
      make = ?,
      model = ?,
      fleet = COALESCE(NULLIF(?, ''), fleet),
      year = COALESCE(?, year),
      color = COALESCE(?, color),
      rental_weekly = COALESCE(?, rental_weekly),
      total_weeks = COALESCE(?, total_weeks),
      status = ?,
      notes = COALESCE(?, notes)
      WHERE id = ?`).run(
      payload.registration,
      payload.make,
      payload.model,
      payload.fleet,
      payload.year,
      payload.color,
      payload.rental_weekly,
      payload.total_weeks,
      payload.status,
      payload.notes,
      existing.id
    );
    return db.prepare(`SELECT * FROM bikes WHERE id = ?`).get(existing.id);
  }

  const info = db.prepare(`INSERT INTO bikes
    (vin, registration, make, model, fleet, year, color, rental_weekly, total_weeks, status, condition, notes)
    VALUES (?,?,?,?,?,?,?,?,?,?, 'used', ?)`)
    .run(payload.vin, payload.registration, payload.make, payload.model, payload.fleet, payload.year, payload.color, payload.rental_weekly, payload.total_weeks, payload.status, payload.notes);
  return db.prepare(`SELECT * FROM bikes WHERE id = ?`).get(info.lastInsertRowid);
}

function upsertAgreementFromFleetRow(row) {
  const bike = resolveBike(row);
  if (!bike) throw new Error('Bike not found');
  const user = findUser({ fullName: row.Driver });
  if (!user) throw new Error('Rider not found');
  const application = getOrCreateApplicationForUser(user.id, { 'Application Status': 'approved' });
  const existing = db.prepare(`SELECT * FROM agreements WHERE bike_id = ? AND user_id = ? ORDER BY id DESC LIMIT 1`).get(bike.id, user.id);
  const weeklyAmount = parseMoney(row['Payment to be collected']) || Number(bike.rental_weekly || 850);
  const totalReceived = parseMoney(row['Total Received From Flexclub']);
  const outstandingBalance = Math.max(0, parseMoney(row['Outstanding Balance']));
  const totalAmount = weeklyAmount && (totalReceived || outstandingBalance)
    ? +(totalReceived + outstandingBalance).toFixed(2)
    : +(weeklyAmount * Number(bike.total_weeks || 78)).toFixed(2);
  const totalWeeks = Math.max(1, Math.ceil(totalAmount / Math.max(weeklyAmount, 1)));
  const startDate = parseDateFlexible(row['Date of bike hand over']) || parseDateFlexible(row['Date Taken']) || parseDateFlexible(row['Date Created']) || new Date().toISOString().slice(0, 10);
  const endDate = addDays(startDate, Math.max(0, totalWeeks - 1) * 7);
  const agreementNo = existing?.agreement_no || `LEG-${normalizeText(row['Vehicle Reg']) || bike.id}-${startDate.replace(/-/g, '')}`;
  const status = mapAgreementStatus(row.STATUS);

  if (existing) {
    db.prepare(`UPDATE agreements SET
      weekly_amount = ?,
      total_weeks = ?,
      total_amount = ?,
      start_date = ?,
      end_date = ?,
      status = ?,
      application_id = ?,
      notes = COALESCE(?, notes)
      WHERE id = ?`).run(
      weeklyAmount,
      totalWeeks,
      totalAmount,
      startDate,
      endDate,
      status,
      application.id,
      `Imported from fleet CSV on ${new Date().toISOString()}`,
      existing.id
    );
    const scheduleCount = db.prepare(`SELECT COUNT(*) count FROM payment_schedules WHERE agreement_id = ?`).get(existing.id).count;
    if (!scheduleCount) buildPaymentSchedule(existing.id, weeklyAmount, totalWeeks, startDate);
    return db.prepare(`SELECT * FROM agreements WHERE id = ?`).get(existing.id);
  }

  const info = db.prepare(`INSERT INTO agreements
    (agreement_no, user_id, bike_id, application_id, weekly_amount, total_weeks, total_amount, start_date, end_date, status, notes)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(agreementNo || generateAgreementNo(), user.id, bike.id, application.id, weeklyAmount, totalWeeks, totalAmount, startDate, endDate, status, `Imported from fleet CSV on ${new Date().toISOString()}`);
  buildPaymentSchedule(info.lastInsertRowid, weeklyAmount, totalWeeks, startDate);
  db.prepare(`UPDATE bikes SET status = ? WHERE id = ?`).run(status === 'completed' ? 'paid_off' : 'active', bike.id);
  return db.prepare(`SELECT * FROM agreements WHERE id = ?`).get(info.lastInsertRowid);
}

function resolveAgreementForPayment(row) {
  const registration = normalizeText(row.registration || row.Bike || row['Vehicle Reg'] || row['Bike Registration']);
  const riderName = normalizeText(row.rider_name || row.Driver || row.Rider || row['Full Name']);
  if (!registration) return null;

  const bike = db.prepare(`SELECT * FROM bikes WHERE UPPER(COALESCE(registration, '')) = UPPER(?)`).get(registration);
  if (!bike) return null;

  if (riderName) {
    const user = findUser({ fullName: riderName });
    if (user) {
      const exact = db.prepare(`SELECT * FROM agreements WHERE bike_id = ? AND user_id = ? ORDER BY
        CASE status
          WHEN 'active' THEN 0
          WHEN 'defaulted' THEN 1
          WHEN 'paused' THEN 2
          WHEN 'completed' THEN 3
          WHEN 'cancelled' THEN 4
          WHEN 'discontinued' THEN 5
          ELSE 6
        END,
        id DESC
        LIMIT 1`).get(bike.id, user.id);
      if (exact) return exact;
    }
  }

  return db.prepare(`SELECT * FROM agreements WHERE bike_id = ? ORDER BY
    CASE status
      WHEN 'active' THEN 0
      WHEN 'defaulted' THEN 1
      WHEN 'paused' THEN 2
      WHEN 'completed' THEN 3
      WHEN 'cancelled' THEN 4
      WHEN 'discontinued' THEN 5
      ELSE 6
    END,
    id DESC
    LIMIT 1`).get(bike.id);
}

function insertImportedPayment(row, recordedBy) {
  const registration = normalizeText(row.registration || row.Bike || row['Vehicle Reg'] || row['Bike Registration']);
  if (!registration) throw new Error('Bike registration is required');
  const agreement = resolveAgreementForPayment(row);
  if (!agreement) throw new Error(`Agreement not found for registration ${registration}`);
  const amount = parseMoney(row['Amount Collected'] || row.amount);
  if (!amount) throw new Error('Amount missing');
  const reference = buildImportedPaymentReference(row);
  const exists = db.prepare(`SELECT id FROM payments WHERE reference = ?`).get(reference);
  if (exists) return { skipped: true, reference };
  const paidAt = parseDateFlexible(row['Date Created'] || row.paid_at) || new Date().toISOString().slice(0, 10);
  const info = db.prepare(`INSERT INTO payments
    (agreement_id, user_id, amount, currency, method, reference, status, paid_at, recorded_by, notes)
    VALUES (?,?,?,?,?,?, 'success', ?, ?, ?)`)
    .run(
      agreement.id,
      agreement.user_id,
      amount,
      'ZAR',
      normalizeText(row.method) || 'eft',
      reference,
      paidAt,
      recordedBy,
      normalizeText(row.notes) || `Imported from collections CSV for registration ${registration}`
    );

  const schedules = db.prepare(`SELECT * FROM payment_schedules WHERE agreement_id = ? ORDER BY week_number`).all(agreement.id);
  let remaining = amount;
  for (const schedule of schedules) {
    if (remaining <= 0) break;
    const owed = +(Number(schedule.amount_due) - Number(schedule.amount_paid || 0)).toFixed(2);
    if (owed <= 0) continue;
    const applied = Math.min(remaining, owed);
    const newPaid = +(Number(schedule.amount_paid || 0) + applied).toFixed(2);
    const status = newPaid >= Number(schedule.amount_due) ? 'paid' : 'partial';
    db.prepare(`UPDATE payment_schedules SET amount_paid = ?, status = ?, paid_at = COALESCE(paid_at, ?) WHERE id = ?`)
      .run(newPaid, status, paidAt, schedule.id);
    remaining = +(remaining - applied).toFixed(2);
  }

  return { id: info.lastInsertRowid, reference };
}

function importRidersCsv(buffer) {
  const rows = parseCsv(buffer.toString('utf8'));
  const summary = { total_rows: rows.length, users_created: 0, users_updated: 0, applications_linked: 0, documents_linked: 0, errors: [] };
  for (const [index, row] of rows.entries()) {
    try {
      const before = findUser({ email: row.Email, fullName: row['Full Name'] });
      const user = upsertUserFromDriverRow(row);
      if (before) summary.users_updated += 1;
      else summary.users_created += 1;
      const application = getOrCreateApplicationForUser(user.id, row);
      if (application) summary.applications_linked += 1;
      const docsAdded = [
        upsertKycDoc(user.id, 'selfie', row['Profile Picture']),
        upsertKycDoc(user.id, 'proof_of_address', row['Proof of Address']),
        upsertKycDoc(user.id, 'id_document', row['Upload Copy/Image of ID or passport']),
        upsertKycDoc(user.id, 'drivers_license', row['Upload Valid License']),
        upsertKycDoc(user.id, 'bank_statement', row['Upload 3 Months Bank Statement']),
        upsertApplicationDoc(application.id, user.id, 'id_document', row['Upload Copy/Image of ID or passport']),
        upsertApplicationDoc(application.id, user.id, 'drivers_license', row['Upload Valid License']),
        upsertApplicationDoc(application.id, user.id, 'other', row['Upload Bank Confirmation Letter']),
        upsertApplicationDoc(application.id, user.id, 'payslip', row['Payslip 1 File'], { extracted_amount: parseMoney(row['Pay 1']) || null }),
        upsertApplicationDoc(application.id, user.id, 'payslip', row['Payslip 2 File'], { extracted_amount: parseMoney(row['Pay 2']) || null }),
        upsertApplicationDoc(application.id, user.id, 'payslip', row['Payslip 3 File'], { extracted_amount: parseMoney(row['Pay 3']) || null })
      ].filter(Boolean).length;
      summary.documents_linked += docsAdded;
    } catch (error) {
      summary.errors.push({ row: index + 2, error: error.message });
    }
  }
  return summary;
}

function importBikesCsv(buffer) {
  const rows = parseCsv(buffer.toString('utf8'));
  const summary = { total_rows: rows.length, bikes_created: 0, bikes_updated: 0, errors: [] };
  for (const [index, row] of rows.entries()) {
    try {
      const existing = resolveBike(row);
      upsertBikeFromFleetRow(row);
      if (existing) summary.bikes_updated += 1;
      else summary.bikes_created += 1;
    } catch (error) {
      summary.errors.push({ row: index + 2, error: error.message });
    }
  }
  return summary;
}

function importAgreementsCsv(buffer) {
  const rows = parseCsv(buffer.toString('utf8'));
  const summary = { total_rows: rows.length, agreements_created: 0, agreements_updated: 0, errors: [] };
  for (const [index, row] of rows.entries()) {
    try {
      const bike = resolveBike(row);
      const rider = findUser({ fullName: row.Driver });
      const existing = bike && rider
        ? db.prepare(`SELECT id FROM agreements WHERE bike_id = ? AND user_id = ? ORDER BY id DESC LIMIT 1`).get(bike.id, rider.id)
        : null;
      upsertAgreementFromFleetRow(row);
      if (existing) summary.agreements_updated += 1;
      else summary.agreements_created += 1;
    } catch (error) {
      summary.errors.push({ row: index + 2, error: error.message });
    }
  }
  return summary;
}

function importPaymentsCsv(buffer, recordedBy) {
  const rows = parseCsv(buffer.toString('utf8'));
  const summary = { total_rows: rows.length, payments_created: 0, skipped: 0, errors: [] };
  for (const [index, row] of rows.entries()) {
    try {
      const result = insertImportedPayment(row, recordedBy);
      if (result.skipped) summary.skipped += 1;
      else summary.payments_created += 1;
    } catch (error) {
      summary.errors.push({ row: index + 2, error: error.message });
    }
  }
  return summary;
}

function importLegacyBundle({ ridersFile, bikesFile, paymentsFile, recordedBy }) {
  const output = {};
  if (ridersFile) output.riders = importRidersCsv(ridersFile.buffer);
  if (bikesFile) {
    output.bikes = importBikesCsv(bikesFile.buffer);
    output.agreements = importAgreementsCsv(bikesFile.buffer);
  }
  if (paymentsFile) output.payments = importPaymentsCsv(paymentsFile.buffer, recordedBy);
  return output;
}

function importUserTagsCsv(buffer, { tag }) {
  const rows = parseCsv(buffer.toString('utf8'));
  const summary = {
    tag: normalizeText(tag),
    total_rows: rows.length,
    tagged: 0,
    already_tagged: 0,
    missing_email: 0,
    not_found: 0,
    errors: [],
    unmatched_emails: []
  };

  for (const [index, row] of rows.entries()) {
    try {
      const result = addUserTagByEmail(pickEmailField(row), tag);
      if (result.status === 'tagged') summary.tagged += 1;
      else if (result.status === 'already_tagged') summary.already_tagged += 1;
      else if (result.status === 'missing_email') summary.missing_email += 1;
      else if (result.status === 'not_found') {
        summary.not_found += 1;
        summary.unmatched_emails.push(result.email);
      }
    } catch (error) {
      summary.errors.push({ row: index + 2, error: error.message });
    }
  }

  summary.unmatched_emails = summary.unmatched_emails.slice(0, 100);
  return summary;
}

module.exports = {
  africanCountries,
  importRidersCsv,
  importBikesCsv,
  importAgreementsCsv,
  importPaymentsCsv,
  importLegacyBundle,
  importUserTagsCsv,
  resolveAgreementForPayment
};
