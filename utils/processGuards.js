/**
 * processGuards.js — process-level crash guards.
 *
 * WHY THIS EXISTS
 * On Node >= 15 (this runs on v22), an unhandled promise rejection terminates
 * the process by DEFAULT, and an uncaught exception always has. With no guard
 * and no error middleware, a single un-awaited/un-caught rejection anywhere
 * (a background timer, a fire-and-forget email, a webhook path) silently kills
 * the whole server — which then restarts — producing exactly the reported
 * "backend stops returning data entirely, then resolves itself" signature.
 *
 * DIAGNOSTIC MODE (default): we LOG the full error + stack and KEEP THE PROCESS
 * ALIVE. This deliberately trades strict correctness for availability *while
 * you are hunting the intermittent outage* — it turns an invisible full outage
 * into a loud, correlated log line you can act on, without taking the API down.
 *
 * IMPORTANT: an uncaught exception can leave the process in an undefined state.
 * Every 'process.uncaught_exception' line is a real bug that MUST be fixed at
 * the source (add the missing try/catch or .catch). Once the source leaks are
 * fixed, set CRASH_ON_UNCAUGHT=true to restore fail-fast semantics (log, then
 * let your process manager restart cleanly) for production correctness.
 */
import { log } from './logger.js';

export function installProcessGuards() {
  process.on('unhandledRejection', (reason) => {
    log.error('process.unhandled_rejection', {
      err: reason instanceof Error ? reason : new Error(String(reason)),
    });
    // Do NOT exit — see file header. A rejection rarely corrupts process state.
  });

  process.on('uncaughtException', (err) => {
    log.error('process.uncaught_exception', { err });
    if (process.env.CRASH_ON_UNCAUGHT === 'true') {
      // Give the log a tick to flush, then exit so the process manager restarts
      // a clean process rather than one in an undefined state.
      setTimeout(() => process.exit(1), 100);
    }
  });

  // Surface warnings (e.g. MaxListenersExceeded, deprecations) as structured
  // logs too — these often precede a leak/outage.
  process.on('warning', (warning) => {
    log.warn('process.warning', {
      name: warning.name,
      message: warning.message,
      stack: warning.stack,
    });
  });

  log.info('process.guards_installed', {
    crashOnUncaught: process.env.CRASH_ON_UNCAUGHT === 'true',
  });
}

export default installProcessGuards;
