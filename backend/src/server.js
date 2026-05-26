require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');
const fs = require('fs');
const { ensureSuperadminFromEnv } = require('./services/bootstrapSuperadmin');
const { ensureContractSnapshotForRelativePath } = require('./services/contracts');

const app = express();
const uploadRoots = [
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

app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: false, crossOriginEmbedderPolicy: false }));
app.use(cors({ origin: '*', credentials: true }));
app.use(morgan('dev'));
app.use(express.json({ limit: '5mb' }));
app.get(/^\/uploads\/(.+)$/, (req, res) => {
  const relativePath = String(req.params[0] || '');
  let absolutePath = resolveUploadPath(relativePath);
  if (!absolutePath) {
    const regenerated = ensureContractSnapshotForRelativePath(relativePath);
    absolutePath = regenerated?.absolutePath || null;
  }
  if (!absolutePath) return sendMissingUpload(res, relativePath);
  return res.sendFile(absolutePath);
});
app.head(/^\/uploads\/(.+)$/, (req, res) => {
  const relativePath = String(req.params[0] || '');
  let absolutePath = resolveUploadPath(relativePath);
  if (!absolutePath) {
    const regenerated = ensureContractSnapshotForRelativePath(relativePath);
    absolutePath = regenerated?.absolutePath || null;
  }
  if (!absolutePath) return sendMissingUpload(res, relativePath);
  return res.sendFile(absolutePath);
});

app.get('/api/health', (req, res) => res.json({ ok: true, service: 'onfleet-api', time: new Date().toISOString() }));

app.use('/api/auth', require('./routes/auth'));
app.use('/api/kyc', require('./routes/kyc'));
app.use('/api/bikes', require('./routes/bikes'));
app.use('/api/applications', require('./routes/applications'));
app.use('/api/agreements', require('./routes/agreements'));
app.use('/api/payments', require('./routes/payments'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/imports', require('./routes/imports'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/pilot', require('./routes/pilot'));
app.use('/api/fleet', require('./routes/fleet'));

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

app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Server error' });
});

const superadminBootstrap = ensureSuperadminFromEnv();
if (superadminBootstrap?.skipped) {
  console.log(`ℹ️  Superadmin bootstrap skipped: ${superadminBootstrap.reason}`);
} else {
  console.log(`🔐 Superadmin ${superadminBootstrap.created ? 'created' : 'updated'} for ${superadminBootstrap.email}`);
}

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`🏍️  OnFleet API listening on :${PORT}`);
  if (process.env.NODE_ENV !== 'test') {
    require('./services/scheduler').start();
  }
});
