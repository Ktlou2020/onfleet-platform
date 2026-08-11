const express = require('express');
const pgDb = require('../pgDb');
const { authRequired, adminOnly } = require('../middleware/auth');
const { sendNotification } = require('../services/notifierPg');
const asyncRouter = require('../utils/asyncRouter');

const router = asyncRouter(express.Router());

router.get('/mine', authRequired, async (req, res) => {
  const { rows: list } = await pgDb.query(`SELECT * FROM notifications WHERE user_id = $1
                           ORDER BY COALESCE(sent_at, created_at) DESC LIMIT 100`, [req.user.id]);
  res.json({ notifications: list });
});

router.post('/mine/read-all', authRequired, async (req, res) => {
  await pgDb.query(`UPDATE notifications SET status = 'read' WHERE user_id = $1 AND status != 'read'`, [req.user.id]);
  res.json({ ok: true });
});

// Merges two otherwise-separate systems for the admin bell: in-app job-card
// notifications (per-admin rows in `notifications`) and open GPS tracking
// alerts (global rows in `tracking_alerts`, not mirrored into `notifications`
// today). Kept read-only here — marking read/acknowledged still goes through
// each source's own existing endpoint (POST /:id/read, PUT /tracking/alerts/:id/acknowledge).
router.get('/bell', authRequired, adminOnly, async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 30, 100);

  const { rows: jobCardRows } = await pgDb.query(
    `SELECT id, type, title, message, status, created_at FROM notifications
     WHERE user_id = $1 AND channel = 'in_app' ORDER BY created_at DESC LIMIT $2`,
    [req.user.id, limit]
  );
  const { rows: alertRows } = await pgDb.query(
    `SELECT ta.id, ta.alert_type, ta.payload, ta.created_at, ta.acknowledged_at, b.registration, b.make, b.model
     FROM tracking_alerts ta LEFT JOIN bikes b ON b.id = ta.bike_id
     WHERE ta.resolved_at IS NULL ORDER BY ta.created_at DESC LIMIT $1`,
    [limit]
  );

  const items = [
    ...jobCardRows.map((n) => ({
      source: 'job_card', id: n.id, type: n.type, title: n.title, message: n.message,
      created_at: n.created_at, read: n.status === 'read', link: '/admin/workshop'
    })),
    ...alertRows.map((a) => ({
      source: 'tracking_alert', id: a.id, type: a.alert_type,
      title: a.registration || a.make || 'Unregistered bike',
      message: a.payload || null,
      created_at: a.created_at, read: !!a.acknowledged_at, link: '/admin/tracking'
    }))
  ].sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, limit);

  // Counted independently of `items` (which is capped at `limit`) so the
  // badge reflects the true unread total, not just what fits in the list.
  const { rows: unreadJobCards } = await pgDb.query(
    `SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = $1 AND channel = 'in_app' AND status != 'read'`,
    [req.user.id]
  );
  const { rows: unreadAlerts } = await pgDb.query(
    `SELECT COUNT(*)::int AS n FROM tracking_alerts WHERE resolved_at IS NULL AND acknowledged_at IS NULL`
  );
  const unread_count = unreadJobCards[0].n + unreadAlerts[0].n;
  res.json({ items, unread_count });
});

router.get('/', authRequired, adminOnly, async (req, res) => {
  const limit = Math.min(Number(req.query.limit || 200), 500);
  const { rows: list } = await pgDb.query(`SELECT n.*, u.full_name, u.email, u.role
    FROM notifications n
    LEFT JOIN users u ON u.id = n.user_id
    ORDER BY COALESCE(n.sent_at, n.created_at) DESC
    LIMIT $1`, [limit]);
  res.json({ notifications: list });
});

router.post('/:id/read', authRequired, async (req, res) => {
  await pgDb.query(`UPDATE notifications SET status = 'read' WHERE id = $1 AND user_id = $2`,
    [req.params.id, req.user.id]);
  res.json({ ok: true });
});

router.post('/send', authRequired, adminOnly, async (req, res) => {
  const { user_id, channel, type, title, message } = req.body;
  try {
    const id = await sendNotification({ userId: user_id, channel, type, title, message });
    res.json({ id });
  } catch (e) {
    res.status(502).json({ error: e.message || 'Notification delivery failed' });
  }
});

router.post('/:id/resend', authRequired, adminOnly, async (req, res) => {
  const { rows } = await pgDb.query('SELECT * FROM notifications WHERE id = $1', [req.params.id]);
  const original = rows[0];
  if (!original) return res.status(404).json({ error: 'Notification not found' });
  try {
    const id = await sendNotification({
      userId: original.user_id,
      channel: original.channel,
      type: original.type,
      title: original.title,
      message: original.message
    });
    res.json({ id });
  } catch (e) {
    res.status(502).json({ error: e.message || 'Resend failed' });
  }
});

module.exports = router;
