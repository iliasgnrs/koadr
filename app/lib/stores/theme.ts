import { atom } from 'nanostores';
import { logStore } from './logs';
import { queueSettingsSync } from '~/lib/settings-client';
import { getThemeMode, normaliseTheme, type Theme } from '~/types/theme';

export type { Theme } from '~/types/theme';

export const kTheme = 'bolt_theme';

export function themeIsDark() {
  return getThemeMode(themeStore.get()) === 'dark';
}

export const DEFAULT_THEME: Theme = 'dark';

export const themeStore = atom<Theme>(initStore());

function initStore() {
  if (!import.meta.env.SSR) {
    const storedTheme = localStorage.getItem(kTheme);

    if (storedTheme) {
      const theme = normaliseTheme(storedTheme);

      /*
       * Rewrite legacy palette ids in place so the upgrade happens once. This is
       * only the local key — the account copy is normalised when it is applied.
       */
      if (storedTheme !== theme) {
        localStorage.setItem(kTheme, theme);
      }

      return theme;
    }

    return normaliseTheme(document.querySelector('html')?.getAttribute('data-theme'));
  }

  return DEFAULT_THEME;
}

export function toggleTheme() {
  const targetMode = getThemeMode(themeStore.get()) === 'dark' ? 'light' : 'dark';

  setTheme(targetMode);
}

export function setTheme(newTheme: Theme) {
  // Update the theme store
  themeStore.set(newTheme);

  // Update localStorage
  localStorage.setItem(kTheme, newTheme);
  localStorage.setItem(`bolt_theme_${getThemeMode(newTheme)}`, newTheme);

  // Update the HTML attribute
  const root = document.querySelector('html');
  root?.setAttribute('data-theme', getThemeMode(newTheme));

  // Mirror the choice to the account when signed in (debounced, best-effort).
  queueSettingsSync();

  // Update user profile if it exists
  try {
    const userProfile = localStorage.getItem('bolt_user_profile');

    if (userProfile) {
      const profile = JSON.parse(userProfile);
      profile.theme = newTheme;
      localStorage.setItem('bolt_user_profile', JSON.stringify(profile));
    }
  } catch (error) {
    console.error('Error updating user profile theme:', error);
  }

  logStore.logSystem(`Theme changed to ${newTheme}`);
}
