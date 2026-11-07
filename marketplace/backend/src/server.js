'use strict';
const { open } = require('./db');
const { createApp } = require('./app');
const { expireUnpaid, sweep, releaseScheduled } = require('./orders');

const path = require('path');
const fs = require('fs');
const express = require('express');

const db = open();
const app = createApp(db);

// Serve the built web app from the same port when it exists, so one
// process (and one URL) runs the whole thing in production.
const web = process.env.WEB_DIST || path.join(__dirname, '..', '..', 'frontend', 'dist');
if (fs.existsSync(path.join(web, 'index.html'))) {
  // The service worker, manifest and page must always be checked for
  // updates, or phones would keep running an old version of the app.
  const fresh = (p) => /(?:sw\.js|manifest\.webmanifest|index\.html)$/.test(p);
  app.use(express.static(web, {
    index: false,
    maxAge: '1h',
    setHeaders: (res, p) => {
      if (fresh(p)) res.setHeader('Cache-Control', 'no-cache');
      if (/\/assets\//.test(p)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      if (p.endsWith('sw.js')) res.setHeader('Service-Worker-Allowed', '/');
    },
  }));
  app.get(/^\/(?!api\/).*/, (req, res) => { res.setHeader('Cache-Control', 'no-cache'); res.sendFile(path.join(web, 'index.html')); });
}
const port = Number(process.env.PORT || 4100);

// Release stock held by baskets that never got paid for.
setInterval(() => {
  try {
    expireUnpaid(db, app.locals.refund);
  } catch (e) {
    console.error('expireUnpaid failed', e);
  }
}, 60 * 1000).unref();

// Move offers that ran out of time to the next rider, and retry orders
// still waiting for one.
setInterval(() => {
  try {
    releaseScheduled(db);
    sweep(db);
  } catch (e) {
    console.error('dispatch sweep failed', e);
  }
}, 5 * 1000).unref();

app.listen(port, () => console.log(`ClickNPuff API on http://localhost:${port}`));
