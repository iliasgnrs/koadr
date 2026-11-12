import { describe, expect, it } from 'vitest';
import { normaliseEditor, normaliseMcpServers, normaliseToolAccess } from './account-state';

describe('normaliseEditor', () => {
  it('rejects non-objects', () => {
    expect(normaliseEditor(null)).toBeNull();
    expect(normaliseEditor([])).toBeNull();
  });

  it('keeps known flags and drops unknown keys', () => {
    // A non-boolean flag is dropped rather than coerced; unknown keys never land.
    expect(normaliseEditor({ latestBranch: true, eventLogs: 'yes', promptId: 'default', something: 1 })).toEqual({
      latestBranch: true,
      promptId: 'default',
    });
  });

  it('keeps a tab configuration only when it carries userTabs', () => {
    expect(normaliseEditor({ tabConfiguration: { userTabs: [{ id: 'profile' }] } })).toEqual({
      tabConfiguration: { userTabs: [{ id: 'profile' }] },
    });

    expect(normaliseEditor({ tabConfiguration: { junk: true } })).toEqual({});
  });
});

describe('normaliseMcpServers', () => {
  it('rejects non-arrays', () => {
    expect(normaliseMcpServers({})).toBeNull();
  });

  it('keeps reachable server fields only', () => {
    expect(
      normaliseMcpServers([{ name: 'greptile', config: { type: 'sse', url: 'https://mcp.test/sse', extra: 'x' } }]),
    ).toEqual([{ name: 'greptile', enabled: true, config: { type: 'sse', url: 'https://mcp.test/sse' } }]);
  });

  it('drops entries without a name or config', () => {
    expect(
      normaliseMcpServers([{ config: { url: 'x' } }, { name: 'ok', config: { url: 'https://a.b' } }]),
    ).toHaveLength(1);
  });
});

describe('normaliseToolAccess', () => {
  it('accepts only the two modes', () => {
    expect(normaliseToolAccess('full-access')).toBe('full-access');
    expect(normaliseToolAccess('ask-for-all')).toBe('ask-for-all');
    expect(normaliseToolAccess('admin')).toBeNull();
  });
});
