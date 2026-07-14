/**
 * requestContext.js — assigns a correlation ID to every request and logs a
 * single structured line per request on completion (with latency).
 *
 * This is the backbone of "trace a failed request from frontend to DB":
 *   - req.id            — correlation ID, also returned as the X-Request-Id
 *                         response header so the frontend/network tab can quote
 *                         it in a bug report.
 *   - req.log           — a child logger that auto-tags every line with
 *                         { requestId }, so controllers can log with context:
 *                             req.log.error('ambassador.overview_failed', { err });
 *   - on 'finish'       — logs method, path, status, and duration_ms.
 *
 * We log req.path (NOT originalUrl) on purpose — the query string can carry
 * webhook tokens / search terms we don't want in logs.
 *
 * Mount this EARLY (right after CORS) so it covers every route, including the
 * raw-body webhook mounted ahead of the JSON parser.
 */
import { randomUUID } from 'crypto';
import { log } from '../utils/logger.js';

export default function requestContext(req, res, next) {
  // Honour an upstream/proxy-provided id if present, else mint one.
  const incoming = req.headers['x-request-id'];
  req.id = (typeof incoming === 'string' && incoming.length <= 100 && incoming) || randomUUID();
  res.setHeader('X-Request-Id', req.id);

  // Child logger bound to this request's id — controllers should use this.
  req.log = {
    debug: (event, meta = {}) => log.debug(event, { requestId: req.id, ...meta }),
    info: (event, meta = {}) => log.info(event, { requestId: req.id, ...meta }),
    warn: (event, meta = {}) => log.warn(event, { requestId: req.id, ...meta }),
    error: (event, meta = {}) => log.error(event, { requestId: req.id, ...meta }),
  };

  const startedAt = process.hrtime.bigint();

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    log[level]('http.request', {
      requestId: req.id,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration_ms: Math.round(durationMs * 10) / 10,
      // Which authenticated principal, when known — helps correlate a burst of
      // failures to a single admin/session without logging the token itself.
      user: req.user?.email || undefined,
    });
  });

  next();
}
