import { atom, map } from 'nanostores';
import { create } from 'zustand';
import { toggleTheme } from './theme';
import { DEFAULT_TAB_CONFIG } from '~/components/@settings/core/constants';
import type { TabVisibilityConfig, TabWindowConfig, UserTabConfig } from '~/components/@settings/core/types';
import type { IProviderConfig } from '~/types/model';
import { PROVIDER_LIST } from '~/utils/constants';

export interface Shortcut {
  key: string;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  ctrlOrMetaKey?: boolean;
  action: () => void;
  description?: string; // Description of what the shortcut does
  isPreventDefault?: boolean; // Whether to prevent default browser behavior
}

export interface Shortcuts {
  toggleTheme: Shortcut;
  toggleTerminal: Shortcut;
}

export const URL_CONFIGURABLE_PROVIDERS = ['Ollama', 'LMStudio', 'OpenAILike'];
export const LOCAL_PROVIDERS = ['OpenAILike', 'LMStudio', 'Ollama'];

export type ProviderSetting = Record<string, IProviderConfig>;

// Simplified shortcuts store with only theme toggle
export const shortcutsStore = map<Shortcuts>({
  toggleTheme: {
    key: 'd',
    metaKey: true,
    altKey: true,
    shiftKey: true,
    action: () => toggleTheme(),
    description: 'Toggle theme',
    isPreventDefault: true,
  },
  toggleTerminal: {
    key: '`',
    ctrlOrMetaKey: true,
    action: () => {
      // This will be handled by the terminal component
    },
    description: 'Toggle terminal',
    isPreventDefault: true,
  },
});

// Editor flags and the tab bar are account state (user_settings.editor).
const isBrowser = typeof window !== 'undefined';

// Interface for configured provider info from server
interface ConfiguredProvider {
  name: string;
  isConfigured: boolean;
  configMethod: 'environment' | 'none';
}

// Fetch configured providers from server
const fetchConfiguredProviders = async (): Promise<ConfiguredProvider[]> => {
  try {
    const response = await fetch('/api/configured-providers');

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = (await response.json()) as { providers?: ConfiguredProvider[] };

    return data.providers || [];
  } catch (error) {
    console.error('Error fetching configured providers:', error);
    return [];
  }
};

// Initialize provider settings from defaults plus server-detected configuration
const getInitialProviderSettings = (): ProviderSetting => {
  const initialSettings: ProviderSetting = {};

  // Default enabled providers (only these 4 are enabled by default)
  const DEFAULT_ENABLED_PROVIDERS = ['OpenRouter', 'Anthropic', 'OpenAI', 'Google'];

  // Start with default settings
  PROVIDER_LIST.forEach((provider) => {
    initialSettings[provider.name] = {
      ...provider,
      settings: {
        // Only default providers are enabled, all others are disabled by default
        enabled: DEFAULT_ENABLED_PROVIDERS.includes(provider.name),
      },
    };
  });

  return initialSettings;
};

/** Absolute import: settings-client imports this module, so a relative one cycles. */
const pushSettings = () => import('~/lib/settings-client').then((m) => m.queueSettingsSync());

/** Set by the settings sync once the account reports provider settings. */
let hasStoredProviderSettings = false;

export function markProviderSettingsStored(stored: boolean) {
  hasStoredProviderSettings = stored;
}

// Auto-enable providers that are configured on the server
const autoEnableConfiguredProviders = async () => {
  if (!isBrowser) {
    return;
  }

  try {
    const configuredProviders = await fetchConfiguredProviders();
    const currentSettings = providersStore.get();
    const newlyAutoEnabled: string[] = [];

    let hasChanges = false;

    configuredProviders.forEach(({ name, isConfigured, configMethod }) => {
      if (isConfigured && configMethod === 'environment' && LOCAL_PROVIDERS.includes(name)) {
        const currentProvider = currentSettings[name];

        if (currentProvider) {
          /*
           * Only auto-enable a provider that is still off, and only while the
           * account has no saved provider settings at all. Once the user has
           * toggled anything on any device, their choice wins everywhere.
           */
          const shouldAutoEnable = !currentProvider.settings.enabled && !hasStoredProviderSettings;

          if (shouldAutoEnable) {
            currentSettings[name] = {
              ...currentProvider,
              settings: {
                ...currentProvider.settings,
                enabled: true,
              },
            };
            newlyAutoEnabled.push(name);
            hasChanges = true;
          }
        }
      }
    });

    if (hasChanges) {
      providersStore.set(currentSettings);
      void pushSettings();

      console.log(`Auto-enabled providers: ${newlyAutoEnabled.join(', ')}`);
    }
  } catch (error) {
    console.error('Error auto-enabling configured providers:', error);
  }
};

export const providersStore = map<ProviderSetting>(getInitialProviderSettings());

// Export the auto-enable function for use in components
export const initializeProviders = autoEnableConfiguredProviders;

// Create a function to update provider settings that handles both store and persistence
export const updateProviderSettings = (provider: string, settings: ProviderSetting) => {
  const currentSettings = providersStore.get();
  const currentProvider = currentSettings[provider];

  if (!currentProvider) {
    return;
  }

  // Create new provider config with updated settings
  const updatedProvider = {
    ...currentProvider,
    settings: {
      ...currentProvider.settings,
      ...settings,
    },
  };

  // Update the store with new settings
  providersStore.setKey(provider, updatedProvider);
  markProviderSettingsStored(true);

  /*
   * Mirror to the account. The write is debounced and only runs when signed in
   * (401 is ignored), so a toggle does not fire a request per click.
   */
  void pushSettings();
};

/*
 * Editor flags and the tab bar are account state (`user_settings.editor`),
 * hydrated by `applyEditorSettings` after the settings sync. They start at their
 * defaults and are never written to the browser.
 */
export const isDebugMode = atom(false);

export const latestBranchStore = atom<boolean>(false);
export const autoSelectStarterTemplate = atom<boolean>(true);
export const enableContextOptimizationStore = atom<boolean>(true);
export const isEventLogsEnabled = atom<boolean>(true);
export const promptStore = atom<string>('default');

export const updateLatestBranch = (enabled: boolean) => {
  latestBranchStore.set(enabled);
  void pushSettings();
};

export const updateAutoSelectTemplate = (enabled: boolean) => {
  autoSelectStarterTemplate.set(enabled);
  void pushSettings();
};

export const updateContextOptimization = (enabled: boolean) => {
  enableContextOptimizationStore.set(enabled);
  void pushSettings();
};

export const updateEventLogs = (enabled: boolean) => {
  isEventLogsEnabled.set(enabled);
  void pushSettings();
};

export const updatePromptId = (id: string) => {
  promptStore.set(id);
  void pushSettings();
};

function defaultTabConfiguration(): TabWindowConfig {
  return { userTabs: DEFAULT_TAB_CONFIG.filter((tab): tab is UserTabConfig => tab.window === 'user') };
}

export const tabConfigurationStore = map<TabWindowConfig>(defaultTabConfiguration());

/** Refresh the exports below, so a debounced push sends the account's values. */
export function editorSettingsPayload(): Record<string, unknown> {
  return {
    latestBranch: latestBranchStore.get(),
    autoSelectTemplate: autoSelectStarterTemplate.get(),
    contextOptimization: enableContextOptimizationStore.get(),
    eventLogs: isEventLogsEnabled.get(),
    promptId: promptStore.get(),
    developerMode: isDebugMode.get(),
    tabConfiguration: tabConfigurationStore.get(),
  };
}

/** Apply the account's editor flags. Missing keys keep the current value. */
export function applyEditorSettings(editor: Record<string, unknown>) {
  const boolean = (key: string, store: { set: (value: boolean) => void }) => {
    if (typeof editor[key] === 'boolean') {
      store.set(editor[key] as boolean);
    }
  };

  boolean('latestBranch', latestBranchStore);
  boolean('autoSelectTemplate', autoSelectStarterTemplate);
  boolean('contextOptimization', enableContextOptimizationStore);
  boolean('eventLogs', isEventLogsEnabled);
  boolean('developerMode', isDebugMode);

  if (typeof editor.promptId === 'string') {
    promptStore.set(editor.promptId);
  }

  const tabs = editor.tabConfiguration as { userTabs?: unknown } | undefined;

  if (tabs && Array.isArray(tabs.userTabs)) {
    tabConfigurationStore.set(sanitiseTabConfiguration({ userTabs: tabs.userTabs as TabVisibilityConfig[] }));
  }
}

/** Keep only known tabs and append defaults the saved set is missing. */
export function sanitiseTabConfiguration(saved: { userTabs?: TabVisibilityConfig[] }): TabWindowConfig {
  const defaults = defaultTabConfiguration();

  if (!saved?.userTabs) {
    return defaults;
  }

  const savedTabs = saved.userTabs.filter((tab): tab is UserTabConfig => tab?.window === 'user' && Boolean(tab.id));

  const savedIds = new Set(savedTabs.map((tab) => tab.id));
  const missingDefaults = defaults.userTabs.filter((tab) => !savedIds.has(tab.id));

  return { userTabs: [...savedTabs, ...missingDefaults] };
}

export function updateTabConfiguration(config: TabWindowConfig) {
  tabConfigurationStore.set(config);
  void pushSettings();
}

export const resetTabConfiguration = () => {
  tabConfigurationStore.set(defaultTabConfiguration());
  void pushSettings();
};

// First, let's define the SettingsStore interface
interface SettingsStore {
  isOpen: boolean;
  selectedTab: string;
  openSettings: () => void;
  closeSettings: () => void;
  setSelectedTab: (tab: string) => void;
}

export const useSettingsStore = create<SettingsStore>((set) => ({
  isOpen: false,
  selectedTab: 'user', // Default tab

  openSettings: () => {
    set({
      isOpen: true,
      selectedTab: 'user', // Always open to user tab
    });
  },

  closeSettings: () => {
    set({
      isOpen: false,
      selectedTab: 'user', // Reset to user tab when closing
    });
  },

  setSelectedTab: (tab: string) => {
    set({ selectedTab: tab });
  },
}));
