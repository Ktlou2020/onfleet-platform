require('dotenv').config();
const http = require('http');
const express = require('express');

const PORT = process.env.PORT || 4000;

// Bind the port and answer /api/health BEFORE any heavy initialisation. Building
// the real app (buildApp, below) requires ./db, which runs schema/migrations
// synchronously and can take 10-30 s on a cold shared-CPU container. Listening
// on a trivial bootstrap app first lets the OS accept and queue connections —
// including health-check probes — immediately, then we swap in the fully-wired
// app as this same server's request handler once it's ready.
const bootstrapApp = express();
bootstrapApp.get('/api/health', (req, res) => res.json({ ok: true, service: 'onfleet-api', time: new Date().toISOString() }));
const server = http.createServer(bootstrapApp);
server.listen(PORT, () => console.log(`🏍️  OnFleet API listening on :${PORT}`));

const buildApp = require('./app');
const app = buildApp();
server.removeAllListeners('request');
server.on('request', app);

// Prevent unhandled rejections and uncaught exceptions from crashing the process.
// Log them so they're visible in Railway logs, but keep the server up.
process.on('unhandledRejection', (reason, promise) => {
  console.error('[unhandledRejection]', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});

const { ensureSuperadminFromEnv } = require('./services/bootstrapSuperadmin');
ensureSuperadminFromEnv().then((superadminBootstrap) => {
  if (superadminBootstrap?.skipped) {
    console.log(`ℹ️  Superadmin bootstrap skipped: ${superadminBootstrap.reason}`);
  } else {
    console.log(`🔐 Superadmin ${superadminBootstrap.created ? 'created' : 'already exists'} for ${superadminBootstrap.email}`);
  }
}).catch((err) => {
  console.error('[startup] Superadmin bootstrap failed:', err.message);
});

if (process.env.NODE_ENV !== 'test') {
  const startBackgroundServices = () => {
    require('./services/scheduler').start();
    require('./services/webhookDispatcher').start();
    const TCP_PORT = Number(process.env.TELTONIKA_TCP_PORT || 5000);
    require('./tcp/teltonikaServer').start(TCP_PORT);
  };

  require('./migrations/trackingPgSchema').runTrackingSchema()
    .catch((err) => {
      // Pre-existing behaviour: the tracking schema is idempotent DDL, so a
      // transient failure here shouldn't stop a deploy that is otherwise fine.
      console.error('[startup] Postgres schema failed, continuing:', err.message);
    })
    // Migrations run only after the tracking schema exists — several of them
    // reference its tables, so the order matters on a fresh database.
    .then(() => require('./services/runMigrations').runMigrations())
    .then(startBackgroundServices)
    .catch((err) => {
      // Unlike the schema step, a failed migration means the code and the
      // database disagree. Serving anyway is what left production silently
      // half-broken before; exiting non-zero makes Railway retry and then fail
      // the deploy, leaving the previous healthy version serving.
      console.error('[startup] Migrations failed — refusing to start on a mismatched schema.');
      console.error(err.message);
      process.exit(1);
    });
}
