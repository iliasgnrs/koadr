import { normaliseTheme, type Theme } from '~/types/theme';

export interface InterfaceOptions {
  accentIntensity: number;
  cornerRadius: 'sharp' | 'soft' | 'round';
  compactMode: boolean;
  animatedTransitions: boolean;
}

export interface LocalSettings {
  theme: Theme;
  interfaceOptions: InterfaceOptions;

  /** False when this browser has never stored a theme — i.e. a fresh visitor. */
  hasStoredTheme?: boolean;
}

export interface RemoteSettings {
  /**
   * Kept as `string` because it comes from the database, which may still hold a
   * palette id from before the picker was removed. `normaliseTheme` maps it.
   */
  theme: string | null;
  interfaceOptions: InterfaceOptions | null;
  updated_at: string | null;
}

export const DEFAULT_INTERFACE_OPTIONS: InterfaceOptions = {
  accentIntensity: 50,
  cornerRadius: 'soft',
  compactMode: false,
  animatedTransitions: true,
};

const CORNER_RADII = ['sharp', 'soft', 'round'] as const;

/**
 * Normalise whatever the database or a migration payload holds into a complete
 * InterfaceOptions. Missing or malformed fields fall back per-field rather than
 * discarding the whole object, so one bad value cannot wipe a user's layout.
 */
export function normaliseInterfaceOptions(saved: unknown): InterfaceOptions {
  const raw = (saved && typeof saved === 'object' ? saved : {}) as Record<string, unknown>;

  return {
    accentIntensity: typeof raw.accentIntensity === 'number' ? raw.accentIntensity : 50,
    cornerRadius: CORNER_RADII.includes(raw.cornerRadius as (typeof CORNER_RADII)[number])
      ? (raw.cornerRadius as InterfaceOptions['cornerRadius'])
      : 'soft',
    compactMode: Boolean(raw.compactMode),
    animatedTransitions: raw.animatedTransitions !== false,
  };
}

/**
 * The two modes the app renders.
 */
export function isKnownTheme(value: unknown): value is string {
  return value === 'light' || value === 'dark';
}

/**
 * Widest accepted theme on read: anything non-empty is migrated onto a mode by
 * `normaliseTheme`, so an account carrying a legacy palette id keeps its mode
 * instead of silently reverting to the default.
 */
export function isStoredTheme(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Decide what to do when a device loads with both a local copy and a server copy.
 *
 * Last-write-wins on a single row: the server copy is authoritative whenever it
 * carries a timestamp, because it is the one row shared by every device. The
 * local copy is only pushed up when the server has nothing yet — that is the
 * first sign-in on an existing browser, and it preserves the choices the user
 * made while signed out.
 */
export function resolveSettings(
  local: LocalSettings,
  remote: RemoteSettings | null,
):
  | { action: 'apply-remote'; settings: { theme: Theme; interfaceOptions: InterfaceOptions } }
  | { action: 'push-local' } {
  if (!remote?.updated_at) {
    return { action: 'push-local' };
  }

  return {
    action: 'apply-remote',
    settings: {
      theme: isStoredTheme(remote.theme) ? normaliseTheme(remote.theme) : local.theme,
      interfaceOptions: remote.interfaceOptions
        ? normaliseInterfaceOptions(remote.interfaceOptions)
        : local.interfaceOptions,
    },
  };
}

/** Returned by `normaliseProviderSettings` for a value that must be rejected. */
export const INVALID_PROVIDER_SETTINGS = Symbol('invalid-provider-settings');

/*
 * What an account stores per provider. It is deliberately a whitelist: the
 * local entry also holds model lists fetched at runtime, and syncing those
 * would overwrite a fresh list with a stale one on every device.
 */
const PROVIDER_SETTING_FIELDS = [
  'enabled',
  'baseUrl',
  'selectedModel',
  'model',
  'contextWindow',
  'maxTokenAllowed',
] as const;

const PROVIDER_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const MAX_PROVIDERS = 100;

/**
 * Sanitize provider settings coming from a client or from the database.
 *
 * Returns `undefined` when nothing was sent (upsert leaves the column alone),
 * `INVALID_PROVIDER_SETTINGS` when the payload is not a provider map, and
 * otherwise the field-whitelisted copy.
 *
 * Provider API keys are intentionally not accepted here: they live encrypted in
 * `api_keys`, and a plaintext key in this column would defeat that.
 */
export function normaliseProviderSettings(
  value: unknown,
): Record<string, unknown> | undefined | typeof INVALID_PROVIDER_SETTINGS {
  if (value === undefined) {
    return undefined;
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return INVALID_PROVIDER_SETTINGS;
  }

  const entries = Object.entries(value as Record<string, unknown>).slice(0, MAX_PROVIDERS);

  if (entries.some(([name]) => !PROVIDER_NAME_PATTERN.test(name))) {
    return INVALID_PROVIDER_SETTINGS;
  }

  const result: Record<string, unknown> = {};

  for (const [name, entry] of entries) {
    const settings = (entry as { settings?: unknown } | null)?.settings;

    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      continue;
    }

    const raw = settings as Record<string, unknown>;
    const kept: Record<string, unknown> = {};

    for (const field of PROVIDER_SETTING_FIELDS) {
      const fieldValue = raw[field];

      if (fieldValue === undefined) {
        continue;
      }

      if (typeof fieldValue === 'string') {
        kept[field] = fieldValue.slice(0, 2048);
      } else if (typeof fieldValue === 'boolean' || typeof fieldValue === 'number') {
        kept[field] = fieldValue;
      }
    }

    if (Object.keys(kept).length > 0) {
      result[name] = { settings: kept };
    }
  }

  return result;
}

/**
 * Fold the account's provider map onto the local store.
 *
 * A written map is authoritative: anything it does not list is disabled, so a
 * user who enabled only one provider does not keep the four defaults on the next
 * load. An empty map means "never saved", and leaves the defaults untouched.
 */
export function applyProviderSettings<T extends { settings: object }>(
  current: Record<string, T>,
  saved: Record<string, { settings?: object }>,
): Record<string, T> {
  const hasSavedChoice = Object.keys(saved).length > 0;

  return Object.fromEntries(
    Object.entries(current).map(([name, provider]) => {
      const entry = saved[name];

      return [
        name,
        {
          ...provider,
          settings: {
            ...provider.settings,
            ...entry?.settings,
            ...(hasSavedChoice && !entry ? { enabled: false } : {}),
          },
        },
      ];
    }),
  ) as Record<string, T>;
}
