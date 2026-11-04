import { describe, expect, it } from 'vitest';
import DeepseekProvider from './deepseek';

const provider = new DeepseekProvider();

describe('DeepseekProvider.supportsToolChoice', () => {
  it.each(['deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-v4-flash-1017', 'deepseek-flash'])(
    'rejects forced tool_choice for thinking-mode model %s',
    (model) => {
      expect(provider.supportsToolChoice(model)).toBe(false);
    },
  );

  it.each(['deepseek-chat', 'deepseek-reasoner', 'deepseek-coder', 'deepseek-v3.2'])(
    'allows forced tool_choice for legacy model %s',
    (model) => {
      expect(provider.supportsToolChoice(model)).toBe(true);
    },
  );
});

describe('DeepseekProvider token hint', () => {
  it('caps the published 384k output ceiling to a practical default', () => {
    expect(provider.getCompletionTokenLimitHint()).toBe(32_000);
  });
});
