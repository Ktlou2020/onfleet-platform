'use strict';

/**
 * Creates the core business-data tables (users, organizations, bikes,
 * agreements, payments, wallets, KYC, audit logs, job cards, etc.) in
 * Postgres, consolidating them alongside the tracking tables already
 * created by src/migrations/trackingPgSchema.js.
 *
 * This is the FINAL shape of each table as it exists in SQLite today
 * (backend/src/db.js) after all of that file's runtime ALTER-TABLE-rebuild
 * migrations — not a replay of that history. See CHECK constraints below
 * for the exact allowed enum values, several of which were widened over
 * time in db.js (e.g. users.role gained 'technician'/'control_room',
 * agreements.status gained 'discontinued', job_cards.status gained
 * 'quoted', fleet_wallet_transactions.type gained 'adjustment').
 *
 * Deliberate deviations from a strict 1:1 SQLite translation (see the
 * migration plan for full reasoning):
 *  - Money columns (REAL in SQLite) become NUMERIC(12,2) — this is the
 *    system of record for real currency going forward.
 *  - Boolean-as-0/1-integer columns become real BOOLEAN.
 *  - Date-only TEXT columns (YYYY-MM-DD) become DATE, not TIMESTAMPTZ.
 *  - users.deleted_at is declared TEXT in SQLite but is actually written
 *    via CURRENT_TIMESTAMP — mapped to TIMESTAMPTZ here, not DATE.
 *  - JSON-as-TEXT columns (applications.references_json,
 *    job_card_templates.items) stay TEXT, matching the precedent already
 *    set by alert_settings.recipient_user_ids in the tracking schema.
 *
 * No FKs into the tracking tables are added here — see the follow-up
 * migration (business-data-tracking-fks), which must run only after the
 * data migration is verified, since adding a validated FK against a
 * populated tracking table would fail on any pre-existing orphaned row.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE organizations (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      contact_email TEXT,
      contact_phone TEXT,
      city TEXT,
      fleet_size INTEGER DEFAULT 0,
      plan_key TEXT NOT NULL DEFAULT 'trial' CHECK (plan_key IN ('trial','small','medium','large','enterprise')),
      status TEXT NOT NULL DEFAULT 'trialing' CHECK (status IN ('trialing','active','past_due','suspended','cancelled')),
      trial_started_at TIMESTAMPTZ,
      trial_ends_at TIMESTAMPTZ,
      paystack_customer_code TEXT,
      paystack_subscription_code TEXT,
      max_bikes INTEGER DEFAULT 10,
      max_admin_users INTEGER DEFAULT 2,
      bank_account_name TEXT,
      bank_name TEXT,
      bank_account_number TEXT,
      bank_branch_code TEXT,
      address TEXT,
      registration_number TEXT,
      vat_number TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX idx_org_slug ON organizations(slug);

    -- Key-value settings store; no serial id.
    CREATE TABLE app_settings (
      setting_key TEXT PRIMARY KEY,
      setting_value TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE hubs (
      id SERIAL PRIMARY KEY,
      organization_id INTEGER NOT NULL REFERENCES organizations(id),
      name TEXT NOT NULL,
      address TEXT,
      city TEXT,
      contact_name TEXT,
      contact_phone TEXT,
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX idx_hubs_org ON hubs(organization_id);

    CREATE TABLE users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      phone TEXT,
      password_hash TEXT NOT NULL,
      full_name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'rider' CHECK (role IN (
        'rider','admin','superadmin','fleet_owner_admin','fleet_owner_ops',
        'fleet_owner_billing','fleet_owner_viewer','technician','control_room'
      )),
      organization_id INTEGER REFERENCES organizations(id),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
      id_number TEXT,
      date_of_birth DATE,
      address TEXT,
      city TEXT,
      province TEXT,
      postal_code TEXT,
      emergency_contact_name TEXT,
      emergency_contact_phone TEXT,
      avatar_url TEXT,
      country_of_origin TEXT,
      user_tags TEXT,
      deleted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX idx_users_org ON users(organization_id, role);

    CREATE TABLE bikes (
      id SERIAL PRIMARY KEY,
      vin TEXT UNIQUE NOT NULL,
      registration TEXT UNIQUE,
      make TEXT NOT NULL,
      model TEXT NOT NULL,
      fleet TEXT,
      organization_id INTEGER REFERENCES organizations(id),
      hub_id INTEGER REFERENCES hubs(id),
      year INTEGER,
      engine_cc INTEGER,
      color TEXT,
      condition TEXT NOT NULL DEFAULT 'new' CHECK (condition IN ('new','used')),
      purchase_price NUMERIC(12,2),
      rental_weekly NUMERIC(12,2) NOT NULL,
      total_weeks NUMERIC(6,1) NOT NULL DEFAULT 78,
      status TEXT NOT NULL DEFAULT 'ready_to_go' CHECK (status IN (
        'active','not_available','sold','paid_off','written_off','stolen','repairs','ready_to_go','stationary'
      )),
      gps_device_id TEXT,
      last_known_lat REAL,
      last_known_lng REAL,
      last_location_at TIMESTAMPTZ,
      -- NUMERIC not INTEGER: incremented by fractional trip distances
      -- (tripService.js rounds to 2 decimal places). SQLite's dynamic typing
      -- silently tolerated this on an INTEGER-declared column; Postgres
      -- correctly rejects a fractional value bound to a true integer column.
      odometer_km NUMERIC(10,2) DEFAULT 0,
      next_service_km INTEGER,
      next_service_date DATE,
      insurance_provider TEXT,
      insurance_policy_no TEXT,
      insurance_expiry DATE,
      license_disc_no TEXT,
      license_disc_expiry DATE,
      rc1_file_path TEXT,
      rc1_original_name TEXT,
      license_disc_file_path TEXT,
      license_disc_original_name TEXT,
      image_url TEXT,
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX idx_bikes_org_status ON bikes(organization_id, status);

    CREATE TABLE kyc_documents (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      doc_type TEXT NOT NULL CHECK (doc_type IN ('id_document','proof_of_address','drivers_license','bank_statement','selfie','other')),
      file_path TEXT NOT NULL,
      original_name TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
      rejection_reason TEXT,
      reviewed_by INTEGER REFERENCES users(id),
      reviewed_at TIMESTAMPTZ,
      uploaded_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX idx_kyc_user ON kyc_documents(user_id);

    CREATE TABLE applications (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      preferred_bike_id INTEGER REFERENCES bikes(id),
      employment_status TEXT,
      monthly_income NUMERIC(20,2),
      delivery_platforms TEXT,
      has_riding_experience BOOLEAN DEFAULT FALSE,
      years_riding NUMERIC(4,1),
      has_drivers_license BOOLEAN DEFAULT FALSE,
      references_json TEXT,
      payout_preference TEXT,
      bank_name TEXT,
      account_holder TEXT,
      account_number TEXT,
      branch_code TEXT,
      ewallet_number TEXT,
      total_paid_last_3 NUMERIC(20,2) DEFAULT 0,
      average_weekly_earnings NUMERIC(20,2) DEFAULT 0,
      auto_decision TEXT,
      retry_after_date DATE,
      status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('draft','submitted','under_review','approved','rejected','withdrawn')),
      rejection_reason TEXT,
      reviewed_by INTEGER REFERENCES users(id),
      reviewed_at TIMESTAMPTZ,
      submitted_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX idx_apps_user ON applications(user_id);

    CREATE TABLE application_documents (
      id SERIAL PRIMARY KEY,
      application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      doc_type TEXT NOT NULL CHECK (doc_type IN ('id_document','drivers_license','payslip','signed_contract','unsigned_contract','other')),
      file_path TEXT NOT NULL,
      original_name TEXT,
      mime_type TEXT,
      extracted_amount NUMERIC(20,2),
      extracted_text TEXT,
      status TEXT NOT NULL DEFAULT 'uploaded' CHECK (status IN ('uploaded','verified','rejected','signed')),
      uploaded_by INTEGER REFERENCES users(id),
      uploaded_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX idx_appdocs_application ON application_documents(application_id);
    CREATE INDEX idx_appdocs_user ON application_documents(user_id);

    CREATE TABLE agreements (
      id SERIAL PRIMARY KEY,
      agreement_no TEXT UNIQUE NOT NULL,
      user_id INTEGER NOT NULL REFERENCES users(id),
      bike_id INTEGER NOT NULL REFERENCES bikes(id),
      application_id INTEGER REFERENCES applications(id),
      weekly_amount NUMERIC(12,2) NOT NULL,
      total_weeks NUMERIC(6,1) NOT NULL DEFAULT 78,
      total_amount NUMERIC(12,2) NOT NULL,
      start_date DATE NOT NULL,
      end_date DATE NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','defaulted','cancelled','paused','discontinued')),
      signed_at TIMESTAMPTZ,
      signature_data TEXT,
      discontinued_reason TEXT,
      discontinued_at TIMESTAMPTZ,
      reinstated_at TIMESTAMPTZ,
      contract_pdf_path TEXT,
      contract_file_path TEXT,
      signed_contract_path TEXT,
      notes TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE payment_schedules (
      id SERIAL PRIMARY KEY,
      agreement_id INTEGER NOT NULL REFERENCES agreements(id) ON DELETE CASCADE,
      week_number INTEGER NOT NULL,
      due_date DATE NOT NULL,
      amount_due NUMERIC(12,2) NOT NULL,
      amount_paid NUMERIC(12,2) NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','partial','overdue','waived')),
      paid_at TIMESTAMPTZ,
      UNIQUE (agreement_id, week_number)
    );
    CREATE INDEX idx_schedule_agreement ON payment_schedules(agreement_id);

    CREATE TABLE payments (
      id SERIAL PRIMARY KEY,
      agreement_id INTEGER NOT NULL REFERENCES agreements(id),
      user_id INTEGER NOT NULL REFERENCES users(id),
      schedule_id INTEGER REFERENCES payment_schedules(id),
      amount NUMERIC(12,2) NOT NULL,
      currency TEXT NOT NULL DEFAULT 'ZAR',
      method TEXT NOT NULL CHECK (method IN ('paystack','eft','cash','card','other')),
      reference TEXT UNIQUE,
      paystack_reference TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','success','failed','refunded','reversed')),
      paid_at TIMESTAMPTZ,
      recorded_by INTEGER REFERENCES users(id),
      notes TEXT,
      fee_amount NUMERIC(12,2) DEFAULT 0,
      net_amount NUMERIC(12,2) DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX idx_payments_agreement ON payments(agreement_id);

    CREATE TABLE job_cards (
      id SERIAL PRIMARY KEY,
      bike_id INTEGER REFERENCES bikes(id),
      vin TEXT,
      registration TEXT,
      make TEXT,
      model TEXT,
      year INTEGER,
      color TEXT,
      engine_cc INTEGER,
      fleet_owner_name TEXT,
      fleet_org_id INTEGER,
      job_type TEXT NOT NULL DEFAULT 'service' CHECK (job_type IN ('service','repair','inspection','tyres','brakes','electrical','bodywork','other')),
      description TEXT,
      technician_notes TEXT,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','quoted','in_progress','completed','cancelled')),
      priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
      technician_id INTEGER REFERENCES users(id),
      created_by INTEGER REFERENCES users(id),
      started_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      completion_notes TEXT,
      odometer_km NUMERIC(10,2),
      next_service_date DATE,
      next_service_km INTEGER,
      bike_status_after TEXT,
      paused_at TIMESTAMPTZ,
      total_paused_seconds INTEGER DEFAULT 0,
      quote_approved_at TIMESTAMPTZ,
      quote_approved_by INTEGER,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX idx_job_cards_status ON job_cards(status, created_at DESC);
    CREATE INDEX idx_job_cards_bike ON job_cards(bike_id);

    CREATE TABLE job_card_items (
      id SERIAL PRIMARY KEY,
      job_card_id INTEGER NOT NULL REFERENCES job_cards(id) ON DELETE CASCADE,
      item_type TEXT NOT NULL DEFAULT 'labor' CHECK (item_type IN ('labor','part','consumable','other')),
      description TEXT NOT NULL,
      quantity NUMERIC(12,2) NOT NULL DEFAULT 1,
      unit_cost NUMERIC(12,2) NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX idx_job_card_items_card ON job_card_items(job_card_id);

    CREATE TABLE job_card_templates (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      job_type TEXT NOT NULL DEFAULT 'service',
      description TEXT,
      items TEXT NOT NULL DEFAULT '[]',
      created_by INTEGER REFERENCES users(id),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE job_card_photos (
      id SERIAL PRIMARY KEY,
      job_card_id INTEGER NOT NULL REFERENCES job_cards(id) ON DELETE CASCADE,
      file_path TEXT NOT NULL,
      original_name TEXT,
      caption TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX idx_job_card_photos_card ON job_card_photos(job_card_id);

    CREATE TABLE labour_rates (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      item_type TEXT NOT NULL DEFAULT 'labor' CHECK (item_type IN ('labor','part','consumable','other')),
      unit_cost NUMERIC(12,2) NOT NULL DEFAULT 0,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_by INTEGER REFERENCES users(id),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX idx_labour_rates_active ON labour_rates(active, name);

    CREATE TABLE service_records (
      id SERIAL PRIMARY KEY,
      bike_id INTEGER NOT NULL REFERENCES bikes(id),
      agreement_id INTEGER REFERENCES agreements(id),
      job_card_id INTEGER REFERENCES job_cards(id),
      service_date DATE NOT NULL,
      odometer_km NUMERIC(10,2),
      service_type TEXT NOT NULL,
      description TEXT,
      cost NUMERIC(12,2) DEFAULT 0,
      next_service_km INTEGER,
      next_service_date DATE,
      performed_by TEXT,
      invoice_file_path TEXT,
      invoice_original_name TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE notifications (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      channel TEXT NOT NULL CHECK (channel IN ('email','sms','whatsapp','in_app')),
      type TEXT NOT NULL,
      title TEXT,
      message TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed','read')),
      sent_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE audit_logs (
      id SERIAL PRIMARY KEY,
      actor_id INTEGER REFERENCES users(id),
      action TEXT NOT NULL,
      entity TEXT,
      entity_id INTEGER,
      metadata TEXT,
      ip TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE password_reset_tokens (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ,
      requested_ip TEXT,
      user_agent TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX idx_password_reset_user ON password_reset_tokens(user_id, created_at DESC);
    CREATE INDEX idx_password_reset_expires ON password_reset_tokens(expires_at);

    CREATE TABLE fleet_wallets (
      id SERIAL PRIMARY KEY,
      organization_id INTEGER UNIQUE NOT NULL REFERENCES organizations(id),
      balance NUMERIC(12,2) NOT NULL DEFAULT 0,
      total_collected NUMERIC(12,2) NOT NULL DEFAULT 0,
      total_withdrawn NUMERIC(12,2) NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX idx_fleet_wallets_org ON fleet_wallets(organization_id);

    CREATE TABLE fleet_payout_requests (
      id SERIAL PRIMARY KEY,
      organization_id INTEGER NOT NULL REFERENCES organizations(id),
      requested_by INTEGER NOT NULL REFERENCES users(id),
      amount_requested NUMERIC(12,2) NOT NULL,
      withdrawal_fee NUMERIC(12,2) NOT NULL DEFAULT 0,
      net_payout NUMERIC(12,2) NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','paid','rejected')),
      bank_account_name TEXT,
      bank_name TEXT,
      bank_account_number TEXT,
      bank_branch_code TEXT,
      admin_notes TEXT,
      processed_by INTEGER REFERENCES users(id),
      processed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX idx_fleet_payout_reqs_org ON fleet_payout_requests(organization_id, created_at DESC);
    CREATE INDEX idx_fleet_payout_reqs_status ON fleet_payout_requests(status, created_at DESC);

    -- payout_request_id/actor_user_id deliberately left as plain INTEGER, no FK —
    -- SQLite never enforced one on these either; see migration plan §2.7.
    CREATE TABLE fleet_wallet_transactions (
      id SERIAL PRIMARY KEY,
      organization_id INTEGER NOT NULL REFERENCES organizations(id),
      type TEXT NOT NULL CHECK (type IN ('credit','withdrawal','withdrawal_fee','adjustment')),
      amount NUMERIC(12,2) NOT NULL,
      fee_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
      net_amount NUMERIC(12,2) NOT NULL,
      description TEXT,
      paystack_reference TEXT,
      rider_user_id INTEGER REFERENCES users(id),
      payout_request_id INTEGER,
      actor_user_id INTEGER,
      available_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX idx_fleet_wallet_txns_org ON fleet_wallet_transactions(organization_id, created_at DESC);

    CREATE TABLE rider_subscriptions (
      id SERIAL PRIMARY KEY,
      organization_id INTEGER NOT NULL REFERENCES organizations(id),
      rider_user_id INTEGER NOT NULL REFERENCES users(id),
      agreement_id INTEGER REFERENCES agreements(id),
      paystack_subscription_code TEXT,
      paystack_customer_code TEXT,
      plan_code TEXT NOT NULL,
      weekly_amount NUMERIC(12,2) NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('active','cancelled','pending')),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX idx_rider_subs_org ON rider_subscriptions(organization_id);
    CREATE INDEX idx_rider_subs_rider ON rider_subscriptions(rider_user_id);

    CREATE TABLE collections_actions (
      id SERIAL PRIMARY KEY,
      agreement_id INTEGER NOT NULL REFERENCES agreements(id),
      organization_id INTEGER NOT NULL REFERENCES organizations(id),
      stage TEXT NOT NULL DEFAULT 'pending' CHECK (stage IN ('pending','contacted','notice_sent','recovery','resolved')),
      action_type TEXT NOT NULL CHECK (action_type IN ('call','sms','whatsapp','email','visit','legal_notice','repo','note')),
      notes TEXT,
      outcome TEXT,
      next_action_date DATE,
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX idx_collections_actions_agreement ON collections_actions(agreement_id);
    CREATE INDEX idx_collections_actions_org ON collections_actions(organization_id, created_at DESC);

    CREATE TABLE api_keys (
      id SERIAL PRIMARY KEY,
      organization_id INTEGER NOT NULL REFERENCES organizations(id),
      created_by INTEGER NOT NULL REFERENCES users(id),
      name TEXT NOT NULL,
      key_hash TEXT NOT NULL UNIQUE,
      key_prefix TEXT NOT NULL,
      last_used_at TIMESTAMPTZ,
      revoked_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX idx_api_keys_org ON api_keys(organization_id);
    CREATE INDEX idx_api_keys_hash ON api_keys(key_hash);

    -- converted_org_id deliberately left as plain INTEGER, no FK — see migration plan §2.7.
    CREATE TABLE fleet_owner_pilot_leads (
      id SERIAL PRIMARY KEY,
      company_name TEXT NOT NULL,
      contact_name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT,
      city TEXT,
      fleet_size INTEGER,
      plan_interest TEXT NOT NULL DEFAULT 'trial' CHECK (plan_interest IN ('trial','small','medium','large','enterprise')),
      wants_demo BOOLEAN NOT NULL DEFAULT TRUE,
      notes TEXT,
      status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','contacted','demo_scheduled','trial_started','converted','archived')),
      source TEXT NOT NULL DEFAULT 'fleet_owner_pilot_page',
      demo_at TIMESTAMPTZ,
      internal_notes TEXT,
      converted_org_id INTEGER,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX idx_pilot_leads_status ON fleet_owner_pilot_leads(status, created_at DESC);
    CREATE INDEX idx_pilot_leads_email ON fleet_owner_pilot_leads(email);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS fleet_owner_pilot_leads;
    DROP TABLE IF EXISTS api_keys;
    DROP TABLE IF EXISTS collections_actions;
    DROP TABLE IF EXISTS rider_subscriptions;
    DROP TABLE IF EXISTS fleet_wallet_transactions;
    DROP TABLE IF EXISTS fleet_payout_requests;
    DROP TABLE IF EXISTS fleet_wallets;
    DROP TABLE IF EXISTS password_reset_tokens;
    DROP TABLE IF EXISTS audit_logs;
    DROP TABLE IF EXISTS notifications;
    DROP TABLE IF EXISTS service_records;
    DROP TABLE IF EXISTS labour_rates;
    DROP TABLE IF EXISTS job_card_photos;
    DROP TABLE IF EXISTS job_card_templates;
    DROP TABLE IF EXISTS job_card_items;
    DROP TABLE IF EXISTS job_cards;
    DROP TABLE IF EXISTS payments;
    DROP TABLE IF EXISTS payment_schedules;
    DROP TABLE IF EXISTS agreements;
    DROP TABLE IF EXISTS application_documents;
    DROP TABLE IF EXISTS applications;
    DROP TABLE IF EXISTS kyc_documents;
    DROP TABLE IF EXISTS bikes;
    DROP TABLE IF EXISTS users;
    DROP TABLE IF EXISTS hubs;
    DROP TABLE IF EXISTS app_settings;
    DROP TABLE IF EXISTS organizations;
  `);
};
