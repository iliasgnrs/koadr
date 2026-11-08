import { describe, expect, it } from 'vitest';
import { DEFAULT_THEME } from '~/lib/stores/theme';
import { getColorTheme, getThemeMode } from '~/types/theme';

describe('getColorTheme', () => {
  it('keeps the palette id so each theme paints its own colours', () => {
    expect(getColorTheme('dark-halloween-harvest')).toBe('dark-halloween-harvest');
    expect(getColorTheme('dark-dracula')).toBe('dark-dracula');
    expect(getColorTheme('light')).toBe('light');
  });

  it('maps the legacy bare dark id onto a real palette', () => {
    expect(getColorTheme('dark')).toBe('dark-dracula');
  });

  it('never repaints the default (orange) theme as dracula purple', () => {
    expect(getColorTheme(DEFAULT_THEME)).toBe(DEFAULT_THEME);
    expect(getThemeMode(DEFAULT_THEME)).toBe('dark');
  });
});
