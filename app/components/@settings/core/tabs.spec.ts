import { describe, expect, it } from 'vitest';
import { DEFAULT_TAB_CONFIG, TAB_LABELS } from './constants';
import type { TabVisibilityConfig } from './types';
import { getVisibleTabs } from '~/components/@settings/utils/tab-helpers';
import { PLUGINS_ENABLED } from '~/lib/plugins/flags';

describe('settings tabs', () => {
  it('hides the plugins entry from DEFAULT_TAB_CONFIG when PLUGINS_ENABLED is false', () => {
    const pluginsTab = DEFAULT_TAB_CONFIG.find((tab) => tab.id === 'plugins');

    expect(pluginsTab).toBeDefined();
    expect(pluginsTab?.visible).toBe(PLUGINS_ENABLED);
  });

  it('does not surface an Extensions/Plugins tab when PLUGINS_ENABLED is false', () => {
    const visible = getVisibleTabs({ userTabs: DEFAULT_TAB_CONFIG as TabVisibilityConfig[] }, true);

    if (!PLUGINS_ENABLED) {
      expect(visible.map((tab) => tab.id)).not.toContain('plugins');
      expect(Object.values(TAB_LABELS)).not.toContain('Extensions');
    }
  });
});
