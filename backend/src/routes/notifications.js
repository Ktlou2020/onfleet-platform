const express = require('express');
const db = require('../db');
const { authRequired, adminOnly } = require('../middleware/auth');
const { sendNotification } = require('../services/notifier');

const router = express.Router();

router.get('/mine', authRequired, (req, res) => {
  const list = db.prepare(`SELECT * FROM notifications WHERE user_id = ?
                           ORDER BY COALESCE(sent_at, created_at) DESC LIMIT 100`).all(req.user.id);
  res.json({ notifications: list });
});

router.post('/mine/read-all', authRequired, (req, res) => {
  db.prepare(`UPDATE notifications SET status = 'read' WHERE user_id = ? AND status != 'read'`).run(req.user.id);
  res.json({ ok: true });
});

router.get('/', authRequired, adminOnly, (req, res) => {
  const limit = Math.min(Number(req.query.limit || 200), 500);
  const list = db.prepare(`SELECT n.*, u.full_name, u.email, u.role
    FROM notifications n
    LEFT JOIN users u ON u.id = n.user_id
    ORDER BY COALESCE(n.sent_at, n.created_at) DESC
    LIMIT ?`).all(limit);
  res.json({ notifications: list });
});

router.post('/:id/read', authRequired, (req, res) => {
  db.prepare(`UPDATE notifications SET status = 'read' WHERE id = ? AND user_id = ?`)
    .run(req.params.id, req.user.id);
  res.json({ ok: true });
});

router.post('/send', authRequired, adminOnly, async (req, res) => {
  const { user_id, channel, type, title, message } = req.body;
  const id = await sendNotification({ userId: user_id, channel, type, title, message });
  res.json({ id });
});

module.exports = router;
