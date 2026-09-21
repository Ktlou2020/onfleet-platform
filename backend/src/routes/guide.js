'use strict';

// How far each person has got through a guide.
//
// Separate from the guides themselves because they are read by different
// people: the workshop guide by technicians, the tracking guide by the control
// room. Any signed-in staff member can keep their own progress; only an admin
// can see the team's.

const express = require('express');
const pgDb = require('../pgDb');
const { authRequired, adminOnly } = require('../middleware/auth');
const asyncRouter = require('../utils/asyncRouter');

const router = asyncRouter(express.Router());

const STAFF_ROLES = ['technician', 'control_room', 'admin', 'superadmin'];
const GUIDES = ['workshop', 'tracking'];

function staffOnly(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Unauthenticated' });
  if (!STAFF_ROLES.includes(req.user.role)) return res.status(403).json({ error: 'Access denied' });
  next();
}

const guideName = (value) => {
  const guide = String(value || 'workshop');
  return GUIDES.includes(guide) ? guide : null;
};

router.get('/progress', authRequired, staffOnly, async (req, res) => {
  const guide = guideName(req.query.guide);
  if (!guide) return res.status(400).json({ error: 'No such guide' });
  const { rows } = await pgDb.query(
    'SELECT step_key, completed_at FROM guide_progress WHERE user_id = $1 AND guide = $2', [req.user.id, guide]);
  res.json({ guide, done: rows.map((r) => r.step_key) });
});

router.put('/progress', authRequired, staffOnly, async (req, res) => {
  const guide = guideName(req.body.guide);
  if (!guide) return res.status(400).json({ error: 'No such guide' });
  const stepKey = String(req.body.step_key || '').trim();
  if (!stepKey || stepKey.length > 100) return res.status(400).json({ error: 'Which step?' });

  if (req.body.done === false) {
    await pgDb.query('DELETE FROM guide_progress WHERE user_id = $1 AND guide = $2 AND step_key = $3',
      [req.user.id, guide, stepKey]);
  } else {
    await pgDb.query(
      `INSERT INTO guide_progress (user_id, guide, step_key) VALUES ($1,$2,$3)
       ON CONFLICT (user_id, guide, step_key) DO NOTHING`, [req.user.id, guide, stepKey]);
  }
  const { rows } = await pgDb.query(
    'SELECT step_key FROM guide_progress WHERE user_id = $1 AND guide = $2', [req.user.id, guide]);
  res.json({ guide, done: rows.map((r) => r.step_key) });
});

// Who has worked through it — for whoever is bringing people on.
router.get('/progress/team', authRequired, adminOnly, async (req, res) => {
  const guide = guideName(req.query.guide);
  if (!guide) return res.status(400).json({ error: 'No such guide' });
  const { rows } = await pgDb.query(
    `SELECT u.id, u.full_name, u.role,
            COUNT(g.step_key)::int AS steps_done,
            MAX(g.completed_at) AS last_activity
       FROM users u
       LEFT JOIN guide_progress g ON g.user_id = u.id AND g.guide = $1
      WHERE u.role = ANY($2) AND u.deleted_at IS NULL AND u.status = 'active'
      GROUP BY u.id, u.full_name, u.role
      ORDER BY steps_done DESC, u.full_name`, [guide, STAFF_ROLES]);
  res.json(rows);
});

module.exports = router;
