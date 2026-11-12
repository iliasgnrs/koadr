import { atom } from 'nanostores';
import { logStore } from './logs';
import { queueSettingsSync } from '~/lib/settings-client';
import { getThemeMode, type Theme } from '~/types/theme';

export type { Theme } from '~/types/theme';

export const kTheme = 'bolt_theme';

export function themeIsDark() {
  return getThemeMode(themeStore.get()) === 'dark';
}

export const DEFAULT_THEME: Theme = 'dark';

export const themeStore = atom<Theme>(initStore());

/*
 * The account is the only copy of the theme. Until `syncSettingsFromServer`
 * applies it, the store holds the default (and the pre-hydration script has
 * already painted the account's mode onto <html>).
 */
function initStore() {
  return DEFAULT_THEME;
}

export function toggleTheme() {
  const targetMode = getThemeMode(themeStore.get()) === 'dark' ? 'light' : 'dark';

  setTheme(targetMode);
}

export function setTheme(newTheme: Theme) {
  // Update the theme store
  themeStore.set(newTheme);

  // Update the HTML attribute
  const root = document.querySelector('html');
  root?.setAttribute('data-theme', getThemeMode(newTheme));

  // Mirror the choice to the account when signed in (debounced, best-effort).
  queueSettingsSync();

  logStore.logSystem(`Theme changed to ${newTheme}`);
}
