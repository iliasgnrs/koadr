import type { LoaderFunctionArgs } from 'react-router';
import { redirect } from 'react-router';
import { getSupabaseSession } from '~/lib/.server/supabase';

/*
 * Landing point for magic-link and recovery emails.
 *
 * Supabase redirects here with a `code` (PKCE) or with token fragments. The code
 * exchange must happen on the server so the session lands in an HttpOnly cookie
 * rather than being written by client JS.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const next = url.searchParams.get('next') || '/';

  // Never bounce to an absolute URL supplied by the caller.
  const target = next.startsWith('/') && !next.startsWith('//') ? next : '/';

  if (!code) {
    return redirect('/login?error=missing_code');
  }

  const { client, headers } = await getSupabaseSession(request);
  const { error } = await client.auth.exchangeCodeForSession(code);

  if (error) {
    return redirect(`/login?error=${encodeURIComponent(error.message)}`);
  }

  const response = redirect(target);

  for (const value of headers.getSetCookie()) {
    response.headers.append('Set-Cookie', value);
  }

  return response;
}
