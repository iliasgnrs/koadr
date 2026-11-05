-- Runs after the image's own init-scripts (99- prefix sorts last) and before
-- GoTrue starts.
--
-- Why this exists:
--   The supabase/postgres image creates the `auth` schema and its helper
--   functions (auth.uid / auth.role / auth.email) as the `postgres` user. GoTrue
--   connects as `supabase_auth_admin` and its first migration does
--   `CREATE OR REPLACE FUNCTION auth.uid()`, which Postgres rejects with
--   "must be owner of function uid (SQLSTATE 42501)". GoTrue then crash-loops.
--
--   GoTrue also seeds different schema_migrations version strings than the image
--   does, so it always re-runs 00_init_auth_schema no matter which tag is
--   pinned — the collision has to be fixed by ownership, not by version choice.
--
-- Handing the schema and functions to supabase_auth_admin makes the migration a
-- legitimate replace. Everything else keeps working: `postgres` retains superuser
-- and the image's 10000000000000_demote-postgres.sql already granted it ALL on
-- schema auth, which is what PostgREST and RLS policies rely on.

ALTER SCHEMA auth OWNER TO supabase_auth_admin;

ALTER FUNCTION auth.uid() OWNER TO supabase_auth_admin;
ALTER FUNCTION auth.role() OWNER TO supabase_auth_admin;
ALTER FUNCTION auth.email() OWNER TO supabase_auth_admin;
