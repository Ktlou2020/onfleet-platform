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
