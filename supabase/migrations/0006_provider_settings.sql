-- 0006_provider_settings.sql
--
-- Stores which providers a user enabled (and their base URLs) on the account
-- row, so signing in on a second device does not reset every provider to its
-- default. This restores it as a separate, additive migration.
--
-- API keys are NOT stored here — they stay encrypted in public.api_keys.
-- Idempotent: safe to re-run.

begin;

alter table public.user_settings
  add column if not exists provider_settings jsonb not null default '{}'::jsonb;

comment on column public.user_settings.provider_settings is
  'Per-provider enabled flags and base URLs. Never contains API keys.';

commit;
