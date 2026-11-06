-- 0005_onboarding.sql
--
-- Onboarding state belongs to the account, not the browser.
--
-- It lived in `bolt_onboarding_completed` in localStorage, so a returning user in
-- incognito — or on a second device — was shown the 4-step welcome flow again as
-- if they had never signed up. The column records that this account has already
-- been through it.
--
-- Idempotent.

begin;

alter table public.profiles
  add column if not exists onboarding_completed_at timestamptz;

comment on column public.profiles.onboarding_completed_at is
  'Set when the user finishes the welcome flow. Replaces bolt_onboarding_completed.';

commit;
