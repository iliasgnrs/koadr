import { redirect } from 'react-router';
import type { BoltCloudflare } from '~/lib/cloudflare-context';

export interface SessionUser {
  id: string;
  email?: string;
}

/*
 * The user resolved once per request in `getLoadContext` (see server/app.ts).
 * Attaching it to the context means a loader can read it synchronously instead of
 * calling GoTrue again for every matched route.
 */
export interface AuthContext {
  cloudflare: BoltCloudflare;
  user: SessionUser | null;
  clientAddress?: string;
}

export function getUser(context: unknown): SessionUser | null {
  return (context as { user?: SessionUser | null } | undefined)?.user ?? null;
}

/**
 * Require a signed-in user for a page load.
 *
 * There is no guest mode (decided for this project), so every page route that is
 * not itself part of the auth flow calls this. The original path is preserved in
 * `returnTo` so the user lands where they were headed after signing in.
 */
export function requireUser(context: unknown, request: Request): SessionUser {
  const user = getUser(context);

  if (user) {
    return user;
  }

  const url = new URL(request.url);
  const returnTo = `${url.pathname}${url.search}`;
  const search = returnTo && returnTo !== '/' ? `?returnTo=${encodeURIComponent(returnTo)}` : '';

  throw redirect(`/login${search}`);
}

/**
 * Require a signed-in user for an API route.
 *
 * API callers get a 401 rather than a redirect: a fetch that silently follows a
 * redirect to an HTML login page fails in a confusing way inside the client.
 */
export function requireApiUser(context: unknown): SessionUser {
  const user = getUser(context);

  if (!user) {
    throw Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  return user;
}
