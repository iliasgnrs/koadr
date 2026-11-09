import type { ActionFunctionArgs, LoaderFunctionArgs } from 'react-router';
import { getSupabaseSession } from '~/lib/.server/supabase';
import { requireApiUser } from '~/lib/auth-guard';
import { isKnownTheme, normaliseInterfaceOptions } from '~/lib/settings-sync';
import { normaliseTheme } from '~/types/theme';

/*
 * Server-side settings sync.
 *
 * RLS on user_settings already restricts every row to its owner, so these
 * handlers never take a profile id from the client — the user comes from the
 * session and Supabase applies the policy.
 */

export async function loader({ context, request }: LoaderFunctionArgs) {
  const user = requireApiUser(context);
  const { client } = await getSupabaseSession(request);

  const { data, error } = await client
    .from('user_settings')
    .select('theme, interface_options, updated_at')
    .eq('profile_id', user.id)
    .maybeSingle();

  if (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }

  return Response.json({
    ok: true,
    settings: data
      ? {
          theme: data.theme,
          interfaceOptions: normaliseInterfaceOptions(data.interface_options),
          updated_at: data.updated_at,
        }
      : null,
  });
}

export async function action({ context, request }: ActionFunctionArgs) {
  const user = requireApiUser(context);

  let body: { theme?: unknown; interfaceOptions?: unknown };

  // Clone: React Router consumes the original body before the action runs.
  try {
    body = (await request.clone().json()) as typeof body;
  } catch {
    return Response.json({ ok: false, error: 'Invalid request body' }, { status: 400 });
  }

  if (body.theme !== undefined && !isKnownTheme(body.theme)) {
    return Response.json({ ok: false, error: 'Unknown theme' }, { status: 400 });
  }

  // Persist the migrated value, so a legacy palette id is rewritten once.
  const theme = body.theme === undefined ? undefined : normaliseTheme(body.theme);

  const { client } = await getSupabaseSession(request);

  const { error } = await client.from('user_settings').upsert(
    {
      profile_id: user.id,
      ...(theme !== undefined ? { theme } : {}),
      ...(body.interfaceOptions !== undefined
        ? { interface_options: normaliseInterfaceOptions(body.interfaceOptions) }
        : {}),
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'profile_id' },
  );

  if (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }

  return Response.json({ ok: true });
}
