const express = require('express');
const db = require('../db');
const { authRequired, adminOnly } = require('../middleware/auth');
const { sendNotification } = require('../services/notifier');

const router = express.Router();

router.get('/mine', authRequired, (req, res) => {
  const list = db.prepare(`SELECT * FROM notifications WHERE user_id = ?
                           ORDER BY created_at DESC LIMIT 100`).all(req.user.id);
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
