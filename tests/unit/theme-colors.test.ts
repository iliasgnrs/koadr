import { describe, expect, it } from 'vitest';
import { THEMES, getThemeMode, normaliseTheme } from '~/types/theme';

describe('theme model', () => {
  it('ships only a light and a dark mode', () => {
    expect(THEMES.map((theme) => theme.id)).toEqual(['light', 'dark']);
  });

  it('keeps supported ids untouched', () => {
    expect(normaliseTheme('dark')).toBe('dark');
    expect(normaliseTheme('light')).toBe('light');
  });

  it('migrates legacy palette ids onto their mode', () => {
    expect(normaliseTheme('dark-halloween-harvest')).toBe('dark');
    expect(normaliseTheme('dark-dracula')).toBe('dark');
    expect(normaliseTheme('light-solarized')).toBe('light');
  });

  it('falls back to light for missing or unrecognised values', () => {
    expect(normaliseTheme(null)).toBe('light');
    expect(normaliseTheme(undefined)).toBe('light');
    expect(normaliseTheme(42)).toBe('light');
  });

  it('reports the mode for any id', () => {
    expect(getThemeMode('dark')).toBe('dark');
    expect(getThemeMode('dark-gruvbox')).toBe('dark');
    expect(getThemeMode('light')).toBe('light');
  });
});
