'use strict';
const { open } = require('./db');
const { createApp } = require('./app');
const { expireUnpaid } = require('./orders');

const db = open();
const app = createApp(db);
const port = Number(process.env.PORT || 4100);

// Release stock held by baskets that never got paid for.
setInterval(() => {
  try {
    expireUnpaid(db, app.locals.refund);
  } catch (e) {
    console.error('expireUnpaid failed', e);
  }
}, 60 * 1000).unref();

app.listen(port, () => console.log(`Verdant API on http://localhost:${port}`));
