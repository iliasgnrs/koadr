-- 0003_api_keys.sql
--
-- Provider API keys, encrypted at rest, readable only by the server.
--
-- Threat model: the previous design kept keys in a client-settable `apiKeys`
-- cookie, so anything able to reach the origin could send any key and the app
-- would use it. Here the browser can write a key exactly once (through our API),
-- can never read it back, and the ciphertext is useless without
-- API_KEY_ENCRYPTION_SECRET, which lives only in the process environment.
--
-- Two independent locks, because one is not enough for secrets:
--   1. RLS is enabled with no policy at all, so client roles see nothing.
--   2. Grants are revoked from every PostgREST role (anon, authenticated,
--      service_role). PostgREST therefore never loads the table into its schema
--      cache, and /rest/v1 cannot address it even by guessing the name.
--
-- The app reads it over a direct Postgres connection as supabase_admin
-- (see app/lib/.server/api-keys.ts). Idempotent: safe to re-run.

begin;

create table if not exists public.api_keys (
  profile_id uuid not null references public.profiles (id) on delete cascade,
  provider text not null,
  ciphertext bytea not null,
  iv bytea not null,
  auth_tag bytea not null,
  -- Rotation hook: decrypt with the current key, re-encrypt when this is behind.
  key_version int not null default 1,
  hint text,
  updated_at timestamptz not null default now(),
  primary key (profile_id, provider)
);

comment on table public.api_keys is 'Encrypted provider keys. Server-only; no client grants, no RLS policy.';

drop trigger if exists api_keys_set_updated_at on public.api_keys;
create trigger api_keys_set_updated_at
  before update on public.api_keys
  for each row execute function public.set_updated_at();

alter table public.api_keys enable row level security;

-- Revoke the defaults 0002 installs, so this table stays out of PostgREST.
revoke all on public.api_keys from anon, authenticated, service_role;

notify pgrst, 'reload schema';

commit;
