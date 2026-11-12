import type { ConnectionProvider } from '~/lib/.server/connections';

/*
 * Browser half of /api/connections.
 *
 * The server keeps the tokens encrypted and returns only summaries, so after a
 * reload the client knows a connection exists (`connected`) and who it belongs
 * to, but never sees the secret again. The stores use that to decide whether to
 * reconnect.
 */

export interface ConnectionSummary extends Record<string, unknown> {
  connected: boolean;
}

const providers: readonly ConnectionProvider[] = ['github', 'gitlab', 'netlify', 'vercel', 'supabase'];

/** Provider name for a deploy/git connection, matching the server's keys. */
export type { ConnectionProvider };

export async function loadConnections(): Promise<Partial<Record<ConnectionProvider, ConnectionSummary>>> {
  try {
    const response = await fetch('/api/connections', { credentials: 'same-origin' });

    if (!response.ok) {
      return {};
    }

    const data = (await response.json()) as { connections?: Record<string, Record<string, unknown>> };
    const result: Partial<Record<ConnectionProvider, ConnectionSummary>> = {};

    for (const provider of providers) {
      const summary = data.connections?.[provider];

      if (summary) {
        result[provider] = { ...summary, connected: true };
      }
    }

    return result;
  } catch {
    return {};
  }
}

/** Store a connection (token included). Returns false on failure; callers stay local. */
export async function saveConnectionToAccount(
  provider: ConnectionProvider,
  connection: Record<string, unknown>,
): Promise<boolean> {
  try {
    const response = await fetch('/api/connections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, connection }),
      credentials: 'same-origin',
    });

    return response.ok;
  } catch {
    return false;
  }
}

export async function deleteConnectionFromAccount(provider: ConnectionProvider): Promise<boolean> {
  try {
    const response = await fetch('/api/connections', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider }),
      credentials: 'same-origin',
    });

    return response.ok;
  } catch {
    return false;
  }
}
