import { normaliseInterfaceOptions } from './settings-sync';
import { useMCPStore } from './stores/mcp';
import {
  applyEditorSettings,
  editorSettingsPayload,
  markProviderSettingsStored,
  providersStore,
} from './stores/settings';
import { themeStore } from './stores/theme';
import { useToolAccessStore, type ToolAccessMode } from './stores/toolAccess';

/*
 * Client half of settings sync.
 *
 * The account is the single source of truth: theme, interface options, provider
 * settings, editor flags, MCP servers and the tool mode all live on the server
 * row, and nothing is persisted in the browser. Writes are debounced because the
 * settings tab fires on every slider drag, and a request per drag event would be
 * both wasteful and racy.
 */

const WRITE_DEBOUNCE_MS = 800;

let pendingTimer: ReturnType<typeof setTimeout> | null = null;
let queued = false;

/*
 * Set while applying a value that came *from* the server, so the resulting
 * setTheme() call does not queue another push and start a write ping-pong
 * between two devices.
 */
let applyingRemote = false;

export function isApplyingRemote() {
  return applyingRemote;
}

export function beginApplyingRemote() {
  applyingRemote = true;
}

export function endApplyingRemote() {
  applyingRemote = false;
}

function readProviderSettings(): Record<string, { settings: unknown }> | null {
  const providers = providersStore.get();
  const names = Object.keys(providers);

  if (names.length === 0) {
    return null;
  }

  return Object.fromEntries(names.map((name) => [name, { settings: providers[name].settings }]));
}

/** Push the current values to the server, coalescing bursts. */
export function queueSettingsSync() {
  if (applyingRemote) {
    return;
  }

  queued = true;

  if (pendingTimer) {
    return;
  }

  pendingTimer = setTimeout(() => {
    pendingTimer = null;

    if (!queued) {
      return;
    }

    queued = false;
    void pushNow();
  }, WRITE_DEBOUNCE_MS);
}

async function pushNow() {
  const theme = themeStore.get();
  const interfaceOptions = currentInterfaceOptions();
  const providerSettings = readProviderSettings();

  try {
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        theme,
        interfaceOptions,
        editor: editorSettingsPayload(),
        ...(providerSettings ? { providerSettings } : {}),
      }),
      credentials: 'same-origin',
    });
  } catch {
    /*
     * Offline or signed out. The next successful load re-reads the account, so a
     * failed push is not worth surfacing.
     */
  }
}

/** Interface options as last applied to the document (see applyInterfaceOptions). */
export function currentInterfaceOptions() {
  if (typeof document === 'undefined') {
    return normaliseInterfaceOptions({});
  }

  const root = document.documentElement;

  return normaliseInterfaceOptions({
    accentIntensity: Number(root.dataset.accentIntensity),
    cornerRadius: root.dataset.cornerRadius,
    compactMode: root.dataset.compactMode === 'true',
    animatedTransitions: root.dataset.animatedTransitions !== 'false',
  });
}

/**
 * Reconcile this device with the account. Called once after the first paint of an
 * authenticated session.
 *
 * The account is the only source: nothing is read from or written to
 * localStorage, so a fresh browser, a phone or an incognito window all render
 * the same values. Returns what was applied, or null when the account could not
 * be read.
 */
export async function syncSettingsFromServer(): Promise<{
  theme?: string;
  interfaceOptions?: unknown;
  providerSettings?: unknown;
  editor?: Record<string, unknown>;
  toolAccess?: ToolAccessMode;
} | null> {
  let remote: {
    theme?: string | null;
    interfaceOptions?: unknown;
    providerSettings?: unknown;
    editor?: unknown;
    mcpServers?: unknown;
    toolAccess?: unknown;
  } | null = null;

  try {
    const response = await fetch('/api/settings', { credentials: 'same-origin' });

    if (!response.ok) {
      return null;
    }

    const data = (await response.json()) as { settings: any };
    remote = data.settings;
  } catch {
    return null;
  }

  const { DEFAULT_THEME } = await import('~/lib/stores/theme');
  const { normaliseTheme } = await import('~/types/theme');

  const applied: {
    theme: string;
    interfaceOptions?: unknown;
    providerSettings?: unknown;
    editor?: Record<string, unknown>;
    toolAccess?: ToolAccessMode;
  } = {
    theme: remote?.theme ? normaliseTheme(remote.theme) : DEFAULT_THEME,
    interfaceOptions: normaliseInterfaceOptions(remote?.interfaceOptions),
  };

  /*
   * Enabled providers live on the account, so the local store is replaced rather
   * than merged: a provider disabled on one device must not stay enabled here.
   */
  if (remote?.providerSettings) {
    applied.providerSettings = remote.providerSettings;
    markProviderSettingsStored(Object.keys(remote.providerSettings).length > 0);
  }

  /*
   * Editor flags, MCP servers and the tool mode have no local copy: the account
   * is their only home, so they are applied straight to their stores.
   */
  applied.editor = (remote?.editor ?? {}) as Record<string, unknown>;
  applyEditorSettings(applied.editor);

  if (remote?.toolAccess === 'full-access' || remote?.toolAccess === 'ask-for-all') {
    useToolAccessStore.getState().hydrate(remote.toolAccess);
    applied.toolAccess = remote.toolAccess;
  }

  if (Array.isArray(remote?.mcpServers) && remote.mcpServers.length > 0) {
    void useMCPStore.getState().initialize();
  }

  queueSettingsSync();

  return applied;
}

/** Mirrors what SettingsTab does on every change, so sync and UI agree. */
export function applyInterfaceOptions(options: unknown) {
  const normalised = normaliseInterfaceOptions(options);
  const root = document.documentElement;

  root.dataset.accentIntensity = String(normalised.accentIntensity);
  root.style.setProperty('--interface-accent-strength', `${normalised.accentIntensity}%`);
  root.dataset.cornerRadius = normalised.cornerRadius;
  root.dataset.compactMode = String(normalised.compactMode);
  root.dataset.animatedTransitions = String(normalised.animatedTransitions);
}

/**
 * Mirror a provider key to the account.
 *
 * Best-effort: the cookie copy is still written by the caller, so a failure here
 * (signed out, offline) costs nothing except that the key stays browser-local.
 * The key itself is never logged or stored anywhere else in the client.
 */
export async function saveKeyToAccount(provider: string, key: string): Promise<boolean> {
  try {
    const response = await fetch('/api/settings/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, key }),
      credentials: 'same-origin',
    });

    return response.ok;
  } catch {
    return false;
  }
}
