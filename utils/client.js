import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

// Ensure we always load `kolekto-backend/.env` regardless of where Node is started.
dotenv.config({ path: new URL("../.env", import.meta.url) });

const supabaseUrl = process.env.SUPABASE_URL;
// On the backend we generally want the service role key so we can perform
// server-side writes regardless of RLS (the Express auth layer is the gate).
const supabaseKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    // Non-fatal, but LOUD: running on the anon key means every server-side write
    // to an RLS-protected, service-role-only table is silently denied. This is
    // the confirmed root cause of two production incidents — the Communication /
    // Email Campaigns section (email_campaigns et al. are RLS-on / no-policy, so
    // reads return 0 rows and writes throw "violates row-level security policy")
    // and the push/notifications pipeline (notifications, push_notification_events,
    // claim_push_notification_event). Payments still work because they run through
    // the edge functions (service role), which is why this hides so easily.
    console.error(
        "\n" +
        "############################################################################\n" +
        "## ❌ SUPABASE_SERVICE_ROLE_KEY IS NOT SET — falling back to the anon key. ##\n" +
        "############################################################################\n" +
        "## RLS-protected, service-role-only tables are now INACCESSIBLE to the    ##\n" +
        "## backend. Known impact until this is fixed:                             ##\n" +
        "##   • Communication → Mail (email_campaigns/templates/recipients):       ##\n" +
        "##       list endpoints return EMPTY, create/update throw RLS violations. ##\n" +
        "##   • Push / in-app notifications (notifications,                        ##\n" +
        "##       push_notification_events, claim_push_notification_event): denied.##\n" +
        "## FIX: set SUPABASE_SERVICE_ROLE_KEY in the backend environment.         ##\n" +
        "############################################################################\n"
    );
}

if (!supabaseUrl || !supabaseKey) {
    // Fail fast: callers will get a clear error rather than mysterious 500s.
    throw new Error(
        "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY/SUPABASE_ANON_KEY in environment"
    );
}

const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
    },
});

export { supabase };
