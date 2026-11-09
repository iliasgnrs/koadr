import { describe, expect, it } from 'vitest';
import {
  DEFAULT_INTERFACE_OPTIONS,
  isKnownTheme,
  normaliseInterfaceOptions,
  resolveSettings,
  type InterfaceOptions,
} from './settings-sync';

const local = {
  theme: 'light' as const,
  interfaceOptions: { ...DEFAULT_INTERFACE_OPTIONS, compactMode: true } as InterfaceOptions,
};

describe('normaliseInterfaceOptions', () => {
  it('returns defaults for junk', () => {
    expect(normaliseInterfaceOptions(null)).toEqual(DEFAULT_INTERFACE_OPTIONS);
    expect(normaliseInterfaceOptions('nope')).toEqual(DEFAULT_INTERFACE_OPTIONS);
  });

  it('keeps valid values and fills only the gaps', () => {
    const result = normaliseInterfaceOptions({ accentIntensity: 80, cornerRadius: 'sharp' });

    expect(result.accentIntensity).toBe(80);
    expect(result.cornerRadius).toBe('sharp');

    // Untouched fields still get their defaults.
    expect(result.compactMode).toBe(false);
    expect(result.animatedTransitions).toBe(true);
  });

  it('rejects an unknown corner radius without discarding the rest', () => {
    const result = normaliseInterfaceOptions({ cornerRadius: 'roundish', compactMode: true });

    expect(result.cornerRadius).toBe('soft');
    expect(result.compactMode).toBe(true);
  });
});

describe('isKnownTheme', () => {
  it('accepts any stored theme string so legacy palettes can be migrated', () => {
    expect(isKnownTheme('dark')).toBe(true);
    expect(isKnownTheme('dark-halloween-harvest')).toBe(true);
    expect(isKnownTheme(null)).toBe(false);
    expect(isKnownTheme(42)).toBe(false);
  });
});

describe('resolveSettings', () => {
  it('pushes local settings when the server has no row', () => {
    expect(resolveSettings(local, null)).toEqual({ action: 'push-local' });
    expect(resolveSettings(local, { theme: null, interfaceOptions: null, updated_at: null })).toEqual({
      action: 'push-local',
    });
  });

  it('applies the server copy when it exists', () => {
    const result = resolveSettings(local, {
      theme: 'dark-ocean-depths',
      interfaceOptions: { ...DEFAULT_INTERFACE_OPTIONS, accentIntensity: 90, cornerRadius: 'round' },
      updated_at: '2026-11-06T00:00:00Z',
    });

    expect(result.action).toBe('apply-remote');

    if (result.action === 'apply-remote') {
      // Legacy palette ids are migrated to their mode on the way in.
      expect(result.settings.theme).toBe('dark');
      expect(result.settings.interfaceOptions.accentIntensity).toBe(90);
    }
  });

  it('migrates an unknown stored theme instead of blanking the UI', () => {
    const result = resolveSettings(local, {
      theme: 'dark-removed-theme',
      interfaceOptions: null,
      updated_at: '2026-11-06T00:00:00Z',
    });

    expect(result.action).toBe('apply-remote');

    if (result.action === 'apply-remote') {
      // Keeping the mode avoids flashing a light UI at a dark-theme user.
      expect(result.settings.theme).toBe('dark');
      expect(result.settings.interfaceOptions).toEqual(local.interfaceOptions);
    }
  });
});
