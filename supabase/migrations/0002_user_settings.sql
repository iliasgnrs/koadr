-- 0002_user_settings.sql
--
-- Per-account UI preferences: theme plus the interface options the settings tab
-- and onboarding already write to localStorage (`bolt_theme`,
-- `bolt_interface_options`).
--
-- A separate table rather than columns on `profiles`: these values churn on every
-- slider drag, and `profiles` is read on every authenticated request. Keeping the
-- hot row small means the churn does not touch it.
--
-- Idempotent — applied with `psql -f` over the SSH tunnel.

begin;

create table if not exists public.user_settings (
  profile_id uuid primary key references public.profiles (id) on delete cascade,
  theme text,
  interface_options jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

comment on table public.user_settings is 'UI preferences per account. Last write wins.';

drop trigger if exists user_settings_set_updated_at on public.user_settings;
create trigger user_settings_set_updated_at
  before update on public.user_settings
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table public.user_settings enable row level security;

/*
 * `for all` with a matching `with check` covers select, insert and update in one
 * policy. Rows for another account can be neither read nor written, and the
 * `with check` clause is what stops an insert/update aimed at someone else's id.
 */
drop policy if exists user_settings_own on public.user_settings;
create policy user_settings_own on public.user_settings
  for all
  to authenticated
  using (profile_id = (select auth.uid()))
  with check (profile_id = (select auth.uid()));

commit;
