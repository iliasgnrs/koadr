import type { ActionFunctionArgs, LoaderFunctionArgs } from 'react-router';
import { normaliseEditor, normaliseMcpServers, normaliseToolAccess } from '~/lib/.server/account-state';
import { getSupabaseSession } from '~/lib/.server/supabase';
import { requireApiUser } from '~/lib/auth-guard';
import {
  INVALID_PROVIDER_SETTINGS,
  isKnownTheme,
  normaliseInterfaceOptions,
  normaliseProviderSettings,
} from '~/lib/settings-sync';
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
    .select('theme, interface_options, provider_settings, editor, mcp_servers, tool_access, updated_at')
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
          providerSettings: normaliseProviderSettings(data.provider_settings),
          editor: normaliseEditor(data.editor) ?? {},
          mcpServers: normaliseMcpServers(data.mcp_servers) ?? [],
          toolAccess: normaliseToolAccess(data.tool_access) ?? 'ask-for-all',
          updated_at: data.updated_at,
        }
      : null,
  });
}

export async function action({ context, request }: ActionFunctionArgs) {
  const user = requireApiUser(context);

  let body: {
    theme?: unknown;
    interfaceOptions?: unknown;
    providerSettings?: unknown;
    editor?: unknown;
    mcpServers?: unknown;
    toolAccess?: unknown;
  };

  // Clone: React Router consumes the original body before the action runs.
  try {
    body = (await request.clone().json()) as typeof body;
  } catch {
    return Response.json({ ok: false, error: 'Invalid request body' }, { status: 400 });
  }

  if (body.theme !== undefined && !isKnownTheme(body.theme)) {
    return Response.json({ ok: false, error: 'Unknown theme' }, { status: 400 });
  }

  const providerSettings = normaliseProviderSettings(body.providerSettings);

  if (providerSettings === INVALID_PROVIDER_SETTINGS) {
    return Response.json({ ok: false, error: 'Invalid provider settings' }, { status: 400 });
  }

  const editor = body.editor === undefined ? undefined : normaliseEditor(body.editor);
  const mcpServers = body.mcpServers === undefined ? undefined : normaliseMcpServers(body.mcpServers);
  const toolAccess = body.toolAccess === undefined ? undefined : normaliseToolAccess(body.toolAccess);

  if (editor === null || mcpServers === null || toolAccess === null) {
    return Response.json({ ok: false, error: 'Invalid settings payload' }, { status: 400 });
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
      ...(providerSettings !== undefined ? { provider_settings: providerSettings } : {}),
      ...(editor !== undefined ? { editor } : {}),
      ...(mcpServers !== undefined ? { mcp_servers: mcpServers } : {}),
      ...(toolAccess !== undefined ? { tool_access: toolAccess } : {}),
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'profile_id' },
  );

  if (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }

  return Response.json({ ok: true });
}
