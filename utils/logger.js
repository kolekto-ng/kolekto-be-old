/**
 * logger.js — minimal, dependency-free structured (JSON-lines) logger.
 *
 * Every line is a single JSON object so logs are greppable and machine
 * parseable in Render/CloudWatch/whatever aggregator you land on later,
 * WITHOUT pulling in pino/winston. Fields are intentionally flat.
 *
 * Usage:
 *   import { log } from './utils/logger.js';
 *   log.info('email-queue.tick', { processed: 12, requestId });
 *   log.error('db.lookup_failed', { requestId, err });
 *
 * `err` (an Error) is expanded to { message, stack, name } automatically so
 * you never lose a stack trace. Never pass tokens/PII in `meta`.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN_LEVEL = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;

function serializeErr(err) {
  if (!err) return undefined;
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack };
  }
  return { message: String(err) };
}

function emit(level, event, meta = {}) {
  if (LEVELS[level] < MIN_LEVEL) return;

  const { err, ...rest } = meta;
  const line = {
    ts: new Date().toISOString(),
    level,
    event,
    ...rest,
  };
  if (err !== undefined) line.err = serializeErr(err);

  const text = JSON.stringify(line);
  // Keep error/warn on stderr so ops filters that split streams still work.
  if (level === 'error' || level === 'warn') {
    console.error(text);
  } else {
    console.log(text);
  }
}

export const log = {
  debug: (event, meta) => emit('debug', event, meta),
  info: (event, meta) => emit('info', event, meta),
  warn: (event, meta) => emit('warn', event, meta),
  error: (event, meta) => emit('error', event, meta),
};

export default log;
