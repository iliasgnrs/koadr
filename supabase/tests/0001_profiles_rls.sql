-- RLS proof for Slice 1.
--
-- Run as supabase_admin (a superuser, which bypasses RLS), so each check first
-- switches to the `authenticated` role and sets request.jwt.claims exactly the
-- way PostgREST does. Anything the service role sees is not evidence of RLS.
--
--   docker exec supabase-db psql -U supabase_admin -d postgres -f /tmp/rls.sql
--
-- Rolls back everything, so it can run against a live database.

\set ON_ERROR_STOP on

begin;

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at)
values
  (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'probe.a@example.com', 'x', now()),
  (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'probe.b@example.com', 'x', now());

select 'rows as superuser' as check, count(*) as n from public.profiles;

/*
 * Capture the id while still superuser: `authenticated` has no rights on
 * auth.users, and asking for it after the role switch would fail before the
 * policy under test is ever evaluated.
 */
select id::text as user_a_id from auth.users where email = 'probe.a@example.com' \gset

-- ── as user A ───────────────────────────────────────────────────────────────
set local role authenticated;

select set_config(
  'request.jwt.claims',
  json_build_object('sub', :'user_a_id', 'role', 'authenticated')::text,
  true
);

select 'A sees rows' as check, count(*) as n from public.profiles;
select 'A sees names' as check, string_agg(username, ',') as names from public.profiles;

rollback;
