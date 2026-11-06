import { Pool } from 'pg';

/*
 * Direct Postgres connection, used only for `api_keys`.
 *
 * That table is deliberately invisible to PostgREST (its grants are revoked so it
 * never enters the schema cache and no client role can even see it exists), which
 * also means the service-role Supabase client cannot reach it. Talking to
 * Postgres directly is the honest way to keep the table server-only.
 *
 * Single connection, small pool: this holds one short query per request, never a
 * transaction spanning the request.
 */
let pool: Pool | null = null;

export function getPgPool(): Pool {
  if (pool) {
    return pool;
  }

  const connectionString = process.env.SUPABASE_DB_URL;

  if (!connectionString) {
    throw new Error('SUPABASE_DB_URL is not set on the server');
  }

  pool = new Pool({
    connectionString,
    max: 4,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 5_000,
  });

  return pool;
}
