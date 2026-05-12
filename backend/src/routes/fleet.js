const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { authRequired, fleetOwnerOnly, companyRoleAllowed } = require('../middleware/auth');
const { logAudit, generateAgreementNo, buildPaymentSchedule, addDays, recalcScheduleStatuses } = require('../utils/helpers');
const { setBikeStatus } = require('../utils/bikeStatus');
const { discontinueAgreementForStolenBike, discontinueAgreement, reinstateDiscontinuedAgreement } = require('../services/agreementLifecycle');

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

function getFleetPayments(org) {
  const scope = getBikeScope(org, 'b');
  return db.prepare(`SELECT p.*, u.full_name, u.email, a.agreement_no,
      b.registration AS bike_registration, b.make, b.model, b.status AS bike_status,
      a.status AS agreement_status
    FROM payments p
    JOIN agreements a ON a.id = p.agreement_id
    JOIN bikes b ON b.id = a.bike_id
    JOIN users u ON u.id = p.user_id
    WHERE ${scope.clause}
    ORDER BY COALESCE(p.paid_at, p.created_at) DESC, p.id DESC
    LIMIT 500`).all(...scope.params);
}

function getScopedPayment(org, paymentId) {
  const scope = getBikeScope(org, 'b');
  return db.prepare(`SELECT p.*, a.agreement_no, a.status AS agreement_status,
      b.id AS bike_id, b.registration AS bike_registration, b.status AS bike_status,
      u.full_name, u.email
    FROM payments p
    JOIN agreements a ON a.id = p.agreement_id
    JOIN bikes b ON b.id = a.bike_id
    JOIN users u ON u.id = p.user_id
    WHERE p.id = ? AND ${scope.clause}`).get(paymentId, ...scope.params);
}

function creditedAmount(payment) {
  return Number(payment?.net_amount || payment?.amount || 0);
}

function applyPaymentToSchedule(agreementId, amountZAR) {
  const agreement = db.prepare('SELECT status FROM agreements WHERE id = ?').get(agreementId);
  if (!agreement) throw new Error('Agreement not found');
  if (agreement.status === 'discontinued') throw new Error('This agreement has been discontinued');
  const schedule = db.prepare(`SELECT * FROM payment_schedules WHERE agreement_id = ?
    AND status != 'paid' AND status != 'waived' ORDER BY week_number ASC`).all(agreementId);
  let remaining = amountZAR;
  const upd = db.prepare(`UPDATE payment_schedules SET amount_paid = ?, status = ?, paid_at = ? WHERE id = ?`);
  for (const row of schedule) {
    if (remaining <= 0) break;
    const owe = +(row.amount_due - row.amount_paid).toFixed(2);
    const apply = Math.min(remaining, owe);
    const newPaid = +(row.amount_paid + apply).toFixed(2);
    const status = newPaid >= row.amount_due ? 'paid' : 'partial';
    const paidAt = status === 'paid' ? new Date().toISOString() : row.paid_at;
    upd.run(newPaid, status, paidAt, row.id);
    remaining = +(remaining - apply).toFixed(2);
  }
  recalcScheduleStatuses(agreementId);
  return remaining;
}

function recordFleetManualPayment({ agreement_id, amount, method, reference, paid_at, notes, recorded_by }) {
  const agreement = db.prepare('SELECT * FROM agreements WHERE id = ?').get(agreement_id);
  if (!agreement) throw new Error('Agreement not found');
  if (agreement.status === 'discontinued') throw new Error('This agreement has been discontinued');
  const ref = reference || `FLEET-MAN-${Date.now()}`;
  const info = db.prepare(`INSERT INTO payments (agreement_id, user_id, amount, currency, method, reference, status, paid_at, recorded_by, notes, fee_amount, net_amount)
    VALUES (?,?,?,?, ?, ?, 'success', ?, ?, ?, ?, ?)`).run(
      agreement_id,
      agreement.user_id,
      Number(amount),
      'ZAR',
      method || 'eft',
      ref,
      paid_at || new Date().toISOString(),
      recorded_by || null,
      notes || null,
      0,
      Number(amount)
    );
  applyPaymentToSchedule(agreement_id, Number(amount));
  return { id: info.lastInsertRowid, reference: ref };
}

function rebuildScheduleAllocations(agreementId) {
  const today = todayIso();
  const schedules = db.prepare(`SELECT * FROM payment_schedules WHERE agreement_id = ? ORDER BY week_number ASC`).all(agreementId);
  if (!schedules.length) return;

  const reset = db.prepare(`UPDATE payment_schedules SET amount_paid = ?, paid_at = ?, status = ? WHERE id = ?`);
  for (const schedule of schedules) {
    if (schedule.status === 'waived') {
      reset.run(0, null, 'waived', schedule.id);
    } else {
      reset.run(0, null, schedule.due_date < today ? 'overdue' : 'pending', schedule.id);
    }
  }

  const payments = db.prepare(`SELECT * FROM payments WHERE agreement_id = ? AND status = 'success' ORDER BY COALESCE(paid_at, created_at) ASC, id ASC`).all(agreementId);
  const applicable = db.prepare(`SELECT * FROM payment_schedules WHERE agreement_id = ? AND status != 'waived' ORDER BY week_number ASC`).all(agreementId);
  const updateApplied = db.prepare(`UPDATE payment_schedules SET amount_paid = ?, paid_at = ?, status = ? WHERE id = ?`);

  for (const payment of payments) {
    let remaining = creditedAmount(payment);
    for (const schedule of applicable) {
      if (remaining <= 0) break;
      const owed = +(Number(schedule.amount_due) - Number(schedule.amount_paid || 0)).toFixed(2);
      if (owed <= 0) continue;
      const applied = Math.min(remaining, owed);
      schedule.amount_paid = +(Number(schedule.amount_paid || 0) + applied).toFixed(2);
      schedule.paid_at = schedule.paid_at || payment.paid_at || payment.created_at || null;
      schedule.status = schedule.amount_paid >= Number(schedule.amount_due) ? 'paid' : 'partial';
      updateApplied.run(schedule.amount_paid, schedule.paid_at, schedule.status, schedule.id);
      remaining = +(remaining - applied).toFixed(2);
    }
  }

  for (const schedule of applicable) {
    let status = schedule.status;
    if (Number(schedule.amount_paid || 0) >= Number(schedule.amount_due || 0)) status = 'paid';
    else if (Number(schedule.amount_paid || 0) > 0 && schedule.due_date < today) status = 'overdue';
    else if (Number(schedule.amount_paid || 0) > 0) status = 'partial';
    else if (schedule.due_date < today) status = 'overdue';
    else status = 'pending';
    updateApplied.run(schedule.amount_paid || 0, schedule.paid_at || null, status, schedule.id);
  }
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

router.get('/bikes', (req, res) => {
  try {
    const organization = getOrganizationOrThrow(req.user.organization_id);
    const status = String(req.query.status || '').trim();
    const fleet = String(req.query.fleet || '').trim();
    let bikes = getFleetBikes(organization);
    if (status) bikes = bikes.filter((bike) => bike.status === status);
    if (fleet) bikes = bikes.filter((bike) => String(bike.fleet || '').trim() === fleet);
    res.json({ bikes });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || 'Could not load bikes' });
  }
});

router.post('/bikes', companyRoleAllowed(['fleet_owner_admin', 'fleet_owner_ops']), (req, res) => {
  try {
    const organization = getOrganizationOrThrow(req.user.organization_id);
    const vin = String(req.body.vin || '').trim();
    const make = String(req.body.make || '').trim();
    const model = String(req.body.model || '').trim();
    const rentalWeekly = toPositiveNumber(req.body.rental_weekly);
    if (!vin || !make || !model || !rentalWeekly) {
      return res.status(400).json({ error: 'VIN, make, model, and weekly rental are required' });
    }

    const info = db.prepare(`INSERT INTO bikes
      (vin, registration, make, model, fleet, organization_id, year, engine_cc, color, condition, purchase_price,
       rental_weekly, total_weeks, status, gps_device_id, odometer_km, insurance_provider,
       insurance_policy_no, insurance_expiry, license_disc_no, license_disc_expiry, image_url, notes)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        vin,
        String(req.body.registration || '').trim() || null,
        make,
        model,
        String(req.body.fleet || '').trim() || organization.name || organization.slug || null,
        organization.id,
        toInt(req.body.year) || null,
        toInt(req.body.engine_cc) || null,
        String(req.body.color || '').trim() || null,
        String(req.body.condition || 'new').trim() || 'new',
        req.body.purchase_price === '' || req.body.purchase_price === undefined ? null : Number(req.body.purchase_price),
        rentalWeekly,
        toInt(req.body.total_weeks) || 78,
        String(req.body.status || 'ready_to_go').trim() || 'ready_to_go',
        String(req.body.gps_device_id || '').trim() || null,
        toInt(req.body.odometer_km) || 0,
        String(req.body.insurance_provider || '').trim() || null,
        String(req.body.insurance_policy_no || '').trim() || null,
        String(req.body.insurance_expiry || '').trim() || null,
        String(req.body.license_disc_no || '').trim() || null,
        String(req.body.license_disc_expiry || '').trim() || null,
        String(req.body.image_url || '').trim() || null,
        String(req.body.notes || '').trim() || null
      );

    logAudit(req.user.id, 'fleet_owner.bike_create', 'bikes', info.lastInsertRowid, { organization_id: organization.id }, req.ip);
    const bike = getScopedBike(organization, info.lastInsertRowid);
    res.status(201).json({ ok: true, bike });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || 'Could not create bike' });
  }
});

router.put('/bikes/:id', companyRoleAllowed(['fleet_owner_admin', 'fleet_owner_ops']), (req, res) => {
  try {
    const organization = getOrganizationOrThrow(req.user.organization_id);
    const bikeId = toInt(req.params.id);
    if (!bikeId) return res.status(400).json({ error: 'Invalid bike id' });
    const bike = getScopedBike(organization, bikeId);
    if (!bike) return res.status(404).json({ error: 'Bike not found in your fleet' });

    const allowed = ['registration', 'make', 'model', 'fleet', 'year', 'engine_cc', 'color', 'condition', 'purchase_price', 'rental_weekly', 'total_weeks', 'gps_device_id', 'odometer_km', 'next_service_km', 'next_service_date', 'insurance_provider', 'insurance_policy_no', 'insurance_expiry', 'license_disc_no', 'license_disc_expiry', 'image_url', 'notes'];
    const sets = [];
    const vals = [];
    let statusMeta = null;

    if (req.body.status !== undefined) {
      statusMeta = setBikeStatus(bikeId, req.body.status);
      if (statusMeta?.next_status === 'stolen') {
        const discontinued = discontinueAgreementForStolenBike({ bikeId, actorId: req.user.id, ip: req.ip });
        statusMeta.discontinued_agreement_id = discontinued.agreement?.id || null;
        statusMeta.discontinued_agreement_no = discontinued.agreement?.agreement_no || null;
        statusMeta.waived_schedule_rows = discontinued.waived_rows || 0;
      }
    }

    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        sets.push(`${key} = ?`);
        vals.push(req.body[key] === '' ? null : req.body[key]);
      }
    }

    if (sets.length) {
      vals.push(bikeId);
      db.prepare(`UPDATE bikes SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    }

    logAudit(req.user.id, 'fleet_owner.bike_update', 'bikes', bikeId, { ...req.body, ...(statusMeta || {}) }, req.ip);
    res.json({ ok: true, bike: getScopedBike(organization, bikeId), ...(statusMeta || {}) });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || 'Could not update bike' });
  }
});

router.get('/agreements', (req, res) => {
  try {
    const organization = getOrganizationOrThrow(req.user.organization_id);
    const status = String(req.query.status || '').trim();
    const bikeStatus = String(req.query.bike_status || '').trim();
    const excludedBikeStatuses = String(req.query.exclude_bike_statuses || '').split(',').map((value) => value.trim()).filter(Boolean);
    let agreements = getFleetAgreements(organization);
    if (status) agreements = agreements.filter((agreement) => agreement.status === status);
    if (bikeStatus) agreements = agreements.filter((agreement) => agreement.bike_status === bikeStatus);
    if (excludedBikeStatuses.length) agreements = agreements.filter((agreement) => !excludedBikeStatuses.includes(agreement.bike_status));
    res.json({ agreements });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || 'Could not load agreements' });
  }
});

router.post('/agreements', companyRoleAllowed(['fleet_owner_admin', 'fleet_owner_ops']), (req, res) => {
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

    logAudit(req.user.id, 'fleet_owner.agreement_create', 'agreements', created, {
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
    res.status(error.status || 500).json({ error: error.message || 'Could not create agreement' });
  }
});

router.post('/agreements/:id/status', companyRoleAllowed(['fleet_owner_admin', 'fleet_owner_ops']), (req, res) => {
  try {
    const organization = getOrganizationOrThrow(req.user.organization_id);
    const agreementId = toInt(req.params.id);
    const nextStatus = String(req.body.status || '').trim();
    if (!agreementId || !nextStatus) return res.status(400).json({ error: 'Agreement and status are required' });

    const agreement = getScopedAgreement(organization, agreementId);
    if (!agreement) return res.status(404).json({ error: 'Agreement not found in your fleet' });

    if (nextStatus === 'discontinued') {
      const result = discontinueAgreement({ agreementId, reason: 'fleet_owner_manual_discontinue', actorId: req.user.id, ip: req.ip, auditAction: 'fleet_owner.agreement_discontinued' });
      return res.json({ ok: true, waived_rows: result.waived_rows });
    }

    if (!['active', 'completed', 'defaulted', 'cancelled', 'paused'].includes(nextStatus)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    db.prepare('UPDATE agreements SET status = ? WHERE id = ?').run(nextStatus, agreementId);
    if (nextStatus === 'completed') db.prepare(`UPDATE bikes SET status = 'paid_off' WHERE id = ?`).run(agreement.bike_id);
    if (nextStatus === 'cancelled') db.prepare(`UPDATE bikes SET status = 'ready_to_go' WHERE id = ?`).run(agreement.bike_id);
    if (nextStatus === 'active') db.prepare(`UPDATE bikes SET status = 'active' WHERE id = ? AND status <> 'active'`).run(agreement.bike_id);

    logAudit(req.user.id, 'fleet_owner.agreement_status', 'agreements', agreementId, { previous_status: agreement.status, next_status: nextStatus }, req.ip);
    res.json({ ok: true });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || 'Could not update agreement status' });
  }
});

router.post('/agreements/:id/reinstate', companyRoleAllowed(['fleet_owner_admin', 'fleet_owner_ops']), (req, res) => {
  try {
    const organization = getOrganizationOrThrow(req.user.organization_id);
    const agreementId = toInt(req.params.id);
    if (!agreementId) return res.status(400).json({ error: 'Invalid agreement id' });
    const agreement = getScopedAgreement(organization, agreementId);
    if (!agreement) return res.status(404).json({ error: 'Agreement not found in your fleet' });
    const result = reinstateDiscontinuedAgreement({ agreementId, actorId: req.user.id, ip: req.ip });
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(400).json({ error: error.message || 'Could not reinstate agreement' });
  }
});

router.get('/payments', companyRoleAllowed(['fleet_owner_admin', 'fleet_owner_ops', 'fleet_owner_billing']), (req, res) => {
  try {
    const organization = getOrganizationOrThrow(req.user.organization_id);
    res.json({ payments: getFleetPayments(organization) });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || 'Could not load payments' });
  }
});

router.post('/payments/manual', companyRoleAllowed(['fleet_owner_admin', 'fleet_owner_billing']), (req, res) => {
  try {
    const organization = getOrganizationOrThrow(req.user.organization_id);
    const agreementId = toInt(req.body.agreement_id);
    const amount = toPositiveNumber(req.body.amount);
    if (!agreementId || !amount) return res.status(400).json({ error: 'Agreement and amount are required' });
    const agreement = getScopedAgreement(organization, agreementId);
    if (!agreement) return res.status(404).json({ error: 'Agreement not found in your fleet' });
    const result = recordFleetManualPayment({ ...req.body, agreement_id: agreementId, amount, recorded_by: req.user.id });
    logAudit(req.user.id, 'fleet_owner.payment_manual', 'payments', result.id, { amount, method: req.body.method, agreement_id: agreementId }, req.ip);
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(400).json({ error: error.message || 'Could not record payment' });
  }
});

router.post('/payments/bulk-delete', companyRoleAllowed(['fleet_owner_admin', 'fleet_owner_billing']), (req, res) => {
  try {
    const organization = getOrganizationOrThrow(req.user.organization_id);
    const paymentIds = Array.from(new Set((Array.isArray(req.body.payment_ids) ? req.body.payment_ids : [])
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 0)));
    if (!paymentIds.length) return res.status(400).json({ error: 'Select at least one payment to delete' });

    const deleted = [];
    const notFound = [];
    const agreementIds = new Set();
    for (const paymentId of paymentIds) {
      const payment = getScopedPayment(organization, paymentId);
      if (!payment) {
        notFound.push(paymentId);
        continue;
      }
      db.prepare('DELETE FROM payments WHERE id = ?').run(payment.id);
      agreementIds.add(payment.agreement_id);
      deleted.push(payment);
    }

    for (const agreementId of agreementIds) rebuildScheduleAllocations(agreementId);

    logAudit(req.user.id, 'fleet_owner.payment_bulk_delete', 'payments', null, {
      requested: paymentIds.length,
      deleted_count: deleted.length,
      not_found_count: notFound.length,
      payment_ids: deleted.map((payment) => payment.id)
    }, req.ip);

    res.json({ ok: true, requested: paymentIds.length, deleted_count: deleted.length, not_found_count: notFound.length, not_found: notFound });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || 'Could not delete payments' });
  }
});

module.exports = router;
