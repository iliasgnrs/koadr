import type { LoaderFunction } from 'react-router';
import { getApiKeysForRequest } from '~/lib/api/cookies';
import { getUser } from '~/lib/auth-guard';

export const loader: LoaderFunction = async ({ context, request }) => {
  /*
   * Export only keys supplied by this browser session. Server environment keys
   * belong to the deployment owner and must never be exposed to anonymous users.
   */
  const cookieHeader = request.headers.get('Cookie');
  const apiKeysFromCookie = await getApiKeysForRequest(cookieHeader, getUser(context)?.id);

  return Response.json(apiKeysFromCookie, {
    headers: { 'Cache-Control': 'no-store' },
  });
};
