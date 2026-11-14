import { useStore } from '@nanostores/react';
import Cookies from 'js-cookie';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { TabWindowConfig } from '~/components/@settings/core/types';
import { getLocalStorage, setLocalStorage } from '~/lib/persistence';
import { logStore } from '~/lib/stores/logs';
import {
  isDebugMode,
  isEventLogsEnabled,
  LOCAL_PROVIDERS,
  promptStore,
  providersStore,
  latestBranchStore,
  autoSelectStarterTemplate,
  enableContextOptimizationStore,
  tabConfigurationStore,
  resetTabConfiguration as resetTabConfig,
  updateProviderSettings as updateProviderSettingsStore,
  updateSelectedModel as updateSelectedModelStore,
  updateLatestBranch,
  updateAutoSelectTemplate,
  updateContextOptimization,
  updateEventLogs,
  updatePromptId,
} from '~/lib/stores/settings';
import type { IProviderSetting, ProviderInfo, IProviderConfig } from '~/types/model';

export interface Settings {
  theme: 'light' | 'dark' | 'system';
  language: string;
  notifications: boolean;
  eventLogs: boolean;
  timezone: string;
  tabConfiguration: TabWindowConfig;
}

export interface UseSettingsReturn {
  // Theme and UI settings
  setTheme: (theme: Settings['theme']) => void;
  setLanguage: (language: string) => void;
  setNotifications: (enabled: boolean) => void;
  setEventLogs: (enabled: boolean) => void;
  setTimezone: (timezone: string) => void;
  settings: Settings;

  // Provider settings
  providers: Record<string, IProviderConfig>;
  activeProviders: ProviderInfo[];
  updateProviderSettings: (provider: string, config: IProviderSetting) => void;
  updateSelectedModel: (provider: string, model: string) => void;

  // Debug and development settings
  debug: boolean;
  enableDebugMode: (enabled: boolean) => void;
  eventLogs: boolean;
  promptId: string;
  setPromptId: (promptId: string) => void;
  isLatestBranch: boolean;
  enableLatestBranch: (enabled: boolean) => void;
  autoSelectTemplate: boolean;
  setAutoSelectTemplate: (enabled: boolean) => void;
  contextOptimizationEnabled: boolean;
  enableContextOptimization: (enabled: boolean) => void;

  // Tab configuration
  tabConfiguration: TabWindowConfig;
  resetTabConfiguration: () => void;
}

// Add interface to match ProviderSetting type
interface ProviderSettingWithIndex extends IProviderSetting {
  [key: string]: any;
}

export function useSettings(): UseSettingsReturn {
  const providers = useStore(providersStore);
  const debug = useStore(isDebugMode);
  const eventLogs = useStore(isEventLogsEnabled);
  const promptId = useStore(promptStore);
  const isLatestBranch = useStore(latestBranchStore);
  const autoSelectTemplate = useStore(autoSelectStarterTemplate);

  const activeProviders = useMemo(
    () => Object.values(providers).filter((provider) => provider.settings.enabled),
    [providers],
  );

  const contextOptimizationEnabled = useStore(enableContextOptimizationStore);
  const tabConfiguration = useStore(tabConfigurationStore);

  const [settings, setSettings] = useState<Settings>(() => {
    const storedSettings = getLocalStorage('settings');
    return {
      theme: storedSettings?.theme || 'system',
      language: storedSettings?.language || 'en',
      notifications: storedSettings?.notifications ?? true,
      eventLogs: storedSettings?.eventLogs ?? true,
      timezone: storedSettings?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
      tabConfiguration,
    };
  });

  const saveSettings = useCallback((newSettings: Partial<Settings>) => {
    setSettings((prev) => {
      const updated = { ...prev, ...newSettings };
      setLocalStorage('settings', updated);

      return updated;
    });
  }, []);

  const updateProviderSettings = useCallback((provider: string, config: ProviderSettingWithIndex) => {
    updateProviderSettingsStore(provider, config);
  }, []);

  const updateSelectedModel = useCallback((provider: string, model: string) => {
    updateSelectedModelStore(provider, model);
  }, []);

  const enableDebugMode = useCallback((enabled: boolean) => {
    isDebugMode.set(enabled);
    logStore.logSystem(`Debug mode ${enabled ? 'enabled' : 'disabled'}`);
    Cookies.set('isDebugEnabled', String(enabled));
  }, []);

  const setEventLogs = useCallback((enabled: boolean) => {
    updateEventLogs(enabled);
    logStore.logSystem(`Event logs ${enabled ? 'enabled' : 'disabled'}`);
  }, []);

  const setPromptId = useCallback((id: string) => {
    updatePromptId(id);
    logStore.logSystem(`Prompt template updated to ${id}`);
  }, []);

  const enableLatestBranch = useCallback((enabled: boolean) => {
    updateLatestBranch(enabled);
    logStore.logSystem(`Main branch updates ${enabled ? 'enabled' : 'disabled'}`);
  }, []);

  const setAutoSelectTemplate = useCallback((enabled: boolean) => {
    updateAutoSelectTemplate(enabled);
    logStore.logSystem(`Auto select template ${enabled ? 'enabled' : 'disabled'}`);
  }, []);

  const enableContextOptimization = useCallback((enabled: boolean) => {
    updateContextOptimization(enabled);
    logStore.logSystem(`Context optimization ${enabled ? 'enabled' : 'disabled'}`);
  }, []);

  const setTheme = useCallback(
    (theme: Settings['theme']) => {
      saveSettings({ theme });
    },
    [saveSettings],
  );

  const setLanguage = useCallback(
    (language: string) => {
      saveSettings({ language });
    },
    [saveSettings],
  );

  const setNotifications = useCallback(
    (enabled: boolean) => {
      saveSettings({ notifications: enabled });
    },
    [saveSettings],
  );

  const setTimezone = useCallback(
    (timezone: string) => {
      saveSettings({ timezone });
    },
    [saveSettings],
  );

  useEffect(() => {
    /*
     * Signed-out local models (Ollama and friends) still read their base URLs
     * from this cookie: `/api/chat` and `/api/llmcall` accept it for those
     * providers. Everything else — enabled flags, selected models — lives only
     * on the account, because a cookie copy goes stale on every other device.
     */
    const providers = providersStore.get();
    const localOnly: Record<string, IProviderSetting> = {};

    LOCAL_PROVIDERS.forEach((name) => {
      const entry = providers[name];

      if (entry) {
        localOnly[name] = { baseUrl: entry.settings.baseUrl };
      }
    });

    Cookies.set('providers', JSON.stringify(localOnly));
  }, [providers]);

  return {
    ...settings,
    providers,
    activeProviders,
    updateProviderSettings,
    updateSelectedModel,
    debug,
    enableDebugMode,
    eventLogs,
    setEventLogs,
    promptId,
    setPromptId,
    isLatestBranch,
    enableLatestBranch,
    autoSelectTemplate,
    setAutoSelectTemplate,
    contextOptimizationEnabled,
    enableContextOptimization,
    setTheme,
    setLanguage,
    setNotifications,
    setTimezone,
    settings,
    tabConfiguration,
    resetTabConfiguration: resetTabConfig,
  };
}
