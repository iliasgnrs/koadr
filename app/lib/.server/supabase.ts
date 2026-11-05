import { createServerClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';

/*
 * Server-side Supabase session handling.
 *
 * The browser never talks to GoTrue directly: it POSTs to our own routes, and
 * those use these helpers so the session lives in an HttpOnly cookie that page
 * JavaScript cannot read.
 *
 * Every function takes the incoming `Request` and returns the cookies that must
 * be written back to the response — `@supabase/ssr` cannot set cookies itself
 * outside a Next.js action, so the caller owns that part.
 */

export interface SupabaseSession {
  client: SupabaseClient;

  /** Cookies the caller must copy onto the outgoing Response. */
  headers: Headers;
  user: { id: string; email?: string } | null;
}

function readConfig() {
  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    throw new Error('SUPABASE_URL and SUPABASE_ANON_KEY must be set on the server');
  }

  return { url, anonKey };
}

/** Minimal cookie access over a Fetch `Request`/`Headers`. */
function cookieAdapter(request: Request, carrier: Headers) {
  return {
    getAll() {
      const header = request.headers.get('cookie') ?? '';

      return splitCookies(header);
    },
    setAll(cookies: { name: string; value: string; options?: Record<string, unknown> }[]) {
      for (const { name, value, options } of cookies) {
        carrier.append('Set-Cookie', serializeCookie(name, value, options));
      }
    },
  };
}

function splitCookies(header: string) {
  if (!header) {
    return [];
  }

  return header
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const index = part.indexOf('=');

      return index === -1
        ? { name: part, value: '' }
        : { name: part.slice(0, index), value: decodeURIComponent(part.slice(index + 1)) };
    });
}

function serializeCookie(name: string, value: string, options: Record<string, unknown> = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];

  parts.push(`Path=${(options.path as string) ?? '/'}`);

  if (options.maxAge !== undefined) {
    parts.push(`Max-Age=${options.maxAge}`);
  }

  if (options.expires) {
    parts.push(`Expires=${new Date(options.expires as string).toUTCString()}`);
  }

  if (options.domain) {
    parts.push(`Domain=${options.domain}`);
  }

  /*
   * HttpOnly is the whole point of doing sessions server-side: an XSS bug in the
   * chat UI must not be able to read the session out of document.cookie.
   */
  parts.push('HttpOnly');
  parts.push(`SameSite=${(options.sameSite as string) ?? 'Lax'}`);

  if (options.secure !== false) {
    parts.push('Secure');
  }

  return parts.join('; ');
}

/** Resolve the caller's session from the request cookies. */
export async function getSupabaseSession(request: Request): Promise<SupabaseSession> {
  const { url, anonKey } = readConfig();
  const headers = new Headers();

  const client = createServerClient(url, anonKey, {
    cookies: cookieAdapter(request, headers),
    cookieOptions: { httpOnly: true, secure: true, sameSite: 'lax', path: '/' },
  });

  const {
    data: { user },
  } = await client.auth.getUser();

  return {
    client,
    headers,
    user: user ? { id: user.id, email: user.email ?? undefined } : null,
  };
}
