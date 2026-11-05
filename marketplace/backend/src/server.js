'use strict';
const { open } = require('./db');
const { createApp } = require('./app');
const { expireUnpaid } = require('./orders');

const path = require('path');
const fs = require('fs');
const express = require('express');

const db = open();
const app = createApp(db);

// Serve the built web app from the same port when it exists, so one
// process (and one URL) runs the whole thing in production.
const web = process.env.WEB_DIST || path.join(__dirname, '..', '..', 'frontend', 'dist');
if (fs.existsSync(path.join(web, 'index.html'))) {
  app.use(express.static(web, { index: false, maxAge: '1h' }));
  app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(web, 'index.html')));
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

app.listen(port, () => console.log(`Cloud 9 API on http://localhost:${port}`));
