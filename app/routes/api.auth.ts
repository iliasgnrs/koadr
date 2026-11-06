import type { ActionFunctionArgs } from 'react-router';
import { getSupabaseSession } from '~/lib/.server/supabase';

/*
 * Single entry point for the auth mutations the UI performs.
 *
 * Server-side rather than calling GoTrue from the browser, for two reasons:
 * the session must end up in an HttpOnly cookie the page cannot read, and
 * SUPABASE_URL stays a container-network address that never reaches the client.
 */

type AuthAction =
  | { action: 'signup'; email: string; password: string }
  | { action: 'login'; email: string; password: string }
  | { action: 'magic-link'; email: string }
  | { action: 'forgot-password'; email: string }
  | { action: 'reset-password'; password: string }
  | { action: 'logout' };

/** Copy the session cookies the client set onto the outgoing response. */
function withSessionCookies(response: Response, headers: Headers) {
  const result = new Response(response.body, response);

  for (const value of headers.getSetCookie()) {
    result.headers.append('Set-Cookie', value);
  }

  return result;
}

function fail(error: string, status = 400) {
  return Response.json({ ok: false, error }, { status });
}

export async function action({ request }: ActionFunctionArgs) {
  let body: AuthAction;

  /*
   * React Router consumes a JSON request body itself before the action runs, so
   * reading `request` directly yields "Unexpected non-whitespace character after
   * JSON". The clone is still unconsumed.
   */
  try {
    body = (await request.clone().json()) as AuthAction;
  } catch {
    return fail('Invalid request body');
  }

  const { client, headers } = await getSupabaseSession(request);

  if (body.action === 'logout') {
    const { error } = await client.auth.signOut();

    /*
     * A failed signOut still clears the local session in @supabase/ssr, so the
     * user is logged out either way; only surface a hard failure.
     */
    if (error && error.status && error.status >= 500) {
      return fail(error.message, 500);
    }

    return withSessionCookies(Response.json({ ok: true }), headers);
  }

  switch (body.action) {
    case 'reset-password': {
      if (!body.password || body.password.length < 8) {
        return fail('Password must be at least 8 characters');
      }

      const { error } = await client.auth.updateUser({ password: body.password });

      if (error) {
        return fail(error.message, 401);
      }

      return withSessionCookies(Response.json({ ok: true }), headers);
    }

    case 'signup': {
      const email = body.email?.trim().toLowerCase();

      if (!email) {
        return fail('Email is required');
      }

      if (!body.password || body.password.length < 8) {
        return fail('Password must be at least 8 characters');
      }

      const { error } = await client.auth.signUp({ email, password: body.password });

      if (error) {
        return fail(error.message);
      }

      return withSessionCookies(Response.json({ ok: true, needsVerification: true }), headers);
    }

    case 'login': {
      const email = body.email?.trim().toLowerCase();

      if (!email) {
        return fail('Email is required');
      }

      const { error } = await client.auth.signInWithPassword({ email, password: body.password });

      if (error) {
        return fail(error.message, 401);
      }

      return withSessionCookies(Response.json({ ok: true }), headers);
    }

    case 'magic-link': {
      const email = body.email?.trim().toLowerCase();

      if (!email) {
        return fail('Email is required');
      }

      const redirectTo = new URL('/auth/callback', request.url).toString();
      const { error } = await client.auth.signInWithOtp({ email, options: { emailRedirectTo: redirectTo } });

      if (error) {
        return fail(error.message);
      }

      return withSessionCookies(Response.json({ ok: true }), headers);
    }

    case 'forgot-password': {
      const email = body.email?.trim().toLowerCase();

      if (!email) {
        return fail('Email is required');
      }

      const redirectTo = new URL('/reset-password', request.url).toString();
      const { error } = await client.auth.resetPasswordForEmail(email, { redirectTo });

      if (error) {
        return fail(error.message);
      }

      /*
       * Always report success: revealing whether an address is registered would
       * turn this endpoint into an account-enumeration oracle.
       */
      return withSessionCookies(Response.json({ ok: true }), headers);
    }

    default:
      return fail('Unknown action');
  }
}

export async function loader() {
  return Response.json({ ok: false, error: 'Method not allowed' }, { status: 405 });
}
