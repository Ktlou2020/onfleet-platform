'use strict';
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');
const fs = require('fs');
const rateLimit = require('express-rate-limit');

const UPLOAD_DIRS = require('./uploadPaths');
const uploadRoots = [
  UPLOAD_DIRS.base,
  path.join(__dirname, '../uploads'),
  path.join(__dirname, '../../uploads')
];

function resolveUploadPath(relativePath) {
  const normalized = path.normalize(relativePath).replace(/^([/\\])+/, '');
  if (!normalized || normalized.startsWith('..') || path.isAbsolute(normalized)) return null;
  for (const root of uploadRoots) {
    const absolutePath = path.join(root, normalized);
    if (absolutePath.startsWith(root) && fs.existsSync(absolutePath) && fs.statSync(absolutePath).isFile()) {
      return absolutePath;
    }
  }
  return null;
}

function sendMissingUpload(res, relativePath) {
  return res.status(404).format({
    'application/json': () => res.json({ error: 'Uploaded file not found', path: `/uploads/${relativePath}` }),
    'text/html': () => res.send(`<h1>Uploaded file not found</h1><p>The file <code>/uploads/${relativePath}</code> is missing or no longer available on this server.</p>`),
    default: () => res.type('text/plain').send(`Uploaded file not found: /uploads/${relativePath}`)
  });
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getShareMeta(req) {
  const origin = `${req.protocol}://${req.get('host')}`;
  const url = `${origin}${req.originalUrl || req.path || '/'}`;
  const pathName = String(req.path || '/');

  const defaults = {
    title: 'OnFleet Africa — Rent to Own. Ride. Earn. Own.',
    description: 'OnFleet Africa — Rent-to-own delivery bikes for South African riders. No deposit. Free monthly servicing. Own in 18 months.',
    image: `${origin}/logo.png`,
    url
  };

  if (pathName === '/fleet' || pathName === '/fleet/') {
    return {
      title: 'OnFleet Africa Fleet Owner Platform — Launch and manage your fleet',
      description: 'The OnFleet fleet-owner platform is live. Create a company account, manage bikes and agreements, capture payments, and run daily fleet operations from one workspace.',
      image: `${origin}/logo.png`,
      url
    };
  }

  return defaults;
}

function injectShareMeta(template, meta) {
  return String(template || '')
    .replace(/<title>.*?<\/title>/i, `<title>${escapeHtml(meta.title)}</title>`)
    .replace(/<meta name="description" content="[^"]*"\s*\/>/i, `<meta name="description" content="${escapeHtml(meta.description)}" />`)
    .replace(/<meta property="og:title" content="[^"]*"\s*\/>/i, `<meta property="og:title" content="${escapeHtml(meta.title)}" />`)
    .replace(/<meta property="og:description" content="[^"]*"\s*\/>/i, `<meta property="og:description" content="${escapeHtml(meta.description)}" />`)
    .replace(/<meta property="og:image" content="[^"]*"\s*\/>/i, `<meta property="og:image" content="${escapeHtml(meta.image)}" />`)
    .replace(/<meta property="og:url" content="[^"]*"\s*\/>/i, `<meta property="og:url" content="${escapeHtml(meta.url)}" />`)
    .replace(/<meta name="twitter:title" content="[^"]*"\s*\/>/i, `<meta name="twitter:title" content="${escapeHtml(meta.title)}" />`)
    .replace(/<meta name="twitter:description" content="[^"]*"\s*\/>/i, `<meta name="twitter:description" content="${escapeHtml(meta.description)}" />`)
    .replace(/<meta name="twitter:image" content="[^"]*"\s*\/>/i, `<meta name="twitter:image" content="${escapeHtml(meta.image)}" />`);
}

// Builds a fully-wired Express app (all middleware + routes), but never binds a
// port itself — server.js does that. Kept separate so tests can require this
// directly via supertest without a real listening socket.
function buildApp() {
  const app = express();
  app.set('trust proxy', 1); // Fly.io / Railway reverse proxy: trust first hop for rate limiting and real IPs

  app.get('/api/health', (req, res) => res.json({ ok: true, service: 'onfleet-api', time: new Date().toISOString() }));

  app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: false, crossOriginEmbedderPolicy: false }));

  const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || process.env.FRONTEND_URL || '')
    .split(',').map((o) => o.trim().replace(/\/+$/, '')).filter(Boolean);

  // Per-request cors so we can infer self-origin from Host when no allowlist is configured
  app.use((req, res, next) => {
    cors({
      origin: (origin, cb) => {
        if (!origin) return cb(null, true); // same-origin / server-to-server
        if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
        if (ALLOWED_ORIGINS.length === 0) {
          // No explicit allowlist — allow the server's own host (monolithic deployment).
          // Take first value only in case proxy stacks multiple entries (e.g. "https,https").
          const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
          const host = (req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
          if (origin === `${proto}://${host}`) return cb(null, true);
          // Also compare just hostnames to tolerate internal port mismatches
          try {
            const originHostname = new URL(origin).hostname;
            const serverHostname = host.split(':')[0];
            if (originHostname && serverHostname && originHostname === serverHostname) return cb(null, true);
          } catch { /* invalid origin URL */ }
          // Allow localhost in development
          if (/^https?:\/\/localhost(:\d+)?$/.test(origin)) return cb(null, true);
        }
        // Always log when blocking — runs even when ALLOWED_ORIGINS is set to a wrong value
        {
          const _proto = (req.headers['x-forwarded-proto'] || req.protocol || '?').split(',')[0].trim();
          const _host = (req.headers['x-forwarded-host'] || req.headers.host || '?').split(',')[0].trim();
          console.warn(`[CORS] blocked origin="${origin}" proto="${_proto}" host="${_host}" allowlist=[${ALLOWED_ORIGINS.join(', ')}] — update ALLOWED_ORIGINS env var`);
        }
        cb(new Error('CORS: origin not allowed'));
      },
      credentials: true
    })(req, res, next);
  });
  if (process.env.NODE_ENV !== 'test') app.use(morgan('dev'));
  // Webhook must receive the raw body for HMAC validation — register before express.json()
  app.use('/api/payments/paystack/webhook', express.raw({ type: 'application/json' }));
  app.use(express.json({ limit: '5mb' }));
  // Files uploaded while R2 is configured live there, not on disk — proxied
  // through here rather than redirected to a public R2 URL (see
  // storageService.js's header comment for why). Only reached once local
  // disk and contract-regeneration have both already missed.
  async function tryServeFromR2(res, relativePath, isHead) {
    const storageService = require('./services/storageService');
    if (!storageService.isConfigured()) return false;
    if (isHead) {
      const meta = await storageService.headObject(relativePath);
      if (!meta) return false;
      if (meta.contentType) res.type(meta.contentType);
      if (meta.contentLength != null) res.setHeader('Content-Length', meta.contentLength);
      res.end();
      return true;
    }
    const obj = await storageService.getObjectStream(relativePath);
    if (!obj) return false;
    if (obj.contentType) res.type(obj.contentType);
    if (obj.contentLength != null) res.setHeader('Content-Length', obj.contentLength);
    obj.stream.pipe(res);
    return true;
  }
  app.get(/^\/uploads\/(.+)$/, async (req, res) => {
    const relativePath = String(req.params[0] || '');
    let absolutePath = resolveUploadPath(relativePath);
    if (!absolutePath) {
      try {
        const regenerated = await require('./services/contractsPg').ensureContractSnapshotForRelativePath(relativePath);
        absolutePath = regenerated?.absolutePath || null;
      } catch (err) {
        console.error('[uploads] contract regeneration failed:', err.message);
      }
    }
    if (absolutePath) return res.sendFile(absolutePath);
    if (await tryServeFromR2(res, relativePath, false)) return;
    return sendMissingUpload(res, relativePath);
  });
  app.head(/^\/uploads\/(.+)$/, async (req, res) => {
    const relativePath = String(req.params[0] || '');
    let absolutePath = resolveUploadPath(relativePath);
    if (!absolutePath) {
      try {
        const regenerated = await require('./services/contractsPg').ensureContractSnapshotForRelativePath(relativePath);
        absolutePath = regenerated?.absolutePath || null;
      } catch (err) {
        console.error('[uploads] contract regeneration failed:', err.message);
      }
    }
    if (absolutePath) return res.sendFile(absolutePath);
    if (await tryServeFromR2(res, relativePath, true)) return;
    return sendMissingUpload(res, relativePath);
  });

  // Defense-in-depth: a generous ceiling on top of the tighter per-route
  // limiters already on auth/pilot endpoints. Paystack's webhook is excluded
  // since it's server-to-server and shouldn't compete with user traffic.
  const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => req.path.startsWith('/payments/paystack/webhook'),
    message: { error: 'Too many requests. Please try again shortly.' }
  });
  app.use('/api', apiLimiter);

  app.use('/api/auth', require('./routes/auth'));
  app.use('/api/kyc', require('./routes/kyc'));
  app.use('/api/bikes', require('./routes/bikes'));
  app.use('/api/applications', require('./routes/applications'));
  app.use('/api/agreements', require('./routes/agreements'));
  app.use('/api/payments', require('./routes/payments'));
  app.use('/api/admin', require('./routes/admin'));
  app.use('/api/imports', require('./routes/imports'));
  app.use('/api/notifications', require('./routes/notifications'));
  app.use('/api/push', require('./routes/push'));
  app.use('/api/pilot', require('./routes/pilot'));
  app.use('/api/fleet', require('./routes/fleet'));
  app.use('/api/workshop', require('./routes/workshop'));
  app.use('/api/v1', require('./routes/apiV1'));
  app.use('/api/tracking', require('./routes/tracking'));
  app.use('/api/claims', require('./routes/claims'));
  app.use('/api/public', require('./routes/public'));

  // Serve built frontend (production preview)
  const frontendDist = path.join(__dirname, '../../frontend/dist');
  const frontendIndexPath = path.join(frontendDist, 'index.html');
  if (fs.existsSync(frontendDist)) {
    app.use(express.static(frontendDist));
    app.get(/^\/(?!api|uploads).*/, (req, res, next) => {
      fs.readFile(frontendIndexPath, 'utf8', (error, html) => {
        if (error) return next(error);
        const meta = getShareMeta(req);
        res.type('html').send(injectShareMeta(html, meta));
      });
    });
  }

  // Multer rejections are the caller's fault, not ours, but nothing handled
  // them — so an oversized upload fell through to the generic branch below and
  // came back as a 500 reading "File too large", with no size named and no
  // indication the upload could succeed if the file were smaller. To whoever
  // was uploading it just looked broken. Every upload route shares this
  // handler, so riders and admins both get an answer they can act on.
  const MULTER_MESSAGES = {
    LIMIT_FILE_SIZE: 'That file is too large to upload. Please compress it, or take a lower-resolution photo, and try again.',
    LIMIT_FILE_COUNT: 'Too many files at once. Please upload them one at a time.',
    LIMIT_UNEXPECTED_FILE: 'That file was sent in an unexpected field. Please reselect it and try again.',
    LIMIT_PART_COUNT: 'That upload had too many parts. Please try again with a single file.',
  };

  app.use((err, req, res, next) => {
    if (err && MULTER_MESSAGES[err.code]) {
      // Logged at warn: expected user error, not a fault worth alerting on.
      console.warn(`[upload] ${err.code} on ${req.method} ${req.path}`);
      return res.status(400).json({ error: MULTER_MESSAGES[err.code], code: err.code });
    }
    if (process.env.NODE_ENV !== 'test') console.error(err);
    res.status(err.status || 500).json({ error: err.message || 'Server error' });
  });

  return app;
}

module.exports = buildApp;
