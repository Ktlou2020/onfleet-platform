const express = require('express');
const pgDb = require('../pgDb');
const { authRequired } = require('../middleware/auth');
const asyncRouter = require('../utils/asyncRouter');
const { isPushConfigured, getPublicKey } = require('../services/webPush');

const router = asyncRouter(express.Router());

router.get('/vapid-public-key', authRequired, async (req, res) => {
  res.json({ configured: isPushConfigured(), publicKey: getPublicKey() });
});

router.post('/subscribe', authRequired, async (req, res) => {
  const { endpoint, keys } = req.body?.subscription || req.body || {};
  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    return res.status(400).json({ error: 'A valid push subscription (endpoint + keys) is required' });
  }
  await pgDb.query(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (endpoint) DO UPDATE SET user_id = $1, p256dh = $3, auth = $4, user_agent = $5, last_used_at = NOW()`,
    [req.user.id, endpoint, keys.p256dh, keys.auth, req.get('user-agent') || null]
  );
  res.json({ ok: true });
});

router.post('/unsubscribe', authRequired, async (req, res) => {
  const { endpoint } = req.body || {};
  if (!endpoint) return res.status(400).json({ error: 'endpoint is required' });
  await pgDb.query('DELETE FROM push_subscriptions WHERE endpoint = $1 AND user_id = $2', [endpoint, req.user.id]);
  res.json({ ok: true });
});

router.get('/status', authRequired, async (req, res) => {
  const { rows } = await pgDb.query('SELECT endpoint FROM push_subscriptions WHERE user_id = $1', [req.user.id]);
  res.json({ subscribed: rows.length > 0, endpoints: rows.map((r) => r.endpoint) });
});

module.exports = router;
