const { v4: uuid } = require('uuid');
const pgDb = require('../pgDb');
const africanCountries = require('../constants/africanCountries');
// Postgres versions — imports.js (this file's only DB-touching consumer) is
// fully migrated. payments.js and csvImportsFleet.js only import this file's
// pure functions (parseMoney, parseDateFlexible), which are unaffected.
const { addDays, buildPaymentSchedule, generateAgreementNo } = require('../utils/helpersPg');
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
    const [first, second, year] = parts;
    if (year.length === 4) {
      // Ambiguous between DD/MM/YYYY (South African/international — what
      // this platform's CSV sources actually use) and MM/DD/YYYY (US).
      // Default to day-first; if that puts an impossible value (>12) in the
      // month slot, the source must have been month-first, so swap. Bounds-
      // check both before trusting either, rather than silently writing a
      // swapped-but-still-"valid" date (e.g. 5 March read as May 3) into a
      // real agreement's start_date or a payment's paid_at.
      let day = first, month = second;
      if (Number(month) > 12) { [day, month] = [second, first]; }
      const dayNum = Number(day), monthNum = Number(month);
      if (monthNum >= 1 && monthNum <= 12 && dayNum >= 1 && dayNum <= 31) {
        return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      }
    }
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

async function addUserTagByEmail(email, tag) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) return { status: 'missing_email' };
  const { rows } = await pgDb.query(`SELECT id, email, user_tags, status FROM users WHERE email = $1 AND deleted_at IS NULL`, [normalizedEmail]);
  const user = rows[0];
  if (!user) return { status: 'not_found', email: normalizedEmail };
  const nextTags = mergeTagString(user.user_tags, tag);
  if (normalizeText(nextTags) === normalizeText(user.user_tags)) {
    return { status: 'already_tagged', id: user.id, email: user.email, user_tags: user.user_tags || '' };
  }
  await pgDb.query(`UPDATE users SET user_tags = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`, [nextTags, user.id]);
  return { status: 'tagged', id: user.id, email: user.email, user_tags: nextTags, account_status: user.status };
}

async function findUser({ email, fullName }) {
  const normalizedEmail = normalizeText(email).toLowerCase();
  const normalizedName = normalizeKey(fullName);
  if (normalizedEmail) {
    const { rows: byEmailRows } = await pgDb.query(`SELECT * FROM users WHERE email = $1 AND deleted_at IS NULL`, [normalizedEmail]);
    if (byEmailRows[0]) return byEmailRows[0];
  }
  if (normalizedName) {
    const { rows } = await pgDb.query(`SELECT * FROM users WHERE lower(trim(full_name)) = $1 AND deleted_at IS NULL ORDER BY id DESC`, [normalizedName]);
    return rows[0] || null;
  }
  return null;
}

async function buildLegacyEmail(row) {
  const provided = normalizeText(row.Email).toLowerCase();
  if (provided && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(provided)) return provided;
  const base = `${slugify(row['Full Name'] || row.Driver || 'rider')}@legacy.onfleet.africa`;
  const { rows } = await pgDb.query(`SELECT 1 FROM users WHERE email = $1`, [base]);
  if (!rows[0]) return base;
  return `${slugify(row['Full Name'] || row.Driver || 'rider')}-${uuid().slice(0, 6)}@legacy.onfleet.africa`;
}

async function upsertUserFromDriverRow(row) {
  const fullName = normalizeText(row['Full Name']);
  if (!fullName) throw new Error('Full Name is required');
  const email = await buildLegacyEmail(row);
  const existing = await findUser({ email, fullName });
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
    await pgDb.query(`UPDATE users SET
      email = $1,
      phone = COALESCE($2, phone),
      full_name = $3,
      id_number = COALESCE($4, id_number),
      address = COALESCE($5, address),
      province = COALESCE($6, province),
      country_of_origin = COALESCE($7, country_of_origin),
      avatar_url = COALESCE($8, avatar_url),
      role = 'rider',
      status = $9,
      updated_at = CURRENT_TIMESTAMP
      WHERE id = $10`, [
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
    ]);
    const { rows } = await pgDb.query(`SELECT * FROM users WHERE id = $1`, [existing.id]);
    return rows[0];
  }

  const passwordHash = `imported:${uuid()}`;
  const { rows } = await pgDb.query(`INSERT INTO users
    (email, phone, password_hash, full_name, role, status, id_number, address, province, country_of_origin, avatar_url)
    VALUES ($1,$2,$3,$4, 'rider', $5, $6, $7, $8, $9, $10)
    RETURNING *`, [
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
    ]);
  return rows[0];
}

async function getOrCreateApplicationForUser(userId, row = {}) {
  const { rows: existingRows } = await pgDb.query(`SELECT * FROM applications WHERE user_id = $1 ORDER BY id DESC LIMIT 1`, [userId]);
  const existing = existingRows[0];
  if (existing) {
    await pgDb.query(`UPDATE applications SET
      payout_preference = COALESCE($1, payout_preference),
      bank_name = COALESCE($2, bank_name),
      account_number = COALESCE($3, account_number),
      ewallet_number = COALESCE($4, ewallet_number),
      delivery_platforms = COALESCE($5, delivery_platforms),
      status = COALESCE($6, status)
      WHERE id = $7`, [
      inferPayoutPreference(row),
      normalizeText(row['Bank Name']) || null,
      normalizeText(row['Account Number']) || null,
      normalizeText(row['eWallet Number']) || null,
      normalizeText(row['Which Platform Do You Use?'] || row['My Fleet']) || null,
      mapApplicationStatus(row['Application Status']),
      existing.id
    ]);
    const { rows } = await pgDb.query(`SELECT * FROM applications WHERE id = $1`, [existing.id]);
    return rows[0];
  }

  const { rows } = await pgDb.query(`INSERT INTO applications
    (user_id, delivery_platforms, payout_preference, bank_name, account_number, ewallet_number, status)
    VALUES ($1,$2,$3,$4,$5,$6,$7)
    RETURNING *`, [
      userId,
      normalizeText(row['Which Platform Do You Use?'] || row['My Fleet']) || null,
      inferPayoutPreference(row),
      normalizeText(row['Bank Name']) || null,
      normalizeText(row['Account Number']) || null,
      normalizeText(row['eWallet Number']) || null,
      mapApplicationStatus(row['Application Status'])
    ]);
  return rows[0];
}

async function upsertKycDoc(userId, docType, rawValue) {
  const url = extractFirstUrl(rawValue);
  if (!url) return false;
  const { rows } = await pgDb.query(`SELECT id FROM kyc_documents WHERE user_id = $1 AND doc_type = $2 AND file_path = $3`, [userId, docType, url]);
  if (rows[0]) return false;
  await pgDb.query(`INSERT INTO kyc_documents (user_id, doc_type, file_path, original_name, status)
    VALUES ($1,$2,$3,$4, 'approved')`, [userId, docType, url, normalizeText(rawValue).slice(0, 255) || docType]);
  return true;
}

async function upsertApplicationDoc(applicationId, userId, docType, rawValue, extra = {}) {
  const filePath = extractFirstUrl(rawValue);
  if (!filePath) return false;
  const { rows } = await pgDb.query(`SELECT id FROM application_documents WHERE application_id = $1 AND doc_type = $2 AND file_path = $3`, [applicationId, docType, filePath]);
  if (rows[0]) return false;
  await pgDb.query(`INSERT INTO application_documents
    (application_id, user_id, doc_type, file_path, original_name, mime_type, extracted_amount, extracted_text, status, uploaded_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8, 'verified', $9)`, [
      applicationId,
      userId,
      docType,
      filePath,
      normalizeText(rawValue).slice(0, 255) || docType,
      filePath.endsWith('.pdf') ? 'application/pdf' : 'image/jpeg',
      extra.extracted_amount ?? null,
      extra.extracted_text ?? null,
      userId
    ]);
  return true;
}

async function resolveBike(row) {
  const registration = normalizeText(row.Bike || row['Vehicle Reg'] || row.registration || row['Bike Registration']);
  const vin = normalizeText(row.VIN || row.vin);
  if (vin) {
    const { rows: byVin } = await pgDb.query(`SELECT * FROM bikes WHERE vin = $1`, [vin]);
    if (byVin[0]) return byVin[0];
  }
  if (registration) {
    const { rows } = await pgDb.query(`SELECT * FROM bikes WHERE registration = $1`, [registration]);
    return rows[0] || null;
  }
  return null;
}

async function upsertBikeFromFleetRow(row) {
  const vin = normalizeText(row.VIN) || `LEGACY-VIN-${uuid().slice(0, 8)}`;
  const registration = normalizeText(row['Vehicle Reg']) || null;
  const existing = await resolveBike(row);
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
    await pgDb.query(`UPDATE bikes SET
      registration = COALESCE($1, registration),
      make = $2,
      model = $3,
      fleet = COALESCE(NULLIF($4, ''), fleet),
      year = COALESCE($5, year),
      color = COALESCE($6, color),
      rental_weekly = COALESCE($7, rental_weekly),
      total_weeks = COALESCE($8, total_weeks),
      status = $9,
      notes = COALESCE($10, notes)
      WHERE id = $11`, [
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
    ]);
    const { rows } = await pgDb.query(`SELECT * FROM bikes WHERE id = $1`, [existing.id]);
    return rows[0];
  }

  const { rows } = await pgDb.query(`INSERT INTO bikes
    (vin, registration, make, model, fleet, year, color, rental_weekly, total_weeks, status, condition, notes)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, 'used', $11)
    RETURNING *`, [payload.vin, payload.registration, payload.make, payload.model, payload.fleet, payload.year, payload.color, payload.rental_weekly, payload.total_weeks, payload.status, payload.notes]);
  return rows[0];
}

async function upsertAgreementFromFleetRow(row) {
  const bike = await resolveBike(row);
  if (!bike) throw new Error('Bike not found');
  const user = await findUser({ fullName: row.Driver });
  if (!user) throw new Error('Rider not found');
  const application = await getOrCreateApplicationForUser(user.id, { 'Application Status': 'approved' });
  const { rows: existingRows } = await pgDb.query(`SELECT * FROM agreements WHERE bike_id = $1 AND user_id = $2 ORDER BY id DESC LIMIT 1`, [bike.id, user.id]);
  const existing = existingRows[0];
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
    await pgDb.query(`UPDATE agreements SET
      weekly_amount = $1,
      total_weeks = $2,
      total_amount = $3,
      start_date = $4,
      end_date = $5,
      status = $6,
      application_id = $7,
      notes = COALESCE($8, notes)
      WHERE id = $9`, [
      weeklyAmount,
      totalWeeks,
      totalAmount,
      startDate,
      endDate,
      status,
      application.id,
      `Imported from fleet CSV on ${new Date().toISOString()}`,
      existing.id
    ]);
    const { rows: countRows } = await pgDb.query(`SELECT COUNT(*) count FROM payment_schedules WHERE agreement_id = $1`, [existing.id]);
    if (!Number(countRows[0].count)) await buildPaymentSchedule(existing.id, weeklyAmount, totalWeeks, startDate);
    const { rows } = await pgDb.query(`SELECT * FROM agreements WHERE id = $1`, [existing.id]);
    return rows[0];
  }

  const { rows: insertRows } = await pgDb.query(`INSERT INTO agreements
    (agreement_no, user_id, bike_id, application_id, weekly_amount, total_weeks, total_amount, start_date, end_date, status, notes)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    RETURNING id`, [agreementNo || generateAgreementNo(), user.id, bike.id, application.id, weeklyAmount, totalWeeks, totalAmount, startDate, endDate, status, `Imported from fleet CSV on ${new Date().toISOString()}`]);
  const newAgreementId = insertRows[0].id;
  await buildPaymentSchedule(newAgreementId, weeklyAmount, totalWeeks, startDate);
  await pgDb.query(`UPDATE bikes SET status = $1 WHERE id = $2`, [status === 'completed' ? 'paid_off' : 'active', bike.id]);
  const { rows } = await pgDb.query(`SELECT * FROM agreements WHERE id = $1`, [newAgreementId]);
  return rows[0];
}

async function resolveAgreementForPayment(row) {
  const registration = normalizeText(row.registration || row.Bike || row['Vehicle Reg'] || row['Bike Registration']);
  const riderName = normalizeText(row.rider_name || row.Driver || row.Rider || row['Full Name']);
  if (!registration) return null;

  const { rows: bikeRows } = await pgDb.query(`SELECT * FROM bikes WHERE UPPER(COALESCE(registration, '')) = UPPER($1)`, [registration]);
  const bike = bikeRows[0];
  if (!bike) return null;

  if (riderName) {
    const user = await findUser({ fullName: riderName });
    if (user) {
      const { rows: exactRows } = await pgDb.query(`SELECT * FROM agreements WHERE bike_id = $1 AND user_id = $2 ORDER BY
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
        LIMIT 1`, [bike.id, user.id]);
      if (exactRows[0]) return exactRows[0];
    }
  }

  const { rows } = await pgDb.query(`SELECT * FROM agreements WHERE bike_id = $1 ORDER BY
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
    LIMIT 1`, [bike.id]);
  return rows[0] || null;
}

async function insertImportedPayment(row, recordedBy) {
  const registration = normalizeText(row.registration || row.Bike || row['Vehicle Reg'] || row['Bike Registration']);
  if (!registration) throw new Error('Bike registration is required');
  const agreement = await resolveAgreementForPayment(row);
  if (!agreement) throw new Error(`Agreement not found for registration ${registration}`);
  const amount = parseMoney(row['Amount Collected'] || row.amount);
  if (!amount) throw new Error('Amount missing');
  const reference = buildImportedPaymentReference(row);
  const { rows: existsRows } = await pgDb.query(`SELECT id FROM payments WHERE reference = $1`, [reference]);
  if (existsRows[0]) return { skipped: true, reference };
  const paidAt = parseDateFlexible(row['Date Created'] || row.paid_at) || new Date().toISOString().slice(0, 10);
  const { rows: insertRows } = await pgDb.query(`INSERT INTO payments
    (agreement_id, user_id, amount, currency, method, reference, status, paid_at, recorded_by, notes, fee_amount, net_amount)
    VALUES ($1,$2,$3,$4,$5,$6, 'success', $7, $8, $9, $10, $11)
    RETURNING id`, [
      agreement.id,
      agreement.user_id,
      amount,
      'ZAR',
      normalizeText(row.method) || 'eft',
      reference,
      paidAt,
      recordedBy,
      normalizeText(row.notes) || `Imported from collections CSV for registration ${registration}`,
      0,
      amount
    ]);
  const paymentId = insertRows[0].id;

  const { rows: schedules } = await pgDb.query(`SELECT * FROM payment_schedules WHERE agreement_id = $1 ORDER BY week_number`, [agreement.id]);
  let remaining = amount;
  for (const schedule of schedules) {
    if (remaining <= 0) break;
    const owed = +(Number(schedule.amount_due) - Number(schedule.amount_paid || 0)).toFixed(2);
    if (owed <= 0) continue;
    const applied = Math.min(remaining, owed);
    const newPaid = +(Number(schedule.amount_paid || 0) + applied).toFixed(2);
    const status = newPaid >= Number(schedule.amount_due) ? 'paid' : 'partial';
    await pgDb.query(`UPDATE payment_schedules SET amount_paid = $1, status = $2, paid_at = COALESCE(paid_at, $3) WHERE id = $4`,
      [newPaid, status, paidAt, schedule.id]);
    remaining = +(remaining - applied).toFixed(2);
  }

  return { id: paymentId, reference };
}

async function importRidersCsv(buffer) {
  const rows = parseCsv(buffer.toString('utf8'));
  const summary = { total_rows: rows.length, users_created: 0, users_updated: 0, applications_linked: 0, documents_linked: 0, errors: [] };
  for (const [index, row] of rows.entries()) {
    try {
      const before = await findUser({ email: row.Email, fullName: row['Full Name'] });
      const user = await upsertUserFromDriverRow(row);
      if (before) summary.users_updated += 1;
      else summary.users_created += 1;
      const application = await getOrCreateApplicationForUser(user.id, row);
      if (application) summary.applications_linked += 1;
      const docsAdded = [
        await upsertKycDoc(user.id, 'selfie', row['Profile Picture']),
        await upsertKycDoc(user.id, 'proof_of_address', row['Proof of Address']),
        await upsertKycDoc(user.id, 'id_document', row['Upload Copy/Image of ID or passport']),
        await upsertKycDoc(user.id, 'drivers_license', row['Upload Valid License']),
        await upsertKycDoc(user.id, 'bank_statement', row['Upload 3 Months Bank Statement']),
        await upsertApplicationDoc(application.id, user.id, 'id_document', row['Upload Copy/Image of ID or passport']),
        await upsertApplicationDoc(application.id, user.id, 'drivers_license', row['Upload Valid License']),
        await upsertApplicationDoc(application.id, user.id, 'other', row['Upload Bank Confirmation Letter']),
        await upsertApplicationDoc(application.id, user.id, 'payslip', row['Payslip 1 File'], { extracted_amount: parseMoney(row['Pay 1']) || null }),
        await upsertApplicationDoc(application.id, user.id, 'payslip', row['Payslip 2 File'], { extracted_amount: parseMoney(row['Pay 2']) || null }),
        await upsertApplicationDoc(application.id, user.id, 'payslip', row['Payslip 3 File'], { extracted_amount: parseMoney(row['Pay 3']) || null })
      ].filter(Boolean).length;
      summary.documents_linked += docsAdded;
    } catch (error) {
      summary.errors.push({ row: index + 2, error: error.message });
    }
  }
  return summary;
}

async function importBikesCsv(buffer) {
  const rows = parseCsv(buffer.toString('utf8'));
  const summary = { total_rows: rows.length, bikes_created: 0, bikes_updated: 0, errors: [] };
  for (const [index, row] of rows.entries()) {
    try {
      const existing = await resolveBike(row);
      await upsertBikeFromFleetRow(row);
      if (existing) summary.bikes_updated += 1;
      else summary.bikes_created += 1;
    } catch (error) {
      summary.errors.push({ row: index + 2, error: error.message });
    }
  }
  return summary;
}

async function importAgreementsCsv(buffer) {
  const rows = parseCsv(buffer.toString('utf8'));
  const summary = { total_rows: rows.length, agreements_created: 0, agreements_updated: 0, errors: [] };
  for (const [index, row] of rows.entries()) {
    try {
      const bike = await resolveBike(row);
      const rider = await findUser({ fullName: row.Driver });
      let existing = null;
      if (bike && rider) {
        const { rows: existingRows } = await pgDb.query(`SELECT id FROM agreements WHERE bike_id = $1 AND user_id = $2 ORDER BY id DESC LIMIT 1`, [bike.id, rider.id]);
        existing = existingRows[0] || null;
      }
      await upsertAgreementFromFleetRow(row);
      if (existing) summary.agreements_updated += 1;
      else summary.agreements_created += 1;
    } catch (error) {
      summary.errors.push({ row: index + 2, error: error.message });
    }
  }
  return summary;
}

async function importPaymentsCsv(buffer, recordedBy) {
  const rows = parseCsv(buffer.toString('utf8'));
  const summary = { total_rows: rows.length, payments_created: 0, skipped: 0, errors: [] };
  for (const [index, row] of rows.entries()) {
    try {
      const result = await insertImportedPayment(row, recordedBy);
      if (result.skipped) summary.skipped += 1;
      else summary.payments_created += 1;
    } catch (error) {
      summary.errors.push({ row: index + 2, error: error.message });
    }
  }
  return summary;
}

async function importLegacyBundle({ ridersFile, bikesFile, paymentsFile, recordedBy }) {
  const output = {};
  if (ridersFile) output.riders = await importRidersCsv(ridersFile.buffer);
  if (bikesFile) {
    output.bikes = await importBikesCsv(bikesFile.buffer);
    output.agreements = await importAgreementsCsv(bikesFile.buffer);
  }
  if (paymentsFile) output.payments = await importPaymentsCsv(paymentsFile.buffer, recordedBy);
  return output;
}

async function importUserTagsCsv(buffer, { tag }) {
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
      const result = await addUserTagByEmail(pickEmailField(row), tag);
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
  parseMoney,
  parseDateFlexible,
  importRidersCsv,
  importBikesCsv,
  importAgreementsCsv,
  importPaymentsCsv,
  importLegacyBundle,
  importUserTagsCsv,
  resolveAgreementForPayment
};
