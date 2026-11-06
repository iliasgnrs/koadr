import { decryptSecret, encryptSecret, keyHint } from './crypto';
import { getPgPool } from './pg';

/*
 * Server-only access to api_keys, over a direct Postgres connection.
 *
 * The table has no grants for any PostgREST role, so it never enters the schema
 * cache: the browser cannot read it, cannot list it, and cannot reach it through
 * /rest/v1 at all. Only this module, which holds the database password, can.
 */

export interface StoredKeySummary {
  provider: string;
  hint: string | null;
  updated_at: string;
}

export async function saveApiKey(profileId: string, provider: string, key: string): Promise<void> {
  const encrypted = encryptSecret(key);

  await getPgPool().query(
    `insert into public.api_keys
       (profile_id, provider, ciphertext, iv, auth_tag, key_version, hint, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, now())
     on conflict (profile_id, provider) do update
       set ciphertext = excluded.ciphertext,
           iv = excluded.iv,
           auth_tag = excluded.auth_tag,
           key_version = excluded.key_version,
           hint = excluded.hint,
           updated_at = now()`,
    [profileId, provider, encrypted.ciphertext, encrypted.iv, encrypted.authTag, encrypted.keyVersion, keyHint(key)],
  );
}

export async function deleteApiKey(profileId: string, provider: string): Promise<void> {
  await getPgPool().query('delete from public.api_keys where profile_id = $1 and provider = $2', [profileId, provider]);
}

/** Provider names plus a masked hint. Never returns a key. */
export async function listApiKeys(profileId: string): Promise<StoredKeySummary[]> {
  const { rows } = await getPgPool().query<StoredKeySummary>(
    'select provider, hint, updated_at from public.api_keys where profile_id = $1 order by provider',
    [profileId],
  );

  return rows;
}

/**
 * Decrypt every key for a profile into the `{ provider: key }` shape the API
 * routes expect.
 *
 * A row that fails to decrypt is skipped rather than throwing: one corrupt or
 * stale-version row must not break every request for that account.
 */
export async function getUserApiKeys(profileId: string): Promise<Record<string, string>> {
  const { rows } = await getPgPool().query<{
    provider: string;
    ciphertext: Buffer;
    iv: Buffer;
    auth_tag: Buffer;
    key_version: number;
  }>('select provider, ciphertext, iv, auth_tag, key_version from public.api_keys where profile_id = $1', [profileId]);

  const keys: Record<string, string> = {};

  for (const row of rows) {
    try {
      keys[row.provider] = decryptSecret({
        ciphertext: row.ciphertext,
        iv: row.iv,
        authTag: row.auth_tag,
        keyVersion: row.key_version,
      });
    } catch {
      console.error(`Could not decrypt key for provider "${row.provider}" (version ${row.key_version})`);
    }
  }

  return keys;
}
