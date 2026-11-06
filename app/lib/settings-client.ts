import { DEFAULT_INTERFACE_OPTIONS, normaliseInterfaceOptions, resolveSettings } from './settings-sync';

/*
 * Client half of settings sync.
 *
 * localServerStorage stays the source of truth for rendering — the app must work
 * before any network call settles — and the server is reconciled once per page
 * load. Writes are debounced because the settings tab fires on every slider
 * drag, and a request per drag event would be both wasteful and racy.
 */

const LOCAL_OPTIONS_KEY = 'bolt_interface_options';
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

function readLocal() {
  let theme: string | null = null;
  let options: unknown = null;

  try {
    theme = localStorage.getItem('bolt_theme');
    options = JSON.parse(localStorage.getItem(LOCAL_OPTIONS_KEY) || '{}');
  } catch {
    // Unreadable storage is treated as "nothing saved".
  }

  return { theme, interfaceOptions: normaliseInterfaceOptions(options) };
}

/** Push the current theme and options to the server, coalescing bursts. */
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
  const { theme, interfaceOptions } = readLocal();

  if (!theme) {
    return;
  }

  try {
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme, interfaceOptions }),
      credentials: 'same-origin',
    });
  } catch {
    /*
     * Offline or signed out. The local copy is already up to date, and the next
     * successful sync will reconcile, so a failed push is not worth surfacing.
     */
  }
}

/**
 * Reconcile this device with the account. Called once after the first paint of an
 * authenticated session.
 *
 * Returns the settings that were applied, or null when nothing changed.
 */
export async function syncSettingsFromServer(): Promise<{ theme: string } | null> {
  let remote = null;

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

  const local = readLocal();

  /*
   * A brand-new account has no saved theme here at all. In that case the account
   * is authoritative and the app should land on the default rather than keep
   * whatever a previous visitor left in this browser.
   */
  if (!local.theme) {
    const { DEFAULT_THEME } = await import('~/lib/stores/theme');

    return { theme: DEFAULT_THEME };
  }

  const decision = resolveSettings(
    { theme: local.theme as never, interfaceOptions: local.interfaceOptions, hasStoredTheme: true },
    remote,
  );

  if (decision.action === 'push-local') {
    queueSettingsSync();

    return null;
  }

  const { theme, interfaceOptions } = decision.settings;

  /*
   * Write straight to storage and let the existing stores pick it up, rather
   * than calling setTheme() — that would immediately queue another push and
   * ping-pong the value between devices.
   */

  try {
    localStorage.setItem('bolt_theme', theme);
    localStorage.setItem(LOCAL_OPTIONS_KEY, JSON.stringify(interfaceOptions));
  } catch {
    return null;
  }

  applyInterfaceOptions(interfaceOptions);

  return { theme };
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

export { DEFAULT_INTERFACE_OPTIONS };

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
