import { create } from 'zustand';
import type { MCPConfig, MCPServerTools } from '~/lib/services/mcpService';

/** The `mcp_servers` column only holds what is needed to reach each server. */
function flattenMcpServers(config: MCPConfig) {
  return Object.entries(config?.mcpServers ?? {}).map(([name, server]) => ({
    name,
    enabled: true,
    config:
      server.type === 'stdio' ? { type: server.type, command: server.command } : { type: server.type, url: server.url },
  }));
}

/** Rebuild an MCPConfig from the stored server list. */
function expandMcpServers(servers: unknown): MCPConfig | null {
  if (!Array.isArray(servers) || servers.length === 0) {
    return null;
  }

  const mcpServers: MCPConfig['mcpServers'] = {};

  for (const entry of servers) {
    const server = entry as { name?: unknown; config?: Record<string, unknown> };

    if (typeof server.name !== 'string' || !server.config) {
      continue;
    }

    mcpServers[server.name] = server.config as MCPConfig['mcpServers'][string];
  }

  return { mcpServers };
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Mirror MCP settings to the account row.
 *
 * Debounced because every toggle in the config UI calls a setter, and each write
 * is a full replace of the `editor.mcpConfig` blob. 401 (signed out) is ignored:
 * the in-memory store still works for the session.
 */
function persistSettings(settings: MCPSettings) {
  if (typeof window === 'undefined') {
    return;
  }

  if (persistTimer) {
    clearTimeout(persistTimer);
  }

  persistTimer = setTimeout(() => {
    persistTimer = null;

    void fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mcpServers: flattenMcpServers(settings.mcpConfig) }),
      credentials: 'same-origin',
    }).catch(() => undefined);
  }, 600);
}

export type ConnectorId = 'github' | 'gitlab' | 'vercel' | 'netlify' | 'supabase' | 'browserUseCloud';

type MCPSettings = {
  mcpConfig: MCPConfig;
  maxLLMSteps: number;
  webSearchEnabled: boolean;
  connectorEnabled: {
    [connector in ConnectorId]: boolean;
  };
  toolEnabled: Record<string, boolean>;
};

/*
 * 12 matches the server's agent ceiling (api.chat.ts caps at 12). The old default
 * of 5 let a single inspect/edit/run/test/repair cycle exhaust the budget mid-run,
 * because `agent_plan`, every tool call and every verification step each consume one.
 */
const defaultSettings = {
  maxLLMSteps: 12,
  webSearchEnabled: true,
  connectorEnabled: {
    github: false,
    gitlab: false,
    vercel: false,
    netlify: false,
    supabase: false,
    browserUseCloud: false,
  },
  mcpConfig: {
    mcpServers: {},
  },
  toolEnabled: {},
} satisfies MCPSettings;

type Store = {
  isInitialized: boolean;
  settings: MCPSettings;
  serverTools: MCPServerTools;
  error: string | null;
  isUpdatingConfig: boolean;
};

type Actions = {
  initialize: () => Promise<void>;
  updateSettings: (settings: MCPSettings) => Promise<void>;
  setWebSearchEnabled: (enabled: boolean) => void;
  setConnectorEnabled: (connector: keyof MCPSettings['connectorEnabled'], enabled: boolean) => void;
  setToolEnabled: (toolName: string, enabled: boolean) => void;
  checkServersAvailabilities: () => Promise<void>;
};

export const useMCPStore = create<Store & Actions>((set, get) => ({
  isInitialized: false,
  settings: defaultSettings,
  serverTools: {},
  error: null,
  isUpdatingConfig: false,
  initialize: async () => {
    if (get().isInitialized) {
      return;
    }

    if (typeof window !== 'undefined') {
      try {
        const response = await fetch('/api/settings', { credentials: 'same-origin' });

        if (response.ok) {
          const data = (await response.json()) as { settings?: { mcpServers?: unknown } };
          const config = expandMcpServers(data.settings?.mcpServers);

          if (config) {
            const settings = { ...defaultSettings, mcpConfig: { ...defaultSettings.mcpConfig, ...config } };
            const serverTools = await updateServerConfig(settings.mcpConfig);
            set(() => ({ settings, serverTools }));
          }
        }
      } catch (error) {
        console.error('Error reading saved mcp config:', error);
        set(() => ({
          error: `Error reading saved mcp config: ${error instanceof Error ? error.message : String(error)}`,
        }));
      }
    }

    set(() => ({ isInitialized: true }));
  },
  updateSettings: async (newSettings: MCPSettings) => {
    if (get().isUpdatingConfig) {
      return;
    }

    try {
      set(() => ({ isUpdatingConfig: true }));

      const serverTools = await updateServerConfig(newSettings.mcpConfig);

      persistSettings(newSettings);

      set(() => ({ settings: newSettings, serverTools }));
    } catch (error) {
      throw error;
    } finally {
      set(() => ({ isUpdatingConfig: false }));
    }
  },
  setWebSearchEnabled: (enabled: boolean) => {
    const settings = { ...get().settings, webSearchEnabled: enabled };

    persistSettings(settings);

    set({ settings });
  },
  setConnectorEnabled: (connector, enabled) => {
    const settings = {
      ...get().settings,
      connectorEnabled: { ...get().settings.connectorEnabled, [connector]: enabled },
    };

    persistSettings(settings);

    set({ settings });
  },
  setToolEnabled: (toolName, enabled) => {
    const settings = {
      ...get().settings,
      toolEnabled: { ...get().settings.toolEnabled, [toolName]: enabled },
    };

    persistSettings(settings);

    set({ settings });
  },
  checkServersAvailabilities: async () => {
    const response = await fetch('/api/mcp-check', {
      method: 'GET',
    });

    if (!response.ok) {
      throw new Error(`Server responded with ${response.status}: ${response.statusText}`);
    }

    const serverTools = (await response.json()) as MCPServerTools;

    set(() => ({ serverTools }));
  },
}));

async function updateServerConfig(config: MCPConfig) {
  const response = await fetch('/api/mcp-update-config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });

  if (!response.ok) {
    throw new Error(`Server responded with ${response.status}: ${response.statusText}`);
  }

  const data = (await response.json()) as MCPServerTools;

  return data;
}
