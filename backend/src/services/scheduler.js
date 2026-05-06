const cron = require('node-cron');
const db = require('../db');
const { sendNotification } = require('./notifier');
const { recalcScheduleStatuses } = require('../utils/helpers');

function runDailyReminders() {
  const tomorrow = new Date(Date.now() + 24*60*60*1000).toISOString().slice(0,10);
  const due = db.prepare(`
    SELECT s.*, a.user_id, a.agreement_no, u.full_name FROM payment_schedules s
    JOIN agreements a ON a.id = s.agreement_id
    JOIN users u ON u.id = a.user_id
    WHERE s.due_date = ? AND s.status IN ('pending','partial')`).all(tomorrow);

  for (const d of due) {
    const msg = `Hi ${d.full_name.split(' ')[0]}, your weekly OnFleet payment of R${d.amount_due} for agreement ${d.agreement_no} is due tomorrow (${d.due_date}). Pay via the app to keep your rent-to-own on track.`;
    sendNotification({ userId: d.user_id, channel: 'whatsapp', type: 'payment_reminder',
                       title: 'Payment due tomorrow', message: msg });
    sendNotification({ userId: d.user_id, channel: 'sms', type: 'payment_reminder', message: msg });
    sendNotification({ userId: d.user_id, channel: 'email', type: 'payment_reminder',
                       title: 'OnFleet payment due tomorrow', message: msg });
  }

  // Overdue alerts
  const today = new Date().toISOString().slice(0,10);
  const overdue = db.prepare(`
    SELECT s.*, a.user_id, a.agreement_no, u.full_name FROM payment_schedules s
    JOIN agreements a ON a.id = s.agreement_id
    JOIN users u ON u.id = a.user_id
    WHERE s.due_date < ? AND s.status = 'overdue'`).all(today);

  for (const d of overdue) {
    const msg = `URGENT: OnFleet payment of R${d.amount_due - d.amount_paid} for ${d.agreement_no} is overdue (due ${d.due_date}). Please pay immediately to avoid agreement default.`;
    sendNotification({ userId: d.user_id, channel: 'whatsapp', type: 'payment_overdue',
                       title: 'Overdue payment', message: msg });
  }

  // Service due alerts
  const serviceDue = db.prepare(`
    SELECT b.*, a.user_id, a.agreement_no, u.full_name FROM bikes b
    JOIN agreements a ON a.bike_id = b.id AND a.status = 'active'
    JOIN users u ON u.id = a.user_id
    WHERE b.next_service_date IS NOT NULL AND b.next_service_date <= date('now','+7 days')`).all();
  for (const s of serviceDue) {
    sendNotification({ userId: s.user_id, channel: 'sms', type: 'service_reminder',
      message: `Reminder: Your ${s.make} ${s.model} is due for free monthly service on ${s.next_service_date}. Book it via the app.` });
  }
}

function runScheduleRecalc() {
  const ags = db.prepare(`SELECT id FROM agreements WHERE status = 'active'`).all();
  for (const a of ags) recalcScheduleStatuses(a.id);
}

function start() {
  // Daily 8am SAST (06:00 UTC)
  cron.schedule('0 6 * * *', runDailyReminders);
  cron.schedule('5 0 * * *', runScheduleRecalc); // status sweep at 00:05 UTC
  console.log('🕒 Scheduler started');
}

module.exports = { start, runDailyReminders, runScheduleRecalc };
