/**
 * errorHandler.js — the safety net that was previously missing entirely.
 *
 * Express 5 forwards a rejected async route handler to the first 4-arg
 * error-handling middleware. Before this existed, such rejections fell through
 * to Express's default handler: a bare HTML 500 with a leaked stack in dev and
 * NO structured log — so a failing endpoint was invisible in the logs and
 * indistinguishable (from the frontend) from any other "Failed to load".
 *
 * Now every unhandled error in a route is:
 *   - logged once, structured, with the request's correlation id + stack, and
 *   - returned as JSON { error, requestId } so the frontend can surface the id.
 *
 * Mount BOTH of these AFTER all routers, with notFound before errorHandler.
 */
import { log } from '../utils/logger.js';

export function notFound(req, res) {
  log.warn('http.not_found', { requestId: req.id, method: req.method, path: req.path });
  res.status(404).json({ error: 'Not found', requestId: req.id });
}

// Must keep the 4-arg signature — that is how Express recognises it as an
// error handler. `next` is unused but required.
// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  const status = err.status || err.statusCode || 500;

  log.error('http.unhandled_error', {
    requestId: req.id,
    method: req.method,
    path: req.path,
    status,
    err,
  });

  // If headers already went out (error thrown mid-stream), delegate to Express
  // to close the socket — we can't write a JSON body anymore.
  if (res.headersSent) return next(err);

  res.status(status).json({
    error: status >= 500 ? 'Internal server error' : err.message || 'Request failed',
    requestId: req.id,
  });
}
