import type { LoaderFunctionArgs } from 'react-router';
import { getSupabaseSession } from '~/lib/.server/supabase';

/*
 * Minimal account state for the shell.
 *
 * The root document needs the theme and interface options *before* React
 * hydrates, and that must come from the account — not a browser cache — so this
 * route answers only those two fields and never the heavier settings payload.
 */

export interface ShellSettings {
  theme: string | null;
  interfaceOptions: {
    accentIntensity: number;
    cornerRadius: string;
    compactMode: boolean;
    animatedTransitions: boolean;
  } | null;
}

export async function loader({ request }: LoaderFunctionArgs) {
  const empty = { ok: true, settings: { theme: null, interfaceOptions: null } satisfies ShellSettings };

  /*
   * getSupabaseSession already resolved the caller; it also carries the cookies
   * the client may have refreshed, so they are copied onto every response.
   */
  let session;

  try {
    session = await getSupabaseSession(request);
  } catch (error) {
    console.error('Shell settings: session resolution failed', error);

    return Response.json(empty);
  }

  const { client, user, headers } = session;

  const respond = (body: unknown) => {
    const response = Response.json(body);

    for (const cookie of headers.getSetCookie()) {
      response.headers.append('Set-Cookie', cookie);
    }

    return response;
  };

  if (!user) {
    return respond(empty);
  }

  const { data, error } = await client
    .from('user_settings')
    .select('theme, interface_options')
    .eq('profile_id', user.id)
    .maybeSingle();

  if (error) {
    console.error('Shell settings: read failed', error.message);

    return respond(empty);
  }

  return respond({
    ok: true,
    settings: {
      theme: (data?.theme as string | null) ?? null,
      interfaceOptions: (data?.interface_options as ShellSettings['interfaceOptions']) ?? null,
    },
  });
}
