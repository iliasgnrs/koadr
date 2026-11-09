/**
 * Koadr ships one brand design with a light and a dark mode — there is no
 * palette picker any more.
 *
 * The id doubles as the `data-theme` attribute value, so it must stay exactly
 * 'light' or 'dark'.
 */
export const THEMES = [
  { id: 'light', name: 'Light', mode: 'light' },
  { id: 'dark', name: 'Dark', mode: 'dark' },
] as const;

export type Theme = (typeof THEMES)[number]['id'];
export type ThemeMode = 'light' | 'dark';

/**
 * Legacy palette ids keep their `dark-` prefix, so a prefix test reads their mode
 * correctly without needing the full list.
 */
export function getThemeMode(theme: string): ThemeMode {
  return theme.startsWith('dark') ? 'dark' : 'light';
}

/**
 * Coerce anything persisted — including palette ids this build no longer ships,
 * such as 'dark-dracula' or 'light-solarized' — onto a supported theme.
 *
 * Unknown values keep their light/dark mode rather than falling back to light,
 * so a user on a dark palette is not flashed a white screen by the upgrade.
 */
export function normaliseTheme(value: unknown): Theme {
  if (value === 'dark' || value === 'light') {
    return value;
  }

  return typeof value === 'string' && value.startsWith('dark') ? 'dark' : 'light';
}
