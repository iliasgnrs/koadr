/*
 * The account row for everything that used to live in localStorage.
 *
 * Reads go through the Supabase client (RLS scopes the row to its owner). Only
 * the sanitisers live here; the route does the query.
 */

export const EDITOR_KEYS = [
  'latestBranch',
  'autoSelectTemplate',
  'contextOptimization',
  'eventLogs',
  'promptId',
  'developerMode',
  'tabConfiguration',
] as const;

export type EditorSettings = Partial<Record<(typeof EDITOR_KEYS)[number], unknown>>;

export interface AccountState {
  editor: EditorSettings;

  /** Non-secret connection summaries (usernames, site ids, token type). */
  connections: Record<string, Record<string, unknown>>;
  mcpServers: unknown[];
  toolAccess: 'ask-for-all' | 'full-access';
  updated_at: string | null;
}

export interface StoredConnection extends Record<string, unknown> {
  token?: string;
  accessToken?: string;
}

const SECRET_FIELDS = ['token', 'accessToken'] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Keep only the known editor keys, so the column cannot be used as scratch space. */
export function normaliseEditor(value: unknown): EditorSettings | null {
  if (!isPlainObject(value)) {
    return null;
  }

  const result: EditorSettings = {};

  for (const key of EDITOR_KEYS) {
    const field = value[key];

    if (field === undefined) {
      continue;
    }

    if (key === 'promptId') {
      if (typeof field === 'string') {
        result[key] = field.slice(0, 128);
      }

      continue;
    }

    if (key === 'tabConfiguration') {
      if (isPlainObject(field) && Array.isArray(field.userTabs)) {
        result[key] = field;
      }

      continue;
    }

    if (typeof field === 'boolean') {
      result[key] = field;
    }
  }

  return result;
}

/** True when the payload still carries a usable secret for this provider. */
export function hasSecret(connection: Record<string, unknown> | undefined): boolean {
  return Boolean(connection && SECRET_FIELDS.some((field) => typeof connection[field] === 'string'));
}

const MCP_MAX_SERVERS = 50;

/** MCP servers: name + url + enable flag only. Nothing executable is stored. */
export function normaliseMcpServers(value: unknown): unknown[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  return value.slice(0, MCP_MAX_SERVERS).flatMap((entry) => {
    if (!isPlainObject(entry) || typeof entry.name !== 'string' || typeof entry.config !== 'object') {
      return [];
    }

    const config = (entry.config ?? {}) as Record<string, unknown>;

    return [
      {
        name: entry.name.slice(0, 64),
        enabled: entry.enabled !== false,
        config: {
          type: typeof config.type === 'string' ? config.type.slice(0, 32) : 'sse',
          url: typeof config.url === 'string' ? config.url.slice(0, 2048) : '',
          ...(typeof config.command === 'string' ? { command: config.command.slice(0, 512) } : {}),
          ...(typeof config.apiKey === 'string' ? { apiKey: config.apiKey.slice(0, 2048) } : {}),
        },
      },
    ];
  });
}

export function normaliseToolAccess(value: unknown): 'ask-for-all' | 'full-access' | null {
  return value === 'ask-for-all' || value === 'full-access' ? value : null;
}
