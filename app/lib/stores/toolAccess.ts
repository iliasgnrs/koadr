import { create } from 'zustand';

export type ToolAccessMode = 'full-access' | 'ask-for-all';

type ToolAccessStore = {
  mode: ToolAccessMode;
  setMode: (mode: ToolAccessMode) => void;

  /** Apply the value the account reported. Does not write back. */
  hydrate: (mode: ToolAccessMode) => void;
};

/*
 * Tool permission mode is account state (`user_settings.tool_access`). It is not
 * persisted in the browser: until the account answers, the safer default applies,
 * and a shared machine never inherits the previous user's choice.
 */
export const useToolAccessStore = create<ToolAccessStore>((set) => ({
  mode: 'ask-for-all',
  setMode: (mode) => {
    set({ mode });

    void fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ toolAccess: mode }),
      credentials: 'same-origin',
    }).catch(() => undefined);
  },
  hydrate: (mode) => set({ mode }),
}));
