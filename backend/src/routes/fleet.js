const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { authRequired, fleetOwnerOnly, companyRoleAllowed } = require('../middleware/auth');
const { logAudit, generateAgreementNo, buildPaymentSchedule, addDays } = require('../utils/helpers');

const router = express.Router();
const FLEET_ROLE_VALUES = ['fleet_owner_admin', 'fleet_owner_ops', 'fleet_owner_billing', 'fleet_owner_viewer'];
const MEMBER_STATUSES = ['active', 'suspended'];
const OPEN_AGREEMENT_STATUSES = ['active', 'paused', 'defaulted'];
const SERVICEABLE_BIKE_STATUSES = ['active', 'ready_to_go', 'repairs', 'not_available', 'stationary'];

router.use(authRequired, fleetOwnerOnly);

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function normalizeText(value) {
  return String(value || '').trim().toLowerCase();
}

function toInt(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function toPositiveNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function getOrganization(organizationId) {
  return db.prepare(`SELECT * FROM organizations WHERE id = ?`).get(organizationId);
}

function getOrganizationOrThrow(organizationId) {
  const organization = getOrganization(organizationId);
  if (!organization) {
    const error = new Error('Organization not found');
    error.status = 404;
    throw error;
  }
  return organization;
}

function getBikeScope(org, alias = 'b') {
  return {
    clause: `(${alias}.organization_id = ? OR (${alias}.organization_id IS NULL AND LOWER(TRIM(COALESCE(${alias}.fleet, ''))) IN (?, ?)))`,
    params: [org.id, normalizeText(org.name), normalizeText(org.slug)]
  };
}

function getFleetMembers(organizationId) {
  return db.prepare(`SELECT id, email, full_name, phone, city, role, status, created_at
    FROM users
    WHERE organization_id = ? AND deleted_at IS NULL
    ORDER BY created_at ASC`).all(organizationId);
}

function getScopedBike(org, bikeId) {
  const scope = getBikeScope(org, 'b');
  return db.prepare(`SELECT b.* FROM bikes b WHERE b.id = ? AND ${scope.clause}`).get(bikeId, ...scope.params);
}

function getScopedAgreement(org, agreementId) {
  const scope = getBikeScope(org, 'b');
  return db.prepare(`SELECT a.*, b.registration AS bike_registration, b.make AS bike_make, b.model AS bike_model, b.status AS bike_status,
      u.full_name AS rider_name, u.email AS rider_email, u.phone AS rider_phone
    FROM agreements a
    JOIN bikes b ON b.id = a.bike_id
    LEFT JOIN users u ON u.id = a.user_id
    WHERE a.id = ? AND ${scope.clause}`).get(agreementId, ...scope.params);
}

function getScopedRider(org, riderId) {
  const scope = getBikeScope(org, 'b');
  return db.prepare(`SELECT u.id, u.full_name, u.email, u.phone
    FROM users u
    WHERE u.id = ? AND u.role = 'rider' AND u.deleted_at IS NULL AND (
      EXISTS(
        SELECT 1
        FROM agreements a
        JOIN bikes b ON b.id = a.bike_id
        WHERE a.user_id = u.id AND ${scope.clause}
      )
      OR EXISTS(
        SELECT 1
        FROM applications ap
        JOIN bikes b ON b.id = ap.preferred_bike_id
        WHERE ap.user_id = u.id AND ap.status IN ('approved', 'submitted', 'under_review') AND ${scope.clause}
      )
    )`).get(riderId, ...scope.params, ...scope.params);
}

function getFleetBikes(org) {
  const scope = getBikeScope(org, 'b');
  return db.prepare(`SELECT b.id, b.registration, b.make, b.model, b.year, b.fleet, b.status, b.rental_weekly, b.total_weeks,
      b.odometer_km, b.next_service_date, b.next_service_km, b.last_location_at, b.last_known_lat, b.last_known_lng,
      a.id AS agreement_id, a.agreement_no, a.status AS agreement_status, a.weekly_amount,
      u.id AS rider_id, u.full_name AS rider_name, u.email AS rider_email, u.phone AS rider_phone,
      COALESCE((
        SELECT SUM(CASE WHEN ps.amount_due > COALESCE(ps.amount_paid, 0) THEN ps.amount_due - COALESCE(ps.amount_paid, 0) ELSE 0 END)
        FROM payment_schedules ps
        WHERE ps.agreement_id = a.id AND ps.status = 'overdue'
      ), 0) AS overdue_balance,
      COALESCE((
        SELECT SUM(COALESCE(NULLIF(p.net_amount, 0), p.amount))
        FROM payments p
        WHERE p.agreement_id = a.id AND p.status = 'success'
      ), 0) AS paid_total,
      (
        SELECT MAX(s.service_date)
        FROM service_records s
        WHERE s.bike_id = b.id AND s.service_date <= date('now')
      ) AS last_service_date
    FROM bikes b
    LEFT JOIN agreements a ON a.id = (
      SELECT a2.id
      FROM agreements a2
      WHERE a2.bike_id = b.id
      ORDER BY CASE
        WHEN a2.status = 'active' THEN 0
        WHEN a2.status = 'paused' THEN 1
        WHEN a2.status = 'defaulted' THEN 2
        WHEN a2.status = 'completed' THEN 3
        ELSE 4
      END, a2.created_at DESC, a2.id DESC
      LIMIT 1
    )
    LEFT JOIN users u ON u.id = a.user_id
    WHERE ${scope.clause}
    ORDER BY CASE
      WHEN b.status = 'active' THEN 0
      WHEN b.status = 'ready_to_go' THEN 1
      WHEN b.status = 'repairs' THEN 2
      ELSE 3
    END,
    COALESCE(b.next_service_date, '9999-12-31') ASC,
    COALESCE(b.registration, '') ASC,
    b.id DESC`).all(...scope.params);
}

function getFleetAgreements(org) {
  const scope = getBikeScope(org, 'b');
  return db.prepare(`SELECT a.id, a.agreement_no, a.status, a.weekly_amount, a.total_amount, a.total_weeks, a.start_date, a.end_date, a.notes,
      b.id AS bike_id, b.registration AS bike_registration, b.make, b.model, b.status AS bike_status,
      u.id AS rider_id, u.full_name AS rider_name, u.email AS rider_email, u.phone AS rider_phone,
      COALESCE((
        SELECT SUM(COALESCE(NULLIF(p.net_amount, 0), p.amount))
        FROM payments p
        WHERE p.agreement_id = a.id AND p.status = 'success'
      ), 0) AS paid_total,
      COALESCE((
        SELECT SUM(CASE WHEN ps.amount_due > COALESCE(ps.amount_paid, 0) THEN ps.amount_due - COALESCE(ps.amount_paid, 0) ELSE 0 END)
        FROM payment_schedules ps
        WHERE ps.agreement_id = a.id AND ps.status = 'overdue'
      ), 0) AS overdue_balance
    FROM agreements a
    JOIN bikes b ON b.id = a.bike_id
    LEFT JOIN users u ON u.id = a.user_id
    WHERE ${scope.clause}
    ORDER BY CASE
      WHEN a.status = 'defaulted' THEN 0
      WHEN a.status = 'active' THEN 1
      WHEN a.status = 'paused' THEN 2
      ELSE 3
    END,
    a.created_at DESC,
    a.id DESC`).all(...scope.params).map((agreement) => ({
      ...agreement,
      remaining_balance: Math.max(Number(agreement.total_amount || 0) - Number(agreement.paid_total || 0), 0)
    }));
}

function getRecentServices(org) {
  const scope = getBikeScope(org, 'b');
  return db.prepare(`SELECT s.id, s.bike_id, s.agreement_id, s.service_date, s.odometer_km, s.service_type, s.description, s.cost,
      s.next_service_km, s.next_service_date, s.performed_by, s.invoice_file_path, s.invoice_original_name, s.created_at,
      b.registration, b.make, b.model
    FROM service_records s
    JOIN bikes b ON b.id = s.bike_id
    WHERE ${scope.clause}
    ORDER BY s.service_date DESC, s.id DESC
    LIMIT 25`).all(...scope.params);
}

function getRiderOptions(org) {
  const scope = getBikeScope(org, 'b');
  return db.prepare(`SELECT DISTINCT u.id, u.full_name, u.email, u.phone,
      CASE WHEN EXISTS(
        SELECT 1 FROM agreements a2
        WHERE a2.user_id = u.id AND a2.status IN ('active', 'paused', 'defaulted')
      ) THEN 1 ELSE 0 END AS has_open_agreement,
      (
        SELECT b2.registration
        FROM agreements a3
        JOIN bikes b2 ON b2.id = a3.bike_id
        WHERE a3.user_id = u.id AND a3.status IN ('active', 'paused', 'defaulted')
        ORDER BY CASE
          WHEN a3.status = 'active' THEN 0
          WHEN a3.status = 'paused' THEN 1
          ELSE 2
        END, a3.created_at DESC, a3.id DESC
        LIMIT 1
      ) AS current_bike_registration
    FROM users u
    WHERE u.role = 'rider' AND u.deleted_at IS NULL AND (
      EXISTS(
        SELECT 1
        FROM agreements a
        JOIN bikes b ON b.id = a.bike_id
        WHERE a.user_id = u.id AND ${scope.clause}
      )
      OR EXISTS(
        SELECT 1
        FROM applications ap
        JOIN bikes b ON b.id = ap.preferred_bike_id
        WHERE ap.user_id = u.id AND ap.status IN ('approved', 'submitted', 'under_review') AND ${scope.clause}
      )
    )
    ORDER BY has_open_agreement ASC, u.full_name ASC`).all(...scope.params, ...scope.params);
}

function buildCollectionsQueue(agreements) {
  return agreements
    .filter((agreement) => Number(agreement.overdue_balance || 0) > 0 || agreement.status === 'defaulted')
    .sort((a, b) => Number(b.overdue_balance || 0) - Number(a.overdue_balance || 0))
    .slice(0, 8)
    .map((agreement) => ({
      agreement_id: agreement.id,
      agreement_no: agreement.agreement_no,
      rider_name: agreement.rider_name,
      bike_registration: agreement.bike_registration,
      amount: Number(agreement.overdue_balance || 0),
      stage: agreement.status === 'defaulted' ? 'Default action' : 'Overdue this week',
      note: agreement.status === 'defaulted'
        ? 'Review rider performance, confirm payment plan, and decide whether reassignment is required.'
        : 'Send a reminder and confirm collection follow-up before the next weekly cutoff.'
    }));
}

function buildSummary(bikes, agreements, members, recentServices) {
  const today = todayIso();
  const weekAhead = addDays(today, 7);
  const activeBikes = bikes.filter((bike) => bike.status === 'active').length;
  const readyBikes = bikes.filter((bike) => bike.status === 'ready_to_go').length;
  const repairBikes = bikes.filter((bike) => bike.status === 'repairs').length;
  const defaultedAgreements = agreements.filter((agreement) => agreement.status === 'defaulted').length;
  const overdueAmount = agreements.reduce((sum, agreement) => sum + Number(agreement.overdue_balance || 0), 0);
  const openAgreements = agreements.filter((agreement) => OPEN_AGREEMENT_STATUSES.includes(agreement.status)).length;
  const adminSeatsUsed = members.filter((member) => ['fleet_owner_admin', 'fleet_owner_ops', 'fleet_owner_billing'].includes(member.role)).length;
  const upcomingServices = bikes.filter((bike) => bike.next_service_date && bike.next_service_date >= today).length;
  const dueThisWeek = bikes.filter((bike) => bike.next_service_date && bike.next_service_date >= today && bike.next_service_date <= weekAhead).length;
  return {
    bike_count: bikes.length,
    active_bikes: activeBikes,
    ready_bikes: readyBikes,
    bikes_in_repairs: repairBikes,
    open_agreements: openAgreements,
    defaulted_agreements: defaultedAgreements,
    overdue_amount: +overdueAmount.toFixed(2),
    admin_seats_used: adminSeatsUsed,
    assigned_riders: bikes.filter((bike) => bike.rider_id).length,
    upcoming_services: upcomingServices,
    due_this_week: dueThisWeek,
    recent_service_logs: recentServices.length
  };
}

function getPortalData(org) {
  const members = getFleetMembers(org.id);
  const bikes = getFleetBikes(org);
  const agreements = getFleetAgreements(org);
  const recentServices = getRecentServices(org);
  const upcomingServices = bikes
    .filter((bike) => bike.next_service_date)
    .sort((a, b) => String(a.next_service_date).localeCompare(String(b.next_service_date)))
    .slice(0, 12)
    .map((bike) => ({
      bike_id: bike.id,
      registration: bike.registration,
      bike_label: [bike.make, bike.model].filter(Boolean).join(' '),
      rider_name: bike.rider_name,
      next_service_date: bike.next_service_date,
      next_service_km: bike.next_service_km,
      odometer_km: bike.odometer_km,
      status: bike.status
    }));

  return {
    organization: org,
    members,
    bikes,
    agreements,
    recent_services: recentServices,
    upcoming_services: upcomingServices,
    rider_options: getRiderOptions(org),
    collections_queue: buildCollectionsQueue(agreements),
    summary: buildSummary(bikes, agreements, members, recentServices),
    live_updated_at: new Date().toISOString()
  };
}

router.get('/account', (req, res) => {
  const organization = getOrganization(req.user.organization_id);
  if (!organization) return res.status(404).json({ error: 'Organization not found' });
  const members = getFleetMembers(req.user.organization_id);
  res.json({ organization, members });
});

router.get('/portal-data', (req, res) => {
  try {
    const organization = getOrganizationOrThrow(req.user.organization_id);
    res.json(getPortalData(organization));
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || 'Could not load fleet portal data' });
  }
});

router.post('/team-members', companyRoleAllowed(['fleet_owner_admin']), (req, res) => {
  const full_name = String(req.body.full_name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const phone = String(req.body.phone || '').trim();
  const city = String(req.body.city || '').trim();
  const role = String(req.body.role || 'fleet_owner_viewer').trim();

  if (!full_name || !email || !password) {
    return res.status(400).json({ error: 'Full name, email, and password are required' });
  }
  if (!email.includes('@')) return res.status(400).json({ error: 'Valid email required' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  if (!FLEET_ROLE_VALUES.includes(role)) return res.status(400).json({ error: 'Invalid fleet-owner role' });

  const existing = db.prepare('SELECT id FROM users WHERE email = ? AND deleted_at IS NULL').get(email);
  if (existing) return res.status(409).json({ error: 'Email already registered' });

  const organization = db.prepare(`SELECT id, max_admin_users FROM organizations WHERE id = ?`).get(req.user.organization_id);
  const adminRoles = ['fleet_owner_admin', 'fleet_owner_ops', 'fleet_owner_billing'];
  const isAdminSeat = adminRoles.includes(role);
  if (isAdminSeat) {
    const usedSeats = db.prepare(`SELECT COUNT(*) c FROM users
      WHERE organization_id = ? AND deleted_at IS NULL AND role IN ('fleet_owner_admin','fleet_owner_ops','fleet_owner_billing')`).get(req.user.organization_id).c;
    if (usedSeats >= Number(organization?.max_admin_users || 0)) {
      return res.status(400).json({ error: 'Plan admin-seat limit reached for this organization' });
    }
  }

  const password_hash = bcrypt.hashSync(password, 10);
  const info = db.prepare(`INSERT INTO users
    (email, password_hash, full_name, phone, city, role, organization_id, status)
    VALUES (?,?,?,?,?,?,?, 'active')`).run(
      email,
      password_hash,
      full_name,
      phone || null,
      city || null,
      role,
      req.user.organization_id
    );

  logAudit(req.user.id, 'fleet_owner.team_member_create', 'users', info.lastInsertRowid, { role, organization_id: req.user.organization_id }, req.ip);
  const member = db.prepare(`SELECT id, email, full_name, phone, city, role, status, created_at FROM users WHERE id = ?`).get(info.lastInsertRowid);
  res.status(201).json({ ok: true, member });
});

router.patch('/team-members/:id', companyRoleAllowed(['fleet_owner_admin']), (req, res) => {
  const memberId = Number(req.params.id);
  if (!Number.isInteger(memberId) || memberId <= 0) return res.status(400).json({ error: 'Invalid team member id' });

  const member = db.prepare(`SELECT id, role, status, organization_id FROM users WHERE id = ? AND deleted_at IS NULL`).get(memberId);
  if (!member || member.organization_id !== req.user.organization_id) {
    return res.status(404).json({ error: 'Team member not found' });
  }
  if (member.id === req.user.id && req.body.status === 'suspended') {
    return res.status(400).json({ error: 'You cannot suspend your own account' });
  }

  const nextRole = req.body.role === undefined ? member.role : String(req.body.role).trim();
  const nextStatus = req.body.status === undefined ? member.status : String(req.body.status).trim();
  if (!FLEET_ROLE_VALUES.includes(nextRole)) return res.status(400).json({ error: 'Invalid role value' });
  if (!MEMBER_STATUSES.includes(nextStatus)) return res.status(400).json({ error: 'Invalid status value' });

  db.prepare(`UPDATE users SET role = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(nextRole, nextStatus, memberId);
  logAudit(req.user.id, 'fleet_owner.team_member_update', 'users', memberId, {
    previous_role: member.role,
    next_role: nextRole,
    previous_status: member.status,
    next_status: nextStatus
  }, req.ip);

  const updated = db.prepare(`SELECT id, email, full_name, phone, city, role, status, created_at FROM users WHERE id = ?`).get(memberId);
  res.json({ ok: true, member: updated });
});

router.post('/allocations', companyRoleAllowed(['fleet_owner_admin', 'fleet_owner_ops']), (req, res) => {
  try {
    const organization = getOrganizationOrThrow(req.user.organization_id);
    const bikeId = toInt(req.body.bike_id);
    const riderId = toInt(req.body.rider_id);
    const startDate = String(req.body.start_date || todayIso()).slice(0, 10);

    if (!bikeId || !riderId) {
      return res.status(400).json({ error: 'Bike and rider are required' });
    }

    const bike = getScopedBike(organization, bikeId);
    if (!bike) return res.status(404).json({ error: 'Bike not found in your fleet' });
    if (bike.status !== 'ready_to_go') return res.status(400).json({ error: 'Bike must be ready to go before allocation' });

    const rider = getScopedRider(organization, riderId);
    if (!rider) return res.status(404).json({ error: 'Rider not available for your fleet' });

    const riderHasOpenAgreement = db.prepare(`SELECT id FROM agreements WHERE user_id = ? AND status IN ('active', 'paused', 'defaulted') LIMIT 1`).get(riderId);
    if (riderHasOpenAgreement) return res.status(400).json({ error: 'Rider already has an open agreement' });

    const bikeHasOpenAgreement = db.prepare(`SELECT id FROM agreements WHERE bike_id = ? AND status IN ('active', 'paused', 'defaulted') LIMIT 1`).get(bikeId);
    if (bikeHasOpenAgreement) return res.status(400).json({ error: 'Bike already has an open agreement' });

    const weeklyAmount = toPositiveNumber(req.body.weekly_amount) || toPositiveNumber(bike.rental_weekly);
    const totalWeeks = toInt(req.body.total_weeks) || toInt(bike.total_weeks) || 78;
    if (!weeklyAmount) return res.status(400).json({ error: 'Weekly amount must be greater than zero' });

    const totalAmount = +(weeklyAmount * totalWeeks).toFixed(2);
    const endDate = addDays(startDate, totalWeeks * 7);
    const agreementNo = generateAgreementNo();
    const note = String(req.body.notes || '').trim() || null;

    const matchingApplication = db.prepare(`SELECT ap.id
      FROM applications ap
      LEFT JOIN bikes b ON b.id = ap.preferred_bike_id
      WHERE ap.user_id = ?
        AND ap.status IN ('approved', 'submitted', 'under_review')
        AND (ap.preferred_bike_id = ? OR ap.preferred_bike_id IS NULL OR b.organization_id = ?)
      ORDER BY CASE WHEN ap.preferred_bike_id = ? THEN 0 ELSE 1 END, ap.submitted_at DESC, ap.id DESC
      LIMIT 1`).get(riderId, bikeId, organization.id, bikeId);

    const created = db.transaction(() => {
      const info = db.prepare(`INSERT INTO agreements
        (agreement_no, user_id, bike_id, application_id, weekly_amount, total_weeks, total_amount, start_date, end_date, status, notes, created_by)
        VALUES (?,?,?,?,?,?,?,?,?, 'active', ?, ?)`).run(
          agreementNo,
          riderId,
          bikeId,
          matchingApplication?.id || null,
          weeklyAmount,
          totalWeeks,
          totalAmount,
          startDate,
          endDate,
          note,
          req.user.id
        );
      buildPaymentSchedule(info.lastInsertRowid, weeklyAmount, totalWeeks, startDate);
      db.prepare(`UPDATE bikes SET status = 'active' WHERE id = ?`).run(bikeId);
      return info.lastInsertRowid;
    })();

    logAudit(req.user.id, 'fleet_owner.allocate_rider', 'agreements', created, {
      organization_id: organization.id,
      bike_id: bikeId,
      rider_id: riderId,
      weekly_amount: weeklyAmount,
      total_weeks: totalWeeks,
      start_date: startDate
    }, req.ip);

    const agreement = getScopedAgreement(organization, created);
    res.status(201).json({ ok: true, agreement });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || 'Could not allocate rider' });
  }
});

router.post('/reassignments', companyRoleAllowed(['fleet_owner_admin', 'fleet_owner_ops']), (req, res) => {
  try {
    const organization = getOrganizationOrThrow(req.user.organization_id);
    const agreementId = toInt(req.body.agreement_id);
    const targetBikeId = toInt(req.body.target_bike_id);
    const note = String(req.body.note || '').trim();

    if (!agreementId || !targetBikeId) {
      return res.status(400).json({ error: 'Agreement and target bike are required' });
    }

    const agreement = getScopedAgreement(organization, agreementId);
    if (!agreement) return res.status(404).json({ error: 'Agreement not found in your fleet' });
    if (!OPEN_AGREEMENT_STATUSES.includes(agreement.status)) {
      return res.status(400).json({ error: 'Only open agreements can be reassigned' });
    }

    const sourceBike = getScopedBike(organization, agreement.bike_id);
    const targetBike = getScopedBike(organization, targetBikeId);
    if (!targetBike) return res.status(404).json({ error: 'Target bike not found in your fleet' });
    if (Number(agreement.bike_id) === Number(targetBikeId)) return res.status(400).json({ error: 'Choose a different bike for reassignment' });
    if (targetBike.status !== 'ready_to_go') return res.status(400).json({ error: 'Target bike must be ready to go' });

    const targetHasOpenAgreement = db.prepare(`SELECT id FROM agreements WHERE bike_id = ? AND status IN ('active', 'paused', 'defaulted') LIMIT 1`).get(targetBikeId);
    if (targetHasOpenAgreement) return res.status(400).json({ error: 'Target bike already has an open agreement' });

    db.transaction(() => {
      db.prepare(`UPDATE agreements
        SET bike_id = ?,
            notes = CASE
              WHEN ? IS NOT NULL AND TRIM(?) <> '' THEN TRIM(COALESCE(notes, '') || CASE WHEN COALESCE(notes, '') = '' THEN '' ELSE '\n' END || ?)
              ELSE notes
            END
        WHERE id = ?`).run(targetBikeId, note || null, note || null, note || null, agreementId);

      if (sourceBike?.status === 'active') {
        db.prepare(`UPDATE bikes SET status = 'ready_to_go' WHERE id = ?`).run(sourceBike.id);
      }
      db.prepare(`UPDATE bikes SET status = 'active' WHERE id = ?`).run(targetBikeId);
    })();

    logAudit(req.user.id, 'fleet_owner.reassign_bike', 'agreements', agreementId, {
      organization_id: organization.id,
      previous_bike_id: agreement.bike_id,
      target_bike_id: targetBikeId,
      rider_id: agreement.user_id,
      note: note || null
    }, req.ip);

    const updatedAgreement = getScopedAgreement(organization, agreementId);
    res.json({ ok: true, agreement: updatedAgreement });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || 'Could not reassign bike' });
  }
});

router.post('/maintenance/schedule', companyRoleAllowed(['fleet_owner_admin', 'fleet_owner_ops']), (req, res) => {
  try {
    const organization = getOrganizationOrThrow(req.user.organization_id);
    const bikeId = toInt(req.body.bike_id);
    const nextServiceDate = String(req.body.next_service_date || '').trim() || null;
    const nextServiceKm = req.body.next_service_km === '' || req.body.next_service_km === undefined ? null : Number(req.body.next_service_km);
    const odometerKm = req.body.odometer_km === '' || req.body.odometer_km === undefined ? null : Number(req.body.odometer_km);

    if (!bikeId) return res.status(400).json({ error: 'Bike is required' });
    if (!nextServiceDate && !Number.isFinite(nextServiceKm)) {
      return res.status(400).json({ error: 'Provide a next service date or odometer target' });
    }

    const bike = getScopedBike(organization, bikeId);
    if (!bike) return res.status(404).json({ error: 'Bike not found in your fleet' });

    db.prepare(`UPDATE bikes
      SET next_service_date = ?,
          next_service_km = ?,
          odometer_km = COALESCE(?, odometer_km)
      WHERE id = ?`).run(nextServiceDate, Number.isFinite(nextServiceKm) ? nextServiceKm : null, Number.isFinite(odometerKm) ? odometerKm : null, bikeId);

    logAudit(req.user.id, 'fleet_owner.maintenance_schedule', 'bikes', bikeId, {
      organization_id: organization.id,
      next_service_date: nextServiceDate,
      next_service_km: Number.isFinite(nextServiceKm) ? nextServiceKm : null,
      odometer_km: Number.isFinite(odometerKm) ? odometerKm : null,
      notes: String(req.body.notes || '').trim() || null
    }, req.ip);

    res.json({ ok: true, bike: getScopedBike(organization, bikeId) });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || 'Could not schedule maintenance' });
  }
});

router.post('/maintenance/log', companyRoleAllowed(['fleet_owner_admin', 'fleet_owner_ops']), (req, res) => {
  try {
    const organization = getOrganizationOrThrow(req.user.organization_id);
    const bikeId = toInt(req.body.bike_id);
    const serviceDate = String(req.body.service_date || '').trim();
    const serviceType = String(req.body.service_type || '').trim();
    const bikeStatusAfterService = String(req.body.bike_status_after_service || '').trim();

    if (!bikeId || !serviceDate || !serviceType) {
      return res.status(400).json({ error: 'Bike, service date, and service type are required' });
    }

    const bike = getScopedBike(organization, bikeId);
    if (!bike) return res.status(404).json({ error: 'Bike not found in your fleet' });
    if (bikeStatusAfterService && !SERVICEABLE_BIKE_STATUSES.includes(bikeStatusAfterService)) {
      return res.status(400).json({ error: 'Invalid bike status after service' });
    }

    const cost = req.body.cost === '' || req.body.cost === undefined ? 0 : Number(req.body.cost);
    const odometerKm = req.body.odometer_km === '' || req.body.odometer_km === undefined ? null : Number(req.body.odometer_km);
    const nextServiceKm = req.body.next_service_km === '' || req.body.next_service_km === undefined ? null : Number(req.body.next_service_km);
    const nextServiceDate = String(req.body.next_service_date || '').trim() || null;
    const description = String(req.body.description || '').trim() || null;
    const performedBy = String(req.body.performed_by || '').trim() || null;
    const currentAgreement = db.prepare(`SELECT id FROM agreements
      WHERE bike_id = ? AND status IN ('active', 'paused', 'defaulted')
      ORDER BY CASE
        WHEN status = 'active' THEN 0
        WHEN status = 'paused' THEN 1
        ELSE 2
      END, created_at DESC, id DESC
      LIMIT 1`).get(bikeId);

    const info = db.transaction(() => {
      const insert = db.prepare(`INSERT INTO service_records
        (bike_id, agreement_id, service_date, odometer_km, service_type, description, cost, next_service_km, next_service_date, performed_by)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
          bikeId,
          currentAgreement?.id || null,
          serviceDate,
          Number.isFinite(odometerKm) ? odometerKm : null,
          serviceType,
          description,
          Number.isFinite(cost) ? cost : 0,
          Number.isFinite(nextServiceKm) ? nextServiceKm : null,
          nextServiceDate,
          performedBy
        );

      const bikeSets = [];
      const bikeVals = [];
      if (Number.isFinite(odometerKm)) {
        bikeSets.push('odometer_km = ?');
        bikeVals.push(odometerKm);
      }
      if (nextServiceDate !== null) {
        bikeSets.push('next_service_date = ?');
        bikeVals.push(nextServiceDate);
      }
      if (Number.isFinite(nextServiceKm)) {
        bikeSets.push('next_service_km = ?');
        bikeVals.push(nextServiceKm);
      }
      if (bikeStatusAfterService) {
        bikeSets.push('status = ?');
        bikeVals.push(bikeStatusAfterService);
      }
      if (bikeSets.length) {
        bikeVals.push(bikeId);
        db.prepare(`UPDATE bikes SET ${bikeSets.join(', ')} WHERE id = ?`).run(...bikeVals);
      }
      return insert.lastInsertRowid;
    })();

    logAudit(req.user.id, 'fleet_owner.maintenance_log', 'service_records', info, {
      organization_id: organization.id,
      bike_id: bikeId,
      service_type: serviceType,
      service_date: serviceDate,
      bike_status_after_service: bikeStatusAfterService || null
    }, req.ip);

    res.status(201).json({ ok: true, service_id: info });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || 'Could not log maintenance' });
  }
});

module.exports = router;
