// Writes a technician made while the signal was gone, kept until they land.
//
// The read path already degrades: a dropped GET falls back to the last good
// response. Writes simply failed, which in a workshop means a technician adds
// a part, sees an error, and does it again later — or does not, and the job
// card is wrong. The photograph case is the sharp one: they have taken the
// picture and it is gone.
//
// Three things make this safe rather than merely convenient.
//
// It queues only ADDITIVE work: a line item, a note, a photograph. Not "start
// job", not "mark complete", not a delete. Those are state changes other
// people act on, and replaying one from three hours ago is worse than being
// told to find signal. They fail honestly, as they do now.
//
// Every queued write carries an id generated before the first attempt and kept
// across every retry, so the server can recognise a replay. A request that
// reached the server and lost its reply looks exactly like one that never
// arrived; without that id, the safe thing and the destructive thing are
// indistinguishable.
//
// It is visible. A queue nobody can see is a way to lose work quietly, so the
// count is on screen and a write that is rejected on its merits — not for the
// network — stops and says so rather than retrying for ever.

const DB_NAME = 'onfleet-offline';
const DB_VERSION = 1;
const STORE = 'writes';

// IndexedDB rather than localStorage because a resized photo is ~150 KB of
// binary and localStorage holds strings in a ~5 MB budget shared with
// everything else.
function openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('no indexedDB')); return; }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore(mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const store = tx.objectStore(STORE);
      let result;
      Promise.resolve(fn(store)).then((r) => { result = r; }).catch(reject);
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

const asPromise = (request) => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

/** A per-write id the server uses to recognise a replay. */
export function newRequestId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `req-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

const listeners = new Set();
export function onQueueChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function announce() {
  for (const fn of listeners) { try { fn(); } catch { /* a bad listener must not stop the rest */ } }
}

/**
 * Put a write on the queue.
 *
 * `label` is what the technician will see in the pending list, so it has to
 * read like the thing they did — "Oil filter" rather than "POST /items".
 */
export async function enqueue({ url, method = 'post', body = null, file = null, fileField = 'photo', label, requestId }) {
  const entry = {
    url, method, body, file, fileField,
    label: label || 'Change',
    requestId: requestId || newRequestId(),
    queuedAt: Date.now(),
    attempts: 0,
    error: null,
  };
  await withStore('readwrite', (store) => asPromise(store.add(entry)));
  announce();
  return entry;
}

export async function listQueued() {
  try {
    return await withStore('readonly', (store) => asPromise(store.getAll()));
  } catch {
    return [];
  }
}

export async function removeQueued(id) {
  await withStore('readwrite', (store) => asPromise(store.delete(id)));
  announce();
}

async function markFailed(id, message) {
  await withStore('readwrite', async (store) => {
    const entry = await asPromise(store.get(id));
    if (!entry) return;
    entry.attempts += 1;
    entry.error = message;
    await asPromise(store.put(entry));
  });
  announce();
}

/**
 * Send everything waiting, oldest first.
 *
 * Order matters: a note and then a photograph on the same job should arrive
 * that way round, and two edits to one thing must not race. So this is a loop
 * and not a Promise.all.
 *
 * A write rejected on its merits — the job was closed, the field was wrong —
 * is kept and flagged rather than retried, because sending it again will fail
 * again. Only a network failure is worth another go, and it stops the run: if
 * one request could not reach the server, the next will not either, and
 * hammering a dead connection drains a phone battery for nothing.
 */
export async function flushQueue(api) {
  const queued = (await listQueued()).sort((a, b) => a.queuedAt - b.queuedAt);
  const result = { sent: 0, failed: 0, stopped: false };

  for (const entry of queued) {
    // A parked write waits for a person, not another attempt.
    if (entry.error) { result.failed += 1; continue; }
    try {
      await send(api, entry);
      await removeQueued(entry.id);
      result.sent += 1;
    } catch (e) {
      if (!e.response) { result.stopped = true; break; }
      await markFailed(entry.id, e.response?.data?.error || `Rejected (${e.response.status})`);
      result.failed += 1;
    }
  }
  return result;
}

async function send(api, entry) {
  if (entry.file) {
    const form = new FormData();
    form.append(entry.fileField, entry.file, entry.file.name || 'photo.jpg');
    for (const [k, v] of Object.entries(entry.body || {})) form.append(k, v);
    form.append('client_request_id', entry.requestId);
    return api.post(entry.url, form, {
      headers: { 'Content-Type': 'multipart/form-data', 'X-Client-Request-Id': entry.requestId },
    });
  }
  return api[entry.method](entry.url, { ...(entry.body || {}), client_request_id: entry.requestId }, {
    headers: { 'X-Client-Request-Id': entry.requestId },
  });
}

/**
 * Try it now; queue it if the network is the reason it failed.
 *
 * Anything the server answered — a validation error, a closed job — is the
 * caller's problem and is thrown, because queuing a write the server has
 * already refused would only fail again later, further from the person who
 * could fix it.
 */
export async function sendOrQueue(api, { url, method = 'post', body = null, file = null, fileField = 'photo', label }) {
  const requestId = newRequestId();
  const entry = { url, method, body, file, fileField, requestId };
  try {
    const response = await send(api, entry);
    return { queued: false, response };
  } catch (e) {
    if (e.response) throw e;
    await enqueue({ url, method, body, file, fileField, label, requestId });
    return { queued: true, response: null };
  }
}
