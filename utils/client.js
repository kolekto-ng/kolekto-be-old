import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { assertSupabaseConfig } from './supabaseConfig.js';

// Ensure we always load `kolekto-backend/.env` regardless of where Node is started.
dotenv.config({ path: new URL("../.env", import.meta.url) });

// ─────────────────────────────────────────────────────────────────────────────
// FAIL FAST. The backend is a privileged service: every server-side read/write
// to an RLS-protected, service-role-only table (pending_payment_context,
// email_campaigns/*, notifications, push_notification_events, …) REQUIRES the
// service-role key. The old code silently fell back to the anon key when the
// service-role key was missing — which does not error, it just makes RLS return
// zero rows, so Payment Monitoring and Communications rendered EMPTY while the
// data existed and was merely unreadable (incident: kolekto-1784556863591-704214).
//
// assertSupabaseConfig throws here, at import time, if SUPABASE_SERVICE_ROLE_KEY
// is missing or is actually an anon/wrong-role key. Because app.js transitively
// imports this module, that throw crashes startup with a precise, structured
// error instead of booting a healthy-looking app with empty dashboards. There is
// NO anon fallback for privileged access anymore — that is the whole point.
// ─────────────────────────────────────────────────────────────────────────────
const cfg = assertSupabaseConfig(process.env);

const AUTH_OPTS = {
    auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
    },
};

// PRIVILEGED BACKEND CLIENT — uses the service-role key and bypasses RLS.
// Use this for EVERY server-side read/write to protected tables. The Express
// auth layer (verifyToken + requireAdmin/requireSuperAdmin) is the access gate,
// not RLS.
export const serviceSupabase = createClient(cfg.url, cfg.serviceRoleKey, AUTH_OPTS);

// PUBLIC / USER-SCOPED CLIENT — uses the anon key, so RLS IS enforced. Only for
// operations that must run as an anonymous/user identity (e.g. verifying a user
// access token against GoTrue). It is NULL when no anon key is configured;
// callers that need it must handle that. NEVER use this to read privileged
// tables — it will silently return zero rows.
export const publicSupabase = cfg.anonKey
    ? createClient(cfg.url, cfg.anonKey, AUTH_OPTS)
    : null;

// Backwards-compatible export. Historically the whole codebase imports
// `{ supabase }` from here. It now points at the PRIVILEGED service client and
// is GUARANTEED to be the service-role client — never a silent anon fallback.
// Existing imports keep working unchanged.
export const supabase = serviceSupabase;
