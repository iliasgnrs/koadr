import Cookies from 'js-cookie';
import { useEffect, useMemo, useState } from 'react';
import { Dialog, DialogDescription, DialogRoot, DialogTitle } from '~/components/ui/Dialog';
import { API_KEYS_UPDATED_EVENT, type ApiKeysUpdatedDetail } from '~/lib/api/apiKeys';
import type { MCPConfig } from '~/lib/services/mcpService';
import {
  applyInterfaceOptions,
  queueSettingsSync,
  saveKeyToAccount,
  syncSettingsFromServer,
} from '~/lib/settings-client';
import { useMCPStore } from '~/lib/stores/mcp';
import { DEFAULT_AVATARS, DEFAULT_AVATAR, saveProfileToAccount, updateProfile } from '~/lib/stores/profile';
import { setTheme, themeStore } from '~/lib/stores/theme';
import { THEMES, type Theme } from '~/types/theme';
import { PROVIDER_LIST } from '~/utils/constants';

const EMPTY_MCP_CONFIG = { mcpServers: {} };

export function FirstRunOnboarding() {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);
  const [name, setName] = useState('');
  const [avatar, setAvatar] = useState<string>(DEFAULT_AVATAR);
  const [providerName, setProviderName] = useState(PROVIDER_LIST[0]?.name ?? '');
  const [apiKey, setApiKey] = useState('');
  const [mcpText, setMcpText] = useState(JSON.stringify(EMPTY_MCP_CONFIG, null, 2));
  const [selectedTheme, setSelectedTheme] = useState<Theme>(() => themeStore.get());

  const [interfaceOptions, setInterfaceOptions] = useState(() => ({
    accentIntensity: 50,
    cornerRadius: 'soft' as 'sharp' | 'soft' | 'round',
    compactMode: false,
    animatedTransitions: true,
  }));

  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const initializeMcp = useMCPStore((store) => store.initialize);
  const updateMcpSettings = useMCPStore((store) => store.updateSettings);
  const mcpInitialized = useMCPStore((store) => store.isInitialized);
  const stepTitles = useMemo(() => ['Your profile', 'Connect an AI provider', 'MCP servers', 'Appearance'], []);

  useEffect(() => {
    let active = true;

    const checkFirstRun = async () => {
      /*
       * The account decides. If it cannot be read the flow stays closed rather
       * than guessing: a false "first run" would ask a returning user to redo
       * setup on a flaky connection.
       */
      try {
        const response = await fetch('/api/profile', { credentials: 'same-origin' });

        if (!response.ok) {
          if (active) {
            setOpen(false);
          }

          return;
        }

        const data = (await response.json()) as { profile?: { onboardingCompleted?: boolean } };

        if (!active) {
          return;
        }

        if (data.profile?.onboardingCompleted) {
          setOpen(false);

          return;
        }

        setOpen(true);

        // Prefill appearance with whatever the account already holds.
        const applied = await syncSettingsFromServer();

        if (active && applied?.interfaceOptions) {
          setInterfaceOptions(applied.interfaceOptions as typeof interfaceOptions);
        }
      } catch (err) {
        console.error('Could not check first-run setup state:', err);
      }
    };

    void checkFirstRun();

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (open && !mcpInitialized) {
      void initializeMcp();
    }
  }, [open, mcpInitialized, initializeMcp]);

  const finish = () => {
    // Recorded on the account, so no browser-level flag exists to lose.
    setOpen(false);

    void fetch('/api/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ onboardingCompleted: true }),
      credentials: 'same-origin',
    }).catch(() => undefined);
  };

  const saveApiKey = () => {
    const current = Cookies.get('apiKeys');

    let keys: Record<string, string> = {};

    try {
      keys = current ? (JSON.parse(current) as Record<string, string>) : {};
    } catch {
      keys = {};
    }

    if (providerName && apiKey.trim()) {
      const apiKeys = { ...keys, [providerName]: apiKey.trim() };
      Cookies.set('apiKeys', JSON.stringify(apiKeys), { expires: 365 });
      void saveKeyToAccount(providerName, apiKey.trim());
      window.dispatchEvent(
        new CustomEvent<ApiKeysUpdatedDetail>(API_KEYS_UPDATED_EVENT, { detail: { apiKeys, providerName } }),
      );
    }
  };

  const next = async () => {
    setError('');

    if (step === 0 && name.trim()) {
      updateProfile({ username: name.trim(), avatar });
      void saveProfileToAccount({ username: name.trim(), avatar });
    } else if (step === 0) {
      updateProfile({ avatar });
      void saveProfileToAccount({ avatar });
    }

    if (step === 1) {
      saveApiKey();
    }

    if (step === 2) {
      try {
        const config = JSON.parse(mcpText) as MCPConfig;

        if (!config || typeof config.mcpServers !== 'object' || config.mcpServers === null) {
          throw new Error('Configuration must include an mcpServers object.');
        }

        setSaving(true);

        const currentSettings = useMCPStore.getState().settings;
        await updateMcpSettings({ ...currentSettings, mcpConfig: config });
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not save MCP configuration.');
        setSaving(false);

        return;
      }
      setSaving(false);
    }

    if (step === 3) {
      setTheme(selectedTheme);
      applyInterfaceOptions(interfaceOptions);
      queueSettingsSync();
    }

    if (step >= 3) {
      finish();
    } else {
      setStep((current) => current + 1);
    }
  };

  if (!open) {
    return null;
  }

  return (
    <DialogRoot
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) {
          setOpen(true);
        }
      }}
    >
      <Dialog
        backdropClassName="!bg-[#09080f]/80 !backdrop-blur-md bg-[radial-gradient(ellipse_at_top,_rgba(91,33,182,0.18),_transparent_55%)]"
        className="w-[min(560px,calc(100vw-2rem))] max-h-[90vh] overflow-y-auto !rounded-xl !border-[#302e39] !bg-[#1b1a22] p-6 !text-[#f4f1fa]"
        showCloseButton={false}
      >
        <div className="mb-5">
          <div className="mb-2 text-xs font-medium text-[#a09baa]">
            Step {step + 1} of {stepTitles.length}
          </div>
          <div className="mb-3 flex gap-1" aria-hidden="true">
            {stepTitles.map((title, index) => (
              <span
                key={title}
                className={`h-1 flex-1 rounded-full ${index <= step ? 'bg-[#FF6600]' : 'bg-[#393641]'}`}
              />
            ))}
          </div>
          <DialogTitle className="text-xl font-semibold">Welcome to Koadr</DialogTitle>
          <DialogDescription className="mt-1 text-sm !text-[#a09baa]">
            Let’s get your workspace ready. Optional details can be left blank and changed later in Settings.
          </DialogDescription>
        </div>

        {step === 0 && (
          <div className="space-y-3">
            <label className="block text-sm font-medium" htmlFor="onboarding-name">
              What should we call you?
            </label>
            <input
              id="onboarding-name"
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Your name"
              className="w-full rounded-md border border-[#302e39] bg-[#121116] px-3 py-2 text-sm text-[#f4f1fa] outline-none focus:border-[#FF6600]"
            />
            <div>
              <span className="mb-2 block text-sm font-medium">Choose an avatar</span>
              <div className="flex flex-wrap items-center gap-3">
                {DEFAULT_AVATARS.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    aria-label={`Use ${preset.name} avatar`}
                    aria-pressed={avatar === preset.src}
                    onClick={() => setAvatar(preset.src)}
                    className={`h-14 w-14 overflow-hidden rounded-full border-2 ${avatar === preset.src ? 'border-[#FF6600] ring-2 ring-[#FF6600]/40' : 'border-[#393641]'}`}
                  >
                    <img src={preset.src} alt="" className="h-full w-full object-cover" />
                  </button>
                ))}
                <label className="flex h-14 cursor-pointer items-center rounded-md border border-dashed border-[#393641] px-3 text-xs text-[#a09baa] hover:bg-[#25232d]">
                  <input
                    type="file"
                    accept="image/*"
                    className="sr-only"
                    onChange={(event) => {
                      const file = event.target.files?.[0];

                      if (!file) {
                        return;
                      }

                      if (!file.type.startsWith('image/')) {
                        setError('Choose an image file.');
                        return;
                      }

                      if (file.size > 2 * 1024 * 1024) {
                        setError('Choose an image smaller than 2 MB.');
                        return;
                      }

                      const reader = new FileReader();

                      reader.onload = () => {
                        if (typeof reader.result === 'string') {
                          setAvatar(reader.result);
                          setError('');
                        } else {
                          setError('Could not read that image.');
                        }
                      };
                      reader.onerror = () => setError('Could not read that image.');
                      reader.readAsDataURL(file);
                      event.target.value = '';
                    }}
                  />
                  Upload image
                </label>
                {avatar.startsWith('data:image/') && (
                  <img
                    src={avatar}
                    alt="Uploaded avatar preview"
                    className="h-14 w-14 rounded-full border border-[#393641] object-cover"
                  />
                )}
              </div>
              {error && (
                <p role="alert" className="mt-2 text-xs text-red-500">
                  {error}
                </p>
              )}
            </div>
          </div>
        )}

        {step === 1 && (
          <div className="space-y-3">
            <p className="text-sm text-[#a09baa]">
              Choose a provider and add its API key to start building. You can also skip this and use a locally
              configured provider.
            </p>
            <label className="block text-sm font-medium" htmlFor="onboarding-provider">
              AI provider
            </label>
            <select
              id="onboarding-provider"
              value={providerName}
              onChange={(event) => setProviderName(event.target.value)}
              className="w-full rounded-md border border-[#302e39] bg-[#121116] px-3 py-2 text-sm text-[#f4f1fa]"
            >
              {PROVIDER_LIST.map((provider) => (
                <option key={provider.name} value={provider.name}>
                  {provider.name}
                </option>
              ))}
            </select>
            <label className="block text-sm font-medium" htmlFor="onboarding-api-key">
              API key
            </label>
            <input
              id="onboarding-api-key"
              type="password"
              autoComplete="new-password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder="Paste your API key"
              className="w-full rounded-md border border-[#302e39] bg-[#121116] px-3 py-2 text-sm text-[#f4f1fa] outline-none focus:border-[#FF6600]"
            />
          </div>
        )}

        {step === 2 && (
          <div className="space-y-3">
            <p className="text-sm text-[#a09baa]">
              Add MCP server configuration as JSON. You can leave this empty and set it up later in Settings.
            </p>
            <label className="block text-sm font-medium" htmlFor="onboarding-mcp">
              MCP configuration
            </label>
            <textarea
              id="onboarding-mcp"
              spellCheck={false}
              value={mcpText}
              onChange={(event) => setMcpText(event.target.value)}
              rows={9}
              className="w-full resize-y rounded-md border border-[#302e39] bg-[#121116] px-3 py-2 font-mono text-xs text-[#f4f1fa] outline-none focus:border-[#FF6600]"
            />
            {error && (
              <p role="alert" className="text-sm text-red-500">
                {error}
              </p>
            )}
          </div>
        )}

        {step === 3 && (
          <div className="space-y-4">
            <div>
              <label className="mb-1 block text-sm font-medium" htmlFor="onboarding-theme">
                Color theme
              </label>
              <select
                id="onboarding-theme"
                value={selectedTheme}
                onChange={(event) => setSelectedTheme(event.target.value as Theme)}
                className="w-full rounded-md border border-[#302e39] bg-[#121116] px-3 py-2 text-sm text-[#f4f1fa]"
              >
                {THEMES.map((theme) => (
                  <option key={theme.id} value={theme.id}>
                    {theme.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="rounded-md bg-[#22212a] p-3">
              <label className="flex items-center justify-between gap-3 text-sm">
                <span>
                  Accent intensity <span className="text-[#a09baa]">({interfaceOptions.accentIntensity}%)</span>
                </span>
                <input
                  aria-label="Accent intensity"
                  type="range"
                  min="0"
                  max="100"
                  value={interfaceOptions.accentIntensity}
                  onChange={(event) =>
                    setInterfaceOptions({ ...interfaceOptions, accentIntensity: Number(event.target.value) })
                  }
                  className="w-1/2 accent-[#FF6600]"
                />
              </label>
            </div>

            <div className="flex items-center justify-between gap-3 rounded-md bg-[#22212a] p-3">
              <span className="text-sm">Corner radius</span>
              <div className="flex gap-1" role="group" aria-label="Corner radius">
                {(['sharp', 'soft', 'round'] as const).map((radius) => (
                  <button
                    key={radius}
                    type="button"
                    aria-pressed={interfaceOptions.cornerRadius === radius}
                    onClick={() => setInterfaceOptions({ ...interfaceOptions, cornerRadius: radius })}
                    className={`appearance-none rounded-md px-2 py-1 text-xs capitalize ${interfaceOptions.cornerRadius === radius ? 'bg-[#FF6600] text-[#1A1A1A]' : 'bg-[#302e39] text-[#b8b3c2]'}`}
                  >
                    {radius}
                  </button>
                ))}
              </div>
            </div>

            {(
              [
                ['compactMode', 'Compact mode', 'Tighter spacing in lists'],
                ['animatedTransitions', 'Animated transitions', 'Smooth theme switching'],
              ] as const
            ).map(([key, label, description]) => (
              <label
                key={key}
                className="flex cursor-pointer items-center justify-between gap-3 rounded-md bg-[#22212a] p-3"
              >
                <span>
                  <span className="block text-sm">{label}</span>
                  <span className="text-xs text-[#a09baa]">{description}</span>
                </span>
                <input
                  type="checkbox"
                  checked={interfaceOptions[key]}
                  onChange={(event) => setInterfaceOptions({ ...interfaceOptions, [key]: event.target.checked })}
                  className="h-4 w-4 accent-[#FF6600]"
                />
              </label>
            ))}
          </div>
        )}

        <div className="mt-6 flex items-center justify-end gap-3">
          <div className="flex gap-2">
            {step > 0 && (
              <button
                type="button"
                onClick={() => setStep((current) => current - 1)}
                className="appearance-none rounded-md border border-[#393641] bg-[#302e39] px-4 py-2 text-sm text-[#eeeaf5] hover:bg-[#3b3846] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FF6600]"
              >
                Back
              </button>
            )}
            <button
              type="button"
              disabled={saving}
              onClick={() => void next()}
              className="rounded-md bg-[#FF6600] px-4 py-2 text-sm font-semibold text-[#1A1A1A] hover:bg-[#E65C00] disabled:opacity-60"
            >
              {saving ? 'Saving…' : step === 3 ? 'Finish setup' : 'Continue'}
            </button>
          </div>
        </div>
      </Dialog>
    </DialogRoot>
  );
}
