'use strict';

/**
 * One-shot migration: copies all core business data from SQLite → Postgres
 * (the 27 tables created by migrations/*_business-data-schema.cjs).
 *
 * Usage:
 *   DATABASE_URL=postgresql://... DB_PATH=/path/to/onfleet.db \
 *     node scripts/migrate-business-data-to-postgres.js [--target-schema=name]
 *
 * Safe to re-run: uses ON CONFLICT (id) DO NOTHING, so duplicate rows are
 * skipped rather than erroring — but any OTHER unique-constraint conflict
 * (email, vin, agreement_no, reference, etc.) throws immediately and loudly,
 * since that indicates a real data problem, not just a re-run.
 *
 * Does NOT touch SQLite at all — read-only against the source. This script
 * is meant to be run against a scratch/dry-run schema first (see
 * --target-schema), and only pointed at production once fully rehearsed.
 *
 * Preserves SQLite's integer ids exactly (agreements.bike_id etc. must keep
 * pointing at the same rows) and resets each table's sequence afterward so
 * the next real INSERT doesn't collide.
 */

require('dotenv').config();

const db = require('../src/db');
const pgDb = require('../src/pgDb');

const BATCH = 500;

const targetSchemaArg = process.argv.find(a => a.startsWith('--target-schema='));
const SCHEMA = targetSchemaArg ? targetSchemaArg.split('=')[1] : (process.env.TARGET_SCHEMA || 'public');
const T = (table) => `"${SCHEMA}"."${table}"`;

// ── Column-level transforms ────────────────────────────────────────────────

const BOOL_COLS = new Set([
  'applications.has_riding_experience',
  'applications.has_drivers_license',
  'fleet_owner_pilot_leads.wants_demo',
  'labour_rates.active',
]);

const DATE_COLS = new Set([
  'bikes.next_service_date', 'bikes.insurance_expiry', 'bikes.license_disc_expiry',
  'users.date_of_birth',
  'agreements.start_date', 'agreements.end_date',
  'payment_schedules.due_date',
  'service_records.service_date', 'service_records.next_service_date',
  'applications.retry_after_date',
  'collections_actions.next_action_date',
  'job_cards.next_service_date',
]);

// Every column ending in _at is a timestamp EXCEPT the DATE_COLS above.
// SQLite writes these in three known shapes:
//   'YYYY-MM-DD HH:MM:SS'        — SQLite CURRENT_TIMESTAMP, no zone marker, UTC
//   'YYYY-MM-DDTHH:MM:SS.sssZ'   — JS new Date().toISOString(), explicit UTC
//   'YYYY-MM-DD'                 — bare date used as a timestamp (seen in seed data
//                                   backfilling historical paid_at values) — treated
//                                   as midnight UTC on that date
function toTimestamptz(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s + 'T00:00:00Z';
  if (/[zZ]$|[+-]\d\d:\d\d$/.test(s)) return s;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) return s.replace(' ', 'T') + 'Z';
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(s)) return s + 'Z';
  console.warn(`  WARNING unrecognized timestamp shape: ${JSON.stringify(v)} — passing through as-is`);
  return s;
}

function toDate(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    console.warn(`  WARNING unexpected date shape: ${JSON.stringify(v)} — passing through as-is`);
  }
  return s;
}

function transformValue(table, col, v) {
  const key = `${table}.${col}`;
  if (BOOL_COLS.has(key)) return v === 1 || v === true;
  if (DATE_COLS.has(key)) return toDate(v);
  if (col.endsWith('_at')) return toTimestamptz(v);
  return v ?? null;
}

// ── Generic helpers (same shape as scripts/migrate-tracking-to-postgres.js) ─

function rows(table, cols) {
  return db.prepare(`SELECT ${cols.join(', ')} FROM ${table}`).all();
}

async function insertBatched(table, cols) {
  const data = rows(table, cols);
  if (!data.length) { console.log(`  ${table}: 0 rows (skipped)`); return 0; }

  let inserted = 0;
  for (let i = 0; i < data.length; i += BATCH) {
    const batch = data.slice(i, i + BATCH);
    const placeholders = batch.map((_, bi) =>
      '(' + cols.map((__, ci) => `$${bi * cols.length + ci + 1}`).join(', ') + ')'
    ).join(', ');
    const values = batch.flatMap(row => cols.map(c => transformValue(table, c, row[c])));
    await pgDb.query(
      `INSERT INTO ${T(table)} (${cols.join(', ')}) VALUES ${placeholders} ON CONFLICT (id) DO NOTHING`,
      values
    );
    inserted += batch.length;
    process.stdout.write(`\r  ${table}: ${inserted}/${data.length} rows`);
  }
  console.log(`\r  ${table}: ${data.length} rows migrated`);
  return data.length;
}

async function resetSequence(table, idCol = 'id') {
  await pgDb.query(
    `SELECT setval(pg_get_serial_sequence('${SCHEMA}.${table}', '${idCol}'), COALESCE((SELECT MAX(${idCol}) FROM ${T(table)}), 1)) FROM ${T(table)} LIMIT 1`
  );
}

// ── Table list, in FK-dependency order (see migration plan §3) ─────────────

const TABLES = [
  { name: 'organizations', cols: ['id','name','slug','contact_email','contact_phone','city','fleet_size','plan_key','status','trial_started_at','trial_ends_at','paystack_customer_code','paystack_subscription_code','max_bikes','max_admin_users','bank_account_name','bank_name','bank_account_number','bank_branch_code','address','registration_number','vat_number','created_at','updated_at'] },
  { name: 'app_settings', cols: ['setting_key','setting_value','updated_at'], noSequence: true },
  { name: 'hubs', cols: ['id','organization_id','name','address','city','contact_name','contact_phone','notes','created_at'] },
  { name: 'users', cols: ['id','email','phone','password_hash','full_name','role','organization_id','status','id_number','date_of_birth','address','city','province','postal_code','emergency_contact_name','emergency_contact_phone','avatar_url','country_of_origin','user_tags','deleted_at','created_at','updated_at'] },
  { name: 'bikes', cols: ['id','vin','registration','make','model','fleet','organization_id','hub_id','year','engine_cc','color','condition','purchase_price','rental_weekly','total_weeks','status','gps_device_id','last_known_lat','last_known_lng','last_location_at','odometer_km','next_service_km','next_service_date','insurance_provider','insurance_policy_no','insurance_expiry','license_disc_no','license_disc_expiry','rc1_file_path','rc1_original_name','license_disc_file_path','license_disc_original_name','image_url','notes','created_at'] },
  { name: 'kyc_documents', cols: ['id','user_id','doc_type','file_path','original_name','status','rejection_reason','reviewed_by','reviewed_at','uploaded_at'] },
  { name: 'applications', cols: ['id','user_id','preferred_bike_id','employment_status','monthly_income','delivery_platforms','has_riding_experience','years_riding','has_drivers_license','references_json','payout_preference','bank_name','account_holder','account_number','branch_code','ewallet_number','total_paid_last_3','average_weekly_earnings','auto_decision','retry_after_date','status','rejection_reason','reviewed_by','reviewed_at','submitted_at'] },
  { name: 'application_documents', cols: ['id','application_id','user_id','doc_type','file_path','original_name','mime_type','extracted_amount','extracted_text','status','uploaded_by','uploaded_at'] },
  { name: 'agreements', cols: ['id','agreement_no','user_id','bike_id','application_id','weekly_amount','total_weeks','total_amount','start_date','end_date','status','signed_at','signature_data','discontinued_reason','discontinued_at','reinstated_at','contract_pdf_path','contract_file_path','signed_contract_path','notes','created_by','created_at'] },
  { name: 'payment_schedules', cols: ['id','agreement_id','week_number','due_date','amount_due','amount_paid','status','paid_at'] },
  { name: 'payments', cols: ['id','agreement_id','user_id','schedule_id','amount','currency','method','reference','paystack_reference','status','paid_at','recorded_by','notes','fee_amount','net_amount','created_at'] },
  { name: 'job_cards', cols: ['id','bike_id','vin','registration','make','model','year','color','engine_cc','fleet_owner_name','fleet_org_id','job_type','description','technician_notes','status','priority','technician_id','created_by','started_at','completed_at','completion_notes','odometer_km','next_service_date','next_service_km','bike_status_after','paused_at','total_paused_seconds','quote_approved_at','quote_approved_by','created_at'] },
  { name: 'job_card_items', cols: ['id','job_card_id','item_type','description','quantity','unit_cost','created_at'] },
  { name: 'job_card_templates', cols: ['id','name','job_type','description','items','created_by','created_at'] },
  { name: 'job_card_photos', cols: ['id','job_card_id','file_path','original_name','caption','created_by','created_at'] },
  { name: 'labour_rates', cols: ['id','name','description','item_type','unit_cost','active','created_by','created_at','updated_at'] },
  { name: 'service_records', cols: ['id','bike_id','agreement_id','job_card_id','service_date','odometer_km','service_type','description','cost','next_service_km','next_service_date','performed_by','invoice_file_path','invoice_original_name','created_at'] },
  { name: 'notifications', cols: ['id','user_id','channel','type','title','message','status','sent_at','created_at'] },
  { name: 'audit_logs', cols: ['id','actor_id','action','entity','entity_id','metadata','ip','created_at'] },
  { name: 'password_reset_tokens', cols: ['id','user_id','token_hash','expires_at','used_at','requested_ip','user_agent','created_at'] },
  { name: 'fleet_wallets', cols: ['id','organization_id','balance','total_collected','total_withdrawn','updated_at'] },
  { name: 'fleet_payout_requests', cols: ['id','organization_id','requested_by','amount_requested','withdrawal_fee','net_payout','status','bank_account_name','bank_name','bank_account_number','bank_branch_code','admin_notes','processed_by','processed_at','created_at'] },
  { name: 'fleet_wallet_transactions', cols: ['id','organization_id','type','amount','fee_amount','net_amount','description','paystack_reference','rider_user_id','payout_request_id','actor_user_id','available_at','created_at'] },
  { name: 'rider_subscriptions', cols: ['id','organization_id','rider_user_id','agreement_id','paystack_subscription_code','paystack_customer_code','plan_code','weekly_amount','status','created_at','updated_at'] },
  { name: 'collections_actions', cols: ['id','agreement_id','organization_id','stage','action_type','notes','outcome','next_action_date','created_by','created_at'] },
  { name: 'api_keys', cols: ['id','organization_id','created_by','name','key_hash','key_prefix','last_used_at','revoked_at','created_at'] },
  { name: 'fleet_owner_pilot_leads', cols: ['id','company_name','contact_name','email','phone','city','fleet_size','plan_interest','wants_demo','notes','status','source','demo_at','internal_notes','converted_org_id','created_at','updated_at'] },
];

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('ERROR: DATABASE_URL is not set.');
    process.exit(1);
  }

  console.log(`\n── Migrating business data SQLite → Postgres (schema: ${SCHEMA}) ──\n`);

  for (const t of TABLES) {
    await insertBatched(t.name, t.cols);
    if (!t.noSequence) await resetSequence(t.name);
  }

  console.log('\n── Verifying row counts ──\n');
  let allMatch = true;
  for (const t of TABLES) {
    const sqliteCount = db.prepare(`SELECT COUNT(*) as n FROM ${t.name}`).get().n;
    const { rows: pgRows } = await pgDb.query(`SELECT COUNT(*) as n FROM ${T(t.name)}`);
    const pgCount = Number(pgRows[0].n);
    const match = sqliteCount === pgCount;
    if (!match) allMatch = false;
    console.log(`  ${t.name.padEnd(28)} SQLite: ${String(sqliteCount).padStart(6)}  Postgres: ${String(pgCount).padStart(6)}  ${match ? '✓' : '✗ MISMATCH'}`);
  }

  if (!allMatch) {
    console.error('\nRow count mismatch detected — see above. Not proceeding to FK-hardening migration.');
    process.exit(1);
  }

  console.log('\nAll row counts match. Data migration complete.');
  console.log('Next: run the orphan-FK / money-total / spot-check verification queries,');
  console.log('then apply the FK-hardening migration (business-data-tracking-fks).\n');
  process.exit(0);
}

main().catch(err => {
  console.error('\nFatal:', err.message);
  process.exit(1);
});
