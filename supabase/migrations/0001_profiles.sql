-- 0001_profiles.sql
--
-- One row per authenticated user. Deliberately narrow: Slice 1 only needs
-- accounts to exist and be readable by their owner. Settings, API keys and chat
-- history arrive in later slices as separate tables.
--
-- Applied with `psql -f` over the SSH tunnel (there is no Studio on this host and
-- no migration runner in the app), so this file must be idempotent.

begin;

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  username text unique,
  avatar_url text,
  plan text not null default 'free',
  onboarding_completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.profiles is 'One row per account. Created by the handle_new_user trigger.';

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

/*
 * Seed a profile for every new auth user.
 *
 * `security definer` is required: the trigger fires as GoTrue's
 * supabase_auth_admin role, which has no rights on public.profiles. The
 * search_path is pinned so the definer function cannot be hijacked by a
 * caller-controlled schema.
 *
 * The username is the email local-part, de-duplicated with a numeric suffix
 * because the column is unique.
 */
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  base_name text;
  candidate text;
  suffix int := 0;
begin
  base_name := coalesce(
    nullif(regexp_replace(split_part(new.email, '@', 1), '[^a-zA-Z0-9_-]', '', 'g'), ''),
    'user'
  );

  candidate := base_name;

  while exists (select 1 from public.profiles where username = candidate) loop
    suffix := suffix + 1;
    candidate := base_name || suffix::text;
  end loop;

  insert into public.profiles (id, username)
  values (new.id, candidate)
  on conflict (id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table public.profiles enable row level security;

-- Deny by default: no policy grants insert or delete, so only the trigger and
-- the service role can create or remove rows. Dropped first so re-running this
-- file is safe.
drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own on public.profiles
  for select
  to authenticated
  using (id = (select auth.uid()));

drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles
  for update
  to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

commit;
