import { beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * Regression guard for losing provider choices.
 *
 * A device that reloaded used to auto-enable the environment-configured local
 * providers before the account was read, and that default was then written back
 * over the user's saved selection. A first choice on a fresh account was also
 * never saved, because the push was skipped until a map existed.
 */

const fetchMock = vi.fn();

vi.stubGlobal('fetch', fetchMock);

const { initializeProviders, markProviderSettingsStored, providersStore, updateProviderSettings, updateSelectedModel } =
  await import('./settings');

/**
 * Writes reach /api/settings after the sync debounce, so the timer is advanced
 * here and the number of pushes counted.
 */
async function debouncedWrites() {
  await vi.advanceTimersByTimeAsync(1000);

  return fetchMock.mock.calls.filter(([url]) => url === '/api/settings').length;
}

/** Serve /api/configured-providers with Ollama configured from the environment. */
function providerIsConfiguredByEnv() {
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({ providers: [{ name: 'Ollama', isConfigured: true, configMethod: 'environment' }] }),
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockReset();
  providersStore.set({
    Ollama: { name: 'Ollama', settings: { enabled: false } },
    Deepseek: { name: 'Deepseek', settings: { enabled: false } },
  } as never);
});

describe('provider settings persistence', () => {
  it('pushes the first toggle of an account that has no saved map', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });

    updateProviderSettings('Deepseek', { enabled: true } as never);

    expect(providersStore.get().Deepseek.settings.enabled).toBe(true);
    await expect(debouncedWrites()).resolves.toBe(1);
  });

  it('never auto-enables a provider once the account has a saved choice', async () => {
    markProviderSettingsStored(true);
    providerIsConfiguredByEnv();

    await initializeProviders();

    expect(providersStore.get().Ollama.settings.enabled).toBe(false);
    await expect(debouncedWrites()).resolves.toBe(0);
  });

  it('auto-enables environment-configured providers on a fresh account only', async () => {
    markProviderSettingsStored(false);
    providerIsConfiguredByEnv();

    await initializeProviders();

    expect(providersStore.get().Ollama.settings.enabled).toBe(true);
    await expect(debouncedWrites()).resolves.toBe(1);
  });

  it('records the picked model on the provider so it syncs to other devices', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });

    updateSelectedModel('Deepseek', 'deepseek-v4-flash');

    expect(providersStore.get().Deepseek.settings.selectedModel).toBe('deepseek-v4-flash');
    await expect(debouncedWrites()).resolves.toBe(1);
  });
});
