const cron = require('node-cron');
const db = require('../db');
const { sendNotification } = require('./notifier');
const { recalcScheduleStatuses } = require('../utils/helpers');

function creditedAmount(payment) {
  return Number(payment?.amount ?? payment?.net_amount ?? 0);
}

function startOfUtcDay(dateStr) {
  return new Date(`${dateStr}T00:00:00Z`);
}

function monthRange(monthKey) {
  const start = new Date(`${monthKey}-01T00:00:00Z`);
  const end = new Date(start);
  end.setUTCMonth(end.getUTCMonth() + 1);
  end.setUTCDate(0);
  end.setUTCHours(23, 59, 59, 999);
  return { start, end };
}

function previousMonthKey() {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function notificationExistsForPeriod(userId, type, periodLabel) {
  return db.prepare(`SELECT id FROM notifications
    WHERE user_id = ? AND type = ? AND title = ?
    LIMIT 1`).get(userId, type, periodLabel);
}

function notificationExistsToday(userId, type, title) {
  return db.prepare(`SELECT id FROM notifications
    WHERE user_id = ? AND type = ? AND title = ?
      AND date(COALESCE(sent_at, created_at)) = date('now')
    LIMIT 1`).get(userId, type, title);
}

function buildAgreementStatementSnapshot(agreementId, monthKey) {
  const agreement = db.prepare(`SELECT a.*, u.full_name, u.email,
      b.make, b.model, b.registration, b.vin, b.license_disc_expiry
    FROM agreements a
    JOIN users u ON u.id = a.user_id
    JOIN bikes b ON b.id = a.bike_id
    WHERE a.id = ?`).get(agreementId);
  if (!agreement) return null;

  const { end } = monthRange(monthKey);
  const payments = db.prepare(`SELECT * FROM payments WHERE agreement_id = ? AND status = 'success'
    ORDER BY COALESCE(paid_at, created_at) ASC`).all(agreementId);
  const monthPayments = payments.filter((payment) => String(payment.paid_at || payment.created_at || '').slice(0, 7) === monthKey);
  const totalPaid = payments
    .filter((payment) => new Date(payment.paid_at || payment.created_at) <= end)
    .reduce((sum, payment) => sum + creditedAmount(payment), 0);
  const paidThisMonth = monthPayments.reduce((sum, payment) => sum + creditedAmount(payment), 0);
  const remaining = Math.max(0, Number(agreement.total_amount || 0) - totalPaid);
  const nextDue = db.prepare(`SELECT due_date, amount_due, amount_paid, status
    FROM payment_schedules
    WHERE agreement_id = ? AND status NOT IN ('paid','waived')
    ORDER BY due_date ASC
    LIMIT 1`).get(agreementId);

  return {
    agreement,
    totalPaid: +totalPaid.toFixed(2),
    paidThisMonth: +paidThisMonth.toFixed(2),
    remaining: +remaining.toFixed(2),
    nextDue,
    paymentCount: monthPayments.length,
    monthKey
  };
}

async function runMonthlyStatements(statementMonth = previousMonthKey()) {
  const agreements = db.prepare(`SELECT id, user_id FROM agreements WHERE status = 'active'`).all();
  for (const agreementRow of agreements) {
    const snapshot = buildAgreementStatementSnapshot(agreementRow.id, statementMonth);
    if (!snapshot) continue;
    const title = `Monthly statement · ${statementMonth}`;
    if (notificationExistsForPeriod(snapshot.agreement.user_id, 'monthly_statement', title)) continue;

    const firstName = String(snapshot.agreement.full_name || 'Rider').split(' ')[0];
    const bikeName = [snapshot.agreement.make, snapshot.agreement.model].filter(Boolean).join(' ') || 'Bike';
    const bikeRef = snapshot.agreement.registration || snapshot.agreement.vin;
    const nextDueLine = snapshot.nextDue
      ? `Next instalment: R${Number(snapshot.nextDue.amount_due - snapshot.nextDue.amount_paid).toFixed(2)} due on ${snapshot.nextDue.due_date}.`
      : 'There is no upcoming instalment currently due.';
    const message = [
      `Hi ${firstName},`,
      '',
      `Your OnFleet monthly statement for ${statementMonth} is ready.`,
      `Bike: ${bikeName} (${bikeRef})`,
      `Agreement: ${snapshot.agreement.agreement_no}`,
      `Paid this month: R${snapshot.paidThisMonth.toFixed(2)} (${snapshot.paymentCount} payment${snapshot.paymentCount === 1 ? '' : 's'})`,
      `Total paid to date: R${snapshot.totalPaid.toFixed(2)}`,
      `Outstanding balance: R${snapshot.remaining.toFixed(2)}`,
      `Weekly rental: R${Number(snapshot.agreement.weekly_amount || 0).toFixed(2)}`,
      nextDueLine,
      '',
      'You can also open the app to view or download the full rider statement.'
    ].join('\n');

    try {
      await sendNotification({ userId: snapshot.agreement.user_id, channel: 'in_app', type: 'monthly_statement', title, message });
      await sendNotification({ userId: snapshot.agreement.user_id, channel: 'email', type: 'monthly_statement', title, message });
    } catch (err) {
      console.error(`[monthly-statement] notify failed for agreement ${agreementRow.id}:`, err.message);
    }
  }
}

async function runLicenseDiscAlerts() {
  const platformAdmins = db.prepare(`SELECT id FROM users
    WHERE role IN ('admin','superadmin') AND status = 'active' AND deleted_at IS NULL`).all();

  const bikes = db.prepare(`SELECT id, make, model, registration, vin, license_disc_no, license_disc_expiry, organization_id
    FROM bikes
    WHERE license_disc_expiry IS NOT NULL AND license_disc_expiry <= date('now','+30 days')
    ORDER BY license_disc_expiry ASC`).all();

  const today = startOfUtcDay(new Date().toISOString().slice(0, 10));
  for (const bike of bikes) {
    const expiry = startOfUtcDay(bike.license_disc_expiry);
    const daysRemaining = Math.round((expiry - today) / 86400000);
    if (daysRemaining > 30) continue;
    const title = daysRemaining < 0 ? 'License disc expired' : 'License disc expiring';
    const ref = bike.registration || bike.vin;
    const ageText = daysRemaining < 0
      ? `expired ${Math.abs(daysRemaining)} day${Math.abs(daysRemaining) === 1 ? '' : 's'} ago`
      : daysRemaining === 0
        ? 'expires today'
        : `expires in ${daysRemaining} day${daysRemaining === 1 ? '' : 's'}`;
    const message = `Bike ${bike.make} ${bike.model} (${ref}) has a license disc that ${ageText}. Expiry date: ${bike.license_disc_expiry}.${bike.license_disc_no ? ` Disc no: ${bike.license_disc_no}.` : ''} Update the fleet record once renewed.`;

    // Notify platform admins (in-app)
    for (const admin of platformAdmins) {
      if (notificationExistsToday(admin.id, 'license_disc_expiry', `${title} · ${ref}`)) continue;
      try {
        await sendNotification({ userId: admin.id, channel: 'in_app', type: 'license_disc_expiry', title: `${title} · ${ref}`, message });
      } catch (err) {
        console.error(`[license-disc] platform notify failed for bike ${ref}:`, err.message);
      }
    }

    // Notify fleet owner admins/ops for their org's bike (email)
    if (bike.organization_id) {
      const fleetAdmins = db.prepare(
        `SELECT id, full_name FROM users WHERE organization_id = ? AND role IN ('fleet_owner_admin','fleet_owner_ops') AND status = 'active' AND deleted_at IS NULL`
      ).all(bike.organization_id);
      for (const admin of fleetAdmins) {
        if (notificationExistsToday(admin.id, 'license_disc_expiry', `${title} · ${ref}`)) continue;
        try {
          await sendNotification({
            userId: admin.id,
            channel: 'email',
            type: 'license_disc_expiry',
            title: `${title} · ${ref}`,
            message: `Hi ${admin.full_name.split(' ')[0]}, ${message}`
          });
        } catch (err) {
          console.error(`[license-disc] fleet notify failed for bike ${ref}:`, err.message);
        }
      }
    }
  }
}

async function runDailyReminders() {
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const due = db.prepare(`
    SELECT s.*, a.user_id, a.agreement_no, u.full_name FROM payment_schedules s
    JOIN agreements a ON a.id = s.agreement_id AND a.status = 'active'
    JOIN users u ON u.id = a.user_id AND u.status = 'active'
    WHERE s.due_date = ? AND s.status IN ('pending','partial')`).all(tomorrow);

  for (const d of due) {
    if (!d.amount_due || !Number.isFinite(Number(d.amount_due))) continue;
    const title = `Payment due tomorrow · ${d.agreement_no}`;
    if (notificationExistsToday(d.user_id, 'payment_reminder', title)) continue;
    const msg = `Hi ${d.full_name.split(' ')[0]}, your weekly OnFleet payment of R${Number(d.amount_due).toFixed(2)} for agreement ${d.agreement_no} is due tomorrow (${d.due_date}). Pay via the app to keep your rent-to-own on track.`;
    try {
      await sendNotification({ userId: d.user_id, channel: 'whatsapp', type: 'payment_reminder', title, message: msg });
      await sendNotification({ userId: d.user_id, channel: 'sms', type: 'payment_reminder', message: msg });
      await sendNotification({ userId: d.user_id, channel: 'email', type: 'payment_reminder', title: 'OnFleet payment due tomorrow', message: msg });
    } catch (err) {
      console.error(`[daily-reminder] due-tomorrow failed for ${d.agreement_no}:`, err.message);
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  const overdueRows = db.prepare(`
    SELECT s.id, s.agreement_id, s.due_date, s.amount_due, s.amount_paid,
           a.user_id, a.agreement_no, u.full_name FROM payment_schedules s
    JOIN agreements a ON a.id = s.agreement_id AND a.status = 'active'
    JOIN users u ON u.id = a.user_id AND u.status = 'active'
    WHERE s.due_date < ? AND s.status = 'overdue'`).all(today);

  // Group by agreement — send at most one WhatsApp per agreement per day
  const byAgreement = {};
  for (const row of overdueRows) {
    if (!byAgreement[row.agreement_id]) {
      byAgreement[row.agreement_id] = { ...row, overdueWeeks: 0, totalOwed: 0 };
    }
    byAgreement[row.agreement_id].overdueWeeks++;
    byAgreement[row.agreement_id].totalOwed += (row.amount_due - row.amount_paid);
  }

  for (const entry of Object.values(byAgreement)) {
    const title = `Overdue payment · ${entry.agreement_no}`;
    if (notificationExistsToday(entry.user_id, 'payment_overdue', title)) continue;
    const owed = Number(entry.totalOwed).toFixed(2);
    const weeksText = entry.overdueWeeks > 1 ? ` (${entry.overdueWeeks} weeks overdue)` : '';
    const msg = `URGENT: OnFleet payment of R${owed}${weeksText} for ${entry.agreement_no} is overdue. Please pay immediately to avoid agreement default.`;
    try {
      await sendNotification({ userId: entry.user_id, channel: 'whatsapp', type: 'payment_overdue', title, message: msg });
    } catch (err) {
      console.error(`[daily-reminder] overdue notify failed for ${entry.agreement_no}:`, err.message);
    }
  }

  const serviceDue = db.prepare(`
    SELECT b.*, a.user_id, a.agreement_no, u.full_name FROM bikes b
    JOIN agreements a ON a.bike_id = b.id AND a.status = 'active'
    JOIN users u ON u.id = a.user_id
    WHERE b.next_service_date IS NOT NULL AND b.next_service_date <= date('now','+7 days')`).all();
  for (const s of serviceDue) {
    try {
      await sendNotification({
        userId: s.user_id,
        channel: 'sms',
        type: 'service_reminder',
        message: `Reminder: Your ${s.make} ${s.model} is due for free monthly service on ${s.next_service_date}. Book it via the app.`
      });
    } catch (err) {
      console.error(`[daily-reminder] service reminder failed for ${s.agreement_no}:`, err.message);
    }
  }

  runLicenseDiscAlerts().catch((error) => console.error('license disc alerts failed', error));
  runFleetServiceReminders().catch((error) => console.error('fleet service reminders failed', error));
}

async function runFleetServiceReminders() {
  const today = new Date().toISOString().slice(0, 10);
  // Bikes owned by fleet organisations due for service within 30 days (or already overdue)
  const bikes = db.prepare(`
    SELECT b.id, b.registration, b.vin, b.make, b.model, b.next_service_date, b.status,
           b.organization_id, o.name AS org_name
    FROM bikes b
    JOIN organizations o ON o.id = b.organization_id
    WHERE b.organization_id IS NOT NULL
      AND b.next_service_date IS NOT NULL
      AND b.next_service_date <= date('now', '+30 days')
      AND b.status NOT IN ('sold','written_off','stolen')
  `).all();

  if (!bikes.length) return;

  // Group by organisation
  const byOrg = {};
  for (const bike of bikes) {
    if (!byOrg[bike.organization_id]) byOrg[bike.organization_id] = [];
    byOrg[bike.organization_id].push(bike);
  }

  for (const [orgId, orgBikes] of Object.entries(byOrg)) {
    const orgName = orgBikes[0].org_name;
    const admins = db.prepare(`
      SELECT id, full_name, email FROM users
      WHERE organization_id = ? AND role IN ('fleet_owner_admin','fleet_owner_ops')
        AND status = 'active' AND deleted_at IS NULL
    `).all(Number(orgId));

    if (!admins.length) continue;

    const overdue = orgBikes.filter((b) => b.next_service_date < today);
    const upcoming = orgBikes.filter((b) => b.next_service_date >= today);
    const title = `Service due — ${orgBikes.length} bike${orgBikes.length !== 1 ? 's' : ''} (${orgName})`;

    const bikeLines = orgBikes.map((b) => {
      const label = b.registration || b.vin || `Bike #${b.id}`;
      const flag = b.next_service_date < today ? ' ⚠ OVERDUE' : '';
      return `  • ${label} (${b.make} ${b.model}) — service date: ${b.next_service_date}${flag}`;
    }).join('\n');

    const body = `Hi [name],\n\n${orgName} has ${orgBikes.length} bike${orgBikes.length !== 1 ? 's' : ''} due for service${overdue.length ? ` (${overdue.length} overdue)` : ''}:\n\n${bikeLines}\n\nBasic service is R275 per bike. Please contact us to book your service appointments.\n\nOnFleet Africa Workshop`;

    for (const admin of admins) {
      if (notificationExistsToday(admin.id, 'fleet_service_reminder', title)) continue;
      const personalised = body.replace('[name]', admin.full_name.split(' ')[0]);
      try {
        await sendNotification({
          userId: admin.id,
          channel: 'email',
          type: 'fleet_service_reminder',
          title,
          message: personalised
        });
        await sendNotification({
          userId: admin.id,
          channel: 'in_app',
          type: 'fleet_service_reminder',
          title,
          message: `${orgBikes.length} bike${orgBikes.length !== 1 ? 's' : ''} due for service${overdue.length ? ` (${overdue.length} overdue)` : ''}. Basic service R275.`
        });
      } catch (err) {
        console.error(`[fleet-service-reminder] failed for ${orgName}:`, err.message);
      }
    }
  }
}

function runScheduleRecalc() {
  const ags = db.prepare(`SELECT id FROM agreements WHERE status = 'active'`).all();
  for (const a of ags) recalcScheduleStatuses(a.id);
}

function start() {
  cron.schedule('0 6 * * *', () => runDailyReminders().catch((error) => console.error('daily reminders failed', error)));
  cron.schedule('5 0 * * *', runScheduleRecalc);
  cron.schedule('30 6 1 * *', () => runMonthlyStatements().catch((error) => console.error('monthly statements failed', error)));
  console.log('🕒 Scheduler started');
}

module.exports = {
  start,
  runDailyReminders,
  runScheduleRecalc,
  runMonthlyStatements,
  runLicenseDiscAlerts,
  runFleetServiceReminders,
  buildAgreementStatementSnapshot
};
