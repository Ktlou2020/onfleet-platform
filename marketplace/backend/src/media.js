'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// Product photos, kept on disk next to the database (on the server that's
// the persistent volume) and served from /media. The app shrinks photos
// before upload; here we only check they're real images and not too big.

const MAX_BYTES = 1.5 * 1024 * 1024;
const TYPES = [
  { ext: 'jpg', mime: 'image/jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: 'png', mime: 'image/png', test: (b) => b.slice(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])) },
  { ext: 'webp', mime: 'image/webp', test: (b) => b.slice(0, 4).toString() === 'RIFF' && b.slice(8, 12).toString() === 'WEBP' },
];
const NAME = /^[a-f0-9]{24}\.(jpg|png|webp)$/;

function mediaDir() {
  if (process.env.MEDIA_DIR) return process.env.MEDIA_DIR;
  const db = process.env.CLICKNPUFF_DB || process.env.CLOUD9_DB;
  if (db && db !== ':memory:') return path.join(path.dirname(db), 'uploads');
  return path.join(os.tmpdir(), 'clicknpuff-media');
}

function saveDataUrl(dataUrl) {
  const m = /^data:image\/[a-z+]+;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) throw Object.assign(new Error('Upload a photo (JPG, PNG or WebP)'), { status: 400 });
  const buf = Buffer.from(m[1], 'base64');
  if (buf.length > MAX_BYTES) throw Object.assign(new Error('That photo is too big — keep it under 1.5 MB'), { status: 400 });
  const type = TYPES.find((t) => t.test(buf));
  if (!type) throw Object.assign(new Error("That file isn't a JPG, PNG or WebP photo"), { status: 400 });
  const dir = mediaDir();
  fs.mkdirSync(dir, { recursive: true });
  const name = `${crypto.randomBytes(12).toString('hex')}.${type.ext}`;
  fs.writeFileSync(path.join(dir, name), buf);
  return name;
}

function remove(name) {
  if (name && NAME.test(name)) fs.rm(path.join(mediaDir(), name), { force: true }, () => {});
}

function register(app) {
  app.get('/media/:name', (req, res) => {
    if (!NAME.test(req.params.name)) return res.sendStatus(404);
    const file = path.join(mediaDir(), req.params.name);
    if (!fs.existsSync(file)) return res.sendStatus(404);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.type(TYPES.find((t) => req.params.name.endsWith(t.ext)).mime).sendFile(file);
  });
}

const url = (name) => (name ? `/media/${name}` : null);

module.exports = { saveDataUrl, remove, register, url, mediaDir };
