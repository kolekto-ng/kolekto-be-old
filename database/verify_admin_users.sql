-- =============================================================================
-- verify_admin_users.sql — quick health check for the admin_users migration
-- =============================================================================
-- Paste into Supabase SQL editor and run. Each statement returns a row;
-- a row missing or returning the wrong value tells you exactly what's broken.
--
-- Apply admin_users.sql FIRST, then run this.
-- =============================================================================

-- 1. The table itself exists.
select
    'admin_users table' as check,
    case when to_regclass('public.admin_users') is not null then '✅ exists' else '❌ MISSING — apply admin_users.sql' end as status;

-- 2. The seed row is there.
select
    'gazalianfellow seed row' as check,
    case
        when exists (select 1 from public.admin_users where email = 'gazalianfellow@gmail.com')
        then '✅ present (role: ' || (select role from public.admin_users where email = 'gazalianfellow@gmail.com' limit 1) || ')'
        else '❌ MISSING — re-run the INSERT block in admin_users.sql'
    end as status;

-- 3. Functions exist.
select
    'is_current_user_admin() function' as check,
    case when to_regprocedure('public.is_current_user_admin()') is not null then '✅ exists' else '❌ MISSING' end as status;

select
    'current_admin_user() function' as check,
    case when to_regprocedure('public.current_admin_user()') is not null then '✅ exists' else '❌ MISSING' end as status;

-- 4. RLS is enabled.
select
    'admin_users RLS' as check,
    case when relrowsecurity then '✅ enabled' else '❌ DISABLED' end as status
from pg_class
where relname = 'admin_users' and relnamespace = 'public'::regnamespace;

-- 5. Full list of current admins (for your eyes).
select
    'current admin list' as check,
    string_agg(email::text || ' (' || role || ')', ', ' order by created_at) as status
from public.admin_users;

-- 6. Add another admin (template — uncomment and edit):
-- insert into public.admin_users (email, role)
-- values ('newadmin@kolekto.com.ng', 'admin')
-- on conflict (email) do nothing;

-- 7. Demote / remove an admin (template — uncomment and edit):
-- delete from public.admin_users where email = 'someone@x';
