import type { ActionFunctionArgs, LoaderFunctionArgs } from 'react-router';
import {
  deleteConnection,
  isConnectionProvider,
  listConnections,
  saveConnection,
  type ConnectionProvider,
  type StoredConnection,
} from '~/lib/.server/connections';
import { requireApiUser } from '~/lib/auth-guard';

/*
 * Git / deploy / backend connections for the signed-in account.
 *
 * The loader returns only non-secret summaries: connecting a device does not
 * hand the browser a token it did not already have. Writes accept a full payload
 * (token included) exactly once, when the user connects from this device.
 */

const MAX_FIELD = 4096;

/** Keep only scalar fields, so a payload cannot smuggle nested blobs in. */
function sanitise(connection: unknown): StoredConnection | null {
  if (!connection || typeof connection !== 'object' || Array.isArray(connection)) {
    return null;
  }

  const result: StoredConnection = {};

  for (const [key, value] of Object.entries(connection as Record<string, unknown>)) {
    if (typeof value === 'string') {
      result[key] = value.slice(0, MAX_FIELD);
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      result[key] = value;
    }
  }

  return result;
}

function fail(message: string, status = 400) {
  return Response.json({ ok: false, error: message }, { status });
}

export async function loader({ context }: LoaderFunctionArgs) {
  const user = requireApiUser(context);

  try {
    return Response.json({ ok: true, connections: await listConnections(user.id) });
  } catch (error) {
    console.error('Could not list connections:', error instanceof Error ? error.message : 'unknown error');

    return fail('Could not load connections', 500);
  }
}

export async function action({ context, request }: ActionFunctionArgs) {
  const user = requireApiUser(context);

  let body: { provider?: unknown; connection?: unknown };

  // Clone: React Router consumes the original body before the action runs.
  try {
    body = (await request.clone().json()) as typeof body;
  } catch {
    return fail('Invalid request body');
  }

  if (!isConnectionProvider(body.provider)) {
    return fail('Unknown provider');
  }

  const provider: ConnectionProvider = body.provider;

  try {
    if (request.method === 'DELETE') {
      await deleteConnection(user.id, provider);

      return Response.json({ ok: true });
    }

    const connection = sanitise(body.connection);

    if (!connection) {
      return fail('Connection payload is required');
    }

    await saveConnection(user.id, provider, connection);

    return Response.json({ ok: true });
  } catch (error) {
    console.error(`Connection ${request.method} failed for "${provider}"`, error instanceof Error ? error.message : '');

    return fail('Could not store connection', 500);
  }
}
