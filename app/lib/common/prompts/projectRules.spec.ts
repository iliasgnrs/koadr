import { describe, expect, it } from 'vitest';
import { PROJECT_RULES, withProjectRules } from './projectRules';

describe('withProjectRules', () => {
  it('inlines the shipped rulebook into the system prompt', () => {
    const prompt = withProjectRules('You are Koadr.');

    expect(prompt).toContain('You are Koadr.');
    expect(prompt).toContain('<project_rules>');
    expect(prompt).toContain('Global Engineering & Output Constraints');
    expect(prompt.trimEnd().endsWith('</project_rules>')).toBe(true);
  });

  it('does not duplicate the block when the prompt already carries it', () => {
    const once = withProjectRules('You are Koadr.');
    const twice = withProjectRules(once);

    expect(twice).toBe(once);
  });

  it('leaves the prompt untouched when no rules are supplied', () => {
    expect(withProjectRules('You are Koadr.', '   ')).toBe('You are Koadr.');
  });

  it('ships a rulebook that mirrors the attached file', () => {
    /*
     * The server cannot read `.github/`, so `project-rules.md` is a copy kept in
     * step by `pnpm rules:sync`. A stale copy would silently change model behaviour.
     */
    expect(PROJECT_RULES).toContain('Zero Conversational Filler');
    expect(PROJECT_RULES.startsWith('#')).toBe(true);
  });
});
