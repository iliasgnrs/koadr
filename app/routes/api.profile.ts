import type { ActionFunctionArgs, LoaderFunctionArgs } from 'react-router';
import { getPgPool } from '~/lib/.server/pg';
import { getSupabaseSession } from '~/lib/.server/supabase';
import { requireApiUser } from '~/lib/auth-guard';

/*
 * The signed-in account's profile.
 *
 * `email` is returned separately from `username` so the UI can fall back to the
 * address when the user has not chosen a name — showing "Guest User" to someone
 * who is signed in is simply wrong.
 */

const USERNAME_PATTERN = /^[a-zA-Z0-9_.-]{2,32}$/;
const MAX_AVATAR_LENGTH = 400_000; // a reasonable data-URL ceiling

export async function loader({ context, request }: LoaderFunctionArgs) {
  const user = requireApiUser(context);
  const { client } = await getSupabaseSession(request);

  const { data, error } = await client.from('profiles').select('username, avatar_url').eq('id', user.id).maybeSingle();

  if (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }

  return Response.json({
    ok: true,
    profile: {
      email: user.email ?? null,
      username: data?.username ?? null,
      avatar: data?.avatar_url ?? null,
    },
  });
}

export async function action({ context, request }: ActionFunctionArgs) {
  const user = requireApiUser(context);

  let body: { username?: unknown; avatar?: unknown };

  // Clone: React Router consumes the original body before the action runs.
  try {
    body = (await request.clone().json()) as typeof body;
  } catch {
    return Response.json({ ok: false, error: 'Invalid request body' }, { status: 400 });
  }

  const updates: { username?: string; avatar_url?: string | null } = {};

  if (body.username !== undefined) {
    const username = typeof body.username === 'string' ? body.username.trim() : '';

    if (username === '') {
      // Clearing the name is legitimate: the UI falls back to the email.
      updates.username = '';
    } else if (!USERNAME_PATTERN.test(username)) {
      return Response.json(
        { ok: false, error: 'Usernames are 2-32 characters: letters, numbers, dot, dash, underscore' },
        { status: 400 },
      );
    } else {
      updates.username = username;
    }
  }

  if (body.avatar !== undefined) {
    if (typeof body.avatar !== 'string' || body.avatar.length > MAX_AVATAR_LENGTH) {
      return Response.json({ ok: false, error: 'Avatar is too large' }, { status: 400 });
    }

    updates.avatar_url = body.avatar || null;
  }

  if (Object.keys(updates).length === 0) {
    return Response.json({ ok: false, error: 'Nothing to update' }, { status: 400 });
  }

  try {
    /*
     * Direct Postgres, not PostgREST: `profiles` is granted to `authenticated`
     * so RLS would also allow this, but a unique-username collision needs to
     * come back as a clear 409 rather than a generic PostgREST error string.
     */
    await getPgPool().query(
      `update public.profiles
          set username = coalesce($2, username),
              avatar_url = coalesce($3, avatar_url),
              updated_at = now()
        where id = $1`,
      [user.id, updates.username ?? null, updates.avatar_url ?? null],
    );

    return Response.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';

    if (message.includes('duplicate key') || message.includes('profiles_username_key')) {
      return Response.json({ ok: false, error: 'That username is already taken' }, { status: 409 });
    }

    console.error('Profile update failed');

    return Response.json({ ok: false, error: 'Could not save profile' }, { status: 500 });
  }
}
