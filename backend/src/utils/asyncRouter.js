'use strict';

// Express 4 does not forward a rejected promise from an async route handler to
// the error middleware — the request just hangs until the client times out.
// This was invisible while routes were synchronous (better-sqlite3), but every
// route converted to async/pgDb needs its rejections caught. Rather than add a
// try/catch to every handler, wrap the router's registration methods once so
// any async handler's rejection is forwarded to next(err) automatically. Sync
// handlers (multer, role-check middleware, etc.) pass through unchanged.
function asyncRouter(router) {
  for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
    const original = router[method].bind(router);
    router[method] = (path, ...handlers) => original(path, ...handlers.map((handler) =>
      typeof handler === 'function' && handler.constructor.name === 'AsyncFunction'
        ? (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next)
        : handler
    ));
  }
  return router;
}

module.exports = asyncRouter;
