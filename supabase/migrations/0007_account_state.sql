-- 0007_account_state.sql
--
-- Moves everything the app used to keep in localStorage onto the account, so a
-- second device (or a reinstall) sees the same settings:
--
--   user_settings.editor       -> toggle flags, prompt id, tab configuration
--   public.connections         -> GitHub / GitLab / Netlify / Vercel / Supabase
--                                connections (tokens encrypted, server-only)
--   user_settings.mcp_servers  -> MCP server list and per-server enable flags
--   user_settings.tool_access  -> tool permission mode
--   profiles.bio               -> profile biography
--   chats.snapshot             -> per-chat project snapshot (files at save time)
--
-- Connections are encrypted application-side with API_KEY_ENCRYPTION_SECRET and
-- written only through the server (like api_keys), so tokens never come back to
-- the browser. RLS still scopes the row to its owner.
--
-- Idempotent: safe to re-run.

begin;

alter table public.user_settings
  add column if not exists editor jsonb not null default '{}'::jsonb,
  add column if not exists mcp_servers jsonb not null default '[]'::jsonb,
  add column if not exists tool_access text not null default 'ask-for-all';

alter table public.profiles
  add column if not exists bio text;

alter table public.chats
  add column if not exists snapshot jsonb;

/*
 * Same shape and locks as api_keys: encrypted application-side, no RLS policy and
 * no grants for any PostgREST role, so only the server can touch it.
 */
create table if not exists public.connections (
  profile_id uuid not null references public.profiles (id) on delete cascade,
  provider text not null,
  ciphertext bytea not null,
  iv bytea not null,
  auth_tag bytea not null,
  key_version int not null default 1,
  updated_at timestamptz not null default now(),
  primary key (profile_id, provider)
);

comment on table public.connections is 'Encrypted git/deploy/backend connections. Server-only.';

alter table public.connections enable row level security;

revoke all on public.connections from anon, authenticated, service_role;

notify pgrst, 'reload schema';

commit;
