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
    console.warn(
        "SUPABASE_SERVICE_ROLE_KEY is not set; falling back to SUPABASE_ANON_KEY. " +
            "If RLS blocks server-side writes, set SUPABASE_SERVICE_ROLE_KEY in kolekto-backend/.env."
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
