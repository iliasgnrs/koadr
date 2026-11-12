-- 0008_account_state_grants.sql
--
-- `connections` is created in 0007 with every PostgREST grant revoked. The app
-- reads it over the direct Postgres connection (app/lib/.server/connections.ts)
-- as the `supabase_admin` role, which is what owns the table.
--
-- This file exists so the grant assumption is explicit and verifiable:
--   * `supabase_admin` — owner, full access (already implied by ownership).
--   * `anon` / `authenticated` / `service_role` — no access at all.
--
-- Idempotent.

begin;

revoke all on public.connections from anon, authenticated, service_role;

grant all on public.connections to supabase_admin;

commit;
