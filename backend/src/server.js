require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');
const fs = require('fs');
const { ensureSuperadminFromEnv } = require('./services/bootstrapSuperadmin');

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

app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: false, crossOriginEmbedderPolicy: false }));
app.use(cors({ origin: '*', credentials: true }));
app.use(morgan('dev'));
app.use(express.json({ limit: '5mb' }));
app.get(/^\/uploads\/(.+)$/, (req, res) => {
  const relativePath = String(req.params[0] || '');
  const absolutePath = resolveUploadPath(relativePath);
  if (!absolutePath) return sendMissingUpload(res, relativePath);
  return res.sendFile(absolutePath);
});
app.head(/^\/uploads\/(.+)$/, (req, res) => {
  const relativePath = String(req.params[0] || '');
  const absolutePath = resolveUploadPath(relativePath);
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
if (fs.existsSync(frontendDist)) {
  app.use(express.static(frontendDist));
  app.get(/^\/(?!api|uploads).*/, (req, res) => {
    res.sendFile(path.join(frontendDist, 'index.html'));
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
