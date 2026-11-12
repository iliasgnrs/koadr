import { decryptSecret, encryptSecret } from './crypto';
import { getPgPool } from './pg';

/*
 * Server-only storage for Git / deploy / backend connections.
 *
 * The tokens (GitHub, GitLab, Netlify, Vercel, Supabase PAT) are encrypted with
 * API_KEY_ENCRYPTION_SECRET, exactly like provider keys, and the table has no
 * PostgREST grants. The browser only ever receives the non-secret summary: who
 * is connected, which account, and token type.
 */

export const CONNECTION_PROVIDERS = ['github', 'gitlab', 'netlify', 'vercel', 'supabase'] as const;

export type ConnectionProvider = (typeof CONNECTION_PROVIDERS)[number];

export const SECRET_FIELDS = ['token', 'accessToken', 'apiKey'] as const;

export interface StoredConnection extends Record<string, unknown> {
  token?: string;
  accessToken?: string;
  apiKey?: string;
}

type ConnectionRow = {
  provider: string;
  ciphertext: Buffer;
  iv: Buffer;
  auth_tag: Buffer;
  key_version: number;
};

export function isConnectionProvider(value: unknown): value is ConnectionProvider {
  return typeof value === 'string' && (CONNECTION_PROVIDERS as readonly string[]).includes(value);
}

/** True when the payload still carries a usable secret for this provider. */
export function hasSecret(connection: Record<string, unknown> | undefined): boolean {
  return Boolean(connection && SECRET_FIELDS.some((field) => typeof connection[field] === 'string'));
}

/** Strip secrets before a connection is handed to the browser. */
function redact(connection: StoredConnection): Record<string, unknown> {
  const copy = { ...connection };

  for (const field of SECRET_FIELDS) {
    delete copy[field];
  }

  return copy;
}

async function readRows(profileId: string): Promise<ConnectionRow[]> {
  const { rows } = await getPgPool().query<ConnectionRow>(
    'select provider, ciphertext, iv, auth_tag, key_version from public.connections where profile_id = $1',
    [profileId],
  );

  return rows;
}

function decryptRow(row: ConnectionRow): StoredConnection | null {
  try {
    return JSON.parse(
      decryptSecret({
        ciphertext: row.ciphertext,
        iv: row.iv,
        authTag: row.auth_tag,
        keyVersion: row.key_version,
      }),
    ) as StoredConnection;
  } catch {
    console.error(`Could not decrypt connection "${row.provider}" (version ${row.key_version})`);

    return null;
  }
}

/** Non-secret summary of every connection. This is what /api/connections returns. */
export async function listConnections(profileId: string): Promise<Record<string, Record<string, unknown>>> {
  const result: Record<string, Record<string, unknown>> = {};

  for (const row of await readRows(profileId)) {
    const connection = decryptRow(row);

    if (connection) {
      result[row.provider] = redact(connection);
    }
  }

  return result;
}

/** Full payloads including tokens, for the routes that actually talk to a provider. */
export async function getConnectionSecrets(profileId: string): Promise<Record<string, StoredConnection>> {
  const result: Record<string, StoredConnection> = {};

  for (const row of await readRows(profileId)) {
    const connection = decryptRow(row);

    if (connection) {
      result[row.provider] = connection;
    }
  }

  return result;
}

export async function getConnectionSecret(
  profileId: string,
  provider: ConnectionProvider,
): Promise<StoredConnection | null> {
  const connection = (await getConnectionSecrets(profileId))[provider];

  return connection ?? null;
}

/**
 * Upsert a connection. A payload without a secret keeps the stored token, so the
 * browser can update the display fields (username, site id) without ever holding
 * the token again.
 */
export async function saveConnection(
  profileId: string,
  provider: ConnectionProvider,
  connection: StoredConnection,
): Promise<void> {
  const payload = hasSecret(connection)
    ? connection
    : { ...(await getConnectionSecret(profileId, provider)), ...connection };

  const encrypted = encryptSecret(JSON.stringify(payload));

  await getPgPool().query(
    `insert into public.connections
       (profile_id, provider, ciphertext, iv, auth_tag, key_version, updated_at)
     values ($1, $2, $3, $4, $5, $6, now())
     on conflict (profile_id, provider) do update
       set ciphertext = excluded.ciphertext,
           iv = excluded.iv,
           auth_tag = excluded.auth_tag,
           key_version = excluded.key_version,
           updated_at = now()`,
    [profileId, provider, encrypted.ciphertext, encrypted.iv, encrypted.authTag, encrypted.keyVersion],
  );
}

export async function deleteConnection(profileId: string, provider: ConnectionProvider): Promise<void> {
  await getPgPool().query('delete from public.connections where profile_id = $1 and provider = $2', [
    profileId,
    provider,
  ]);
}
