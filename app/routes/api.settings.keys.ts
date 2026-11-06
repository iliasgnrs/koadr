import type { ActionFunctionArgs, LoaderFunctionArgs } from 'react-router';
import { deleteApiKey, listApiKeys, saveApiKey } from '~/lib/.server/api-keys';
import { requireApiUser } from '~/lib/auth-guard';

/*
 * Provider key management. The browser may write a key and see which providers
 * are configured, but a stored key is never returned in any form.
 */

const PROVIDER_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

export async function loader({ context }: LoaderFunctionArgs) {
  const user = requireApiUser(context);

  try {
    return Response.json({ ok: true, keys: await listApiKeys(user.id) });
  } catch (error) {
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : 'Could not list keys' },
      { status: 500 },
    );
  }
}

export async function action({ context, request }: ActionFunctionArgs) {
  const user = requireApiUser(context);

  let body: { provider?: unknown; key?: unknown };

  /*
   * Clone: React Router consumes the original body before the action runs. This
   * is the same trap that broke /api/auth in Slice 1.
   */
  try {
    body = (await request.clone().json()) as typeof body;
  } catch {
    return Response.json({ ok: false, error: 'Invalid request body' }, { status: 400 });
  }

  const provider = typeof body.provider === 'string' ? body.provider : '';

  if (!PROVIDER_PATTERN.test(provider)) {
    return Response.json({ ok: false, error: 'Unknown provider' }, { status: 400 });
  }

  try {
    if (request.method === 'DELETE') {
      await deleteApiKey(user.id, provider);

      return Response.json({ ok: true });
    }

    if (typeof body.key !== 'string' || body.key.trim().length < 8) {
      return Response.json({ ok: false, error: 'Key looks too short' }, { status: 400 });
    }

    await saveApiKey(user.id, provider, body.key.trim());

    /*
     * Deliberately returns no hint or echo of the key: the client already knows
     * what it sent, and omitting it keeps the response free of secret material
     * in case it is ever logged.
     */
    return Response.json({ ok: true });
  } catch (error) {
    console.error(`API key ${request.method} failed for provider "${provider}"`);

    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : 'Could not store key' },
      { status: 500 },
    );
  }
}
