-- Proves the api_keys table is invisible to client roles.
--
--   docker exec supabase-db psql -U supabase_admin -d postgres -f /tmp/rls3.sql
--
-- Rolls back, so it is safe against a live database.

\set ON_ERROR_STOP on

begin;

select id as uid from auth.users limit 1 \gset

insert into public.api_keys (profile_id, provider, ciphertext, iv, auth_tag, hint)
values (:'uid', 'probe-provider', '\x00', '\x00', '\x00', '…abcd');

-- Service role can read it (the server needs this).
select 'service role sees' as check, count(*) as n from public.api_keys;

-- as a normal client
set local role authenticated;

select set_config(
  'request.jwt.claims',
  json_build_object('sub', :'uid', 'role', 'authenticated')::text,
  true
);

do $$
begin
  perform count(*) from public.api_keys;
  raise notice 'LEAK: authenticated could read api_keys';
exception
  when insufficient_privilege then
    raise notice 'OK: authenticated denied on api_keys';
end $$;

rollback;
