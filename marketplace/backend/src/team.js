'use strict';
const orders = require('./orders');

// Who can work in which store, and what they may do there.
//
// Every store has an owner (stores.owner_id) and may have staff. An owner can
// run several branches; each request names the branch in the X-Store-Id
// header (the console remembers the choice). Without it, the first store
// the person belongs to is used.
//
//   packer  — the order board: accept, pack, mark sold out, pause, stock
//   manager — everything a packer does, plus the menu, promos, reviews,
//             insights and store settings
//   owner   — everything, plus money, staff and new branches

const RANK = { packer: 1, manager: 2, owner: 3 };
const ROLES = Object.keys(RANK);
const LABEL = { packer: 'a packer', manager: 'a manager', owner: 'the owner' };

function init(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS store_members (
      store_id   INTEGER NOT NULL REFERENCES stores(id),
      user_id    INTEGER NOT NULL REFERENCES users(id),
      role       TEXT NOT NULL CHECK (role IN ('packer','manager','owner')),
      added_by   INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (store_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS store_members_user ON store_members(user_id);
    CREATE TABLE IF NOT EXISTS store_activity (
      id       INTEGER PRIMARY KEY,
      store_id INTEGER NOT NULL REFERENCES stores(id),
      user_id  INTEGER REFERENCES users(id),
      action   TEXT NOT NULL,
      detail   TEXT,
      at       TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS store_activity_store ON store_activity(store_id, id);
    -- Every owner is a member of their own store.
    INSERT OR IGNORE INTO store_members (store_id, user_id, role) SELECT id, owner_id, 'owner' FROM stores;
  `);
}

function memberships(db, userId) {
  // The owner column is the source of truth for owners, so a store is never
  // left without one whatever the members table says.
  return db.prepare(`SELECT s.*, CASE WHEN s.owner_id = ? THEN 'owner' ELSE m.role END AS member_role
    FROM stores s LEFT JOIN store_members m ON m.store_id = s.id AND m.user_id = ?
    WHERE s.owner_id = ? OR m.user_id IS NOT NULL ORDER BY member_role = 'owner' DESC, s.id`).all(userId, userId, userId);
}

// The store this request is for, or null if the person has none.
function currentStore(db, req) {
  const list = memberships(db, req.user.id);
  if (!list.length) return null;
  const wanted = Number(req.get('x-store-id') || req.query.storeId);
  const s = (wanted && list.find((x) => x.id === wanted)) || list[0];
  return { store: s, role: s.member_role, all: list };
}

function storeFor(db, req, need = 'packer') {
  const c = currentStore(db, req);
  if (!c) throw new orders.OrderError('Set up your store first', 404);
  if (RANK[c.role] < RANK[need]) throw new orders.OrderError(`Only ${need === 'owner' ? 'the store owner' : 'a manager or the owner'} can do this — you're ${LABEL[c.role]} here`, 403);
  req.store = c.store;
  req.storeRole = c.role;
  return c.store;
}

function isMember(db, storeId, userId) {
  return !!db.prepare('SELECT 1 FROM stores s WHERE s.id = ? AND (s.owner_id = ? OR EXISTS (SELECT 1 FROM store_members m WHERE m.store_id = s.id AND m.user_id = ?))').get(storeId, userId, userId);
}

// User ids to notify about a store, by minimum role.
function memberIds(db, storeId, need = 'packer') {
  const owner = db.prepare('SELECT owner_id FROM stores WHERE id = ?').get(storeId)?.owner_id;
  const staff = db.prepare('SELECT user_id, role FROM store_members WHERE store_id = ? AND user_id <> ?').all(storeId, owner ?? -1)
    .filter((m) => RANK[m.role] >= RANK[need]).map((m) => m.user_id);
  return owner ? [owner, ...staff] : staff;
}

function log(db, storeId, userId, action, detail) {
  db.prepare('INSERT INTO store_activity (store_id, user_id, action, detail) VALUES (?, ?, ?, ?)')
    .run(storeId, userId || null, action, detail == null ? null : String(detail).slice(0, 300));
}

module.exports = { init, RANK, ROLES, memberships, currentStore, storeFor, isMember, memberIds, log };
