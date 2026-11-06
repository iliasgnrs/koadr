import type { Theme } from '~/types/theme';
import { THEMES } from '~/types/theme';

export interface InterfaceOptions {
  accentIntensity: number;
  cornerRadius: 'sharp' | 'soft' | 'round';
  compactMode: boolean;
  animatedTransitions: boolean;
}

export interface RemoteSettings {
  /**
   * Kept as `string` because it comes from the database, which may hold a theme
   *  this build no longer ships. `isKnownTheme` decides whether to trust it.
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
 * Normalise whatever is in localStorage (or the database) into a complete
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

export function isKnownTheme(value: unknown): value is Theme {
  return typeof value === 'string' && THEMES.some((theme) => theme.id === value);
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
  local: { theme: Theme; interfaceOptions: InterfaceOptions },
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
      theme: isKnownTheme(remote.theme) ? remote.theme : local.theme,
      interfaceOptions: remote.interfaceOptions
        ? normaliseInterfaceOptions(remote.interfaceOptions)
        : local.interfaceOptions,
    },
  };
}
