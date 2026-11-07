import { describe, expect, it } from 'vitest';
import { getToolDisplayError, getToolDisplayState, toChatFailureHeadline } from './toolActivity';

describe('tool activity status', () => {
  it('shows application errors as failures even when the SDK says output-available', () => {
    const part = {
      type: 'tool-project_run_command',
      state: 'output-available',
      output: { isError: true, error: 'ENOENT' },
    };
    expect(getToolDisplayState(part)).toBe('output-error');
    expect(getToolDisplayError(part)).toBe('ENOENT');
  });

  it('distinguishes a started server from a completed command', () => {
    const part = { type: 'tool-project_run_command', state: 'output-available', output: { status: 'running' } };
    expect(getToolDisplayState(part)).toBe('process-running');
    expect(getToolDisplayState({ ...part, output: { status: 'exited', exitCode: 0 } })).toBe('output-available');
  });

  it('also recognizes failed exits in saved results without an isError field', () => {
    const part = {
      type: 'tool-project_get_process_output',
      state: 'output-available',
      output: { status: 'exited', exitCode: 1 },
    };
    expect(getToolDisplayState(part)).toBe('output-error');
    expect(getToolDisplayError(part)).toBe('Command exited with code 1.');
  });

  it('shows a blocked task as unresolved with its concrete reason', () => {
    const part = {
      type: 'tool-agent_complete',
      state: 'output-available',
      output: { completed: false, blocked: true, reason: 'Registry unavailable.' },
    };
    expect(getToolDisplayState(part)).toBe('output-error');
    expect(getToolDisplayError(part)).toBe('Registry unavailable.');
  });
});

describe('failure presentation', () => {
  const patchConflict = {
    type: 'tool-project_patch_file',
    state: 'output-available',
    output: {
      isError: true,
      error: [
        'Patch conflict: the file changed since you read it.',
        'Current revision: 142ac49d66365b797a9ddb0665f9c5445569debcc423d2d1dd7d76c4f782956f',
        'currentContent (use this instead of re-reading):',
        '<<<FILE',
        "import type { IconName } from '../components/Icon';",
        'FILE>>>',
      ].join('\n'),
    },
  };

  it('shows a short headline for a patch conflict instead of the revision and file', () => {
    const message = getToolDisplayError(patchConflict);

    expect(message).toBe('Found a bug: the file changed since the last read. Fixing…');
    expect(message).not.toContain('142ac49d');
    expect(message).not.toContain('<<<FILE');
  });

  it('shows a headline when the model patched before reading', () => {
    const part = {
      type: 'tool-project_patch_file',
      state: 'output-available',
      output: { isError: true, error: 'Read the file first, then supply its revision as expectedRevision.' },
    };

    expect(getToolDisplayError(part)).toBe('Found a bug: the file was never read. Reading it, then fixing…');
  });

  it('keeps a short, unrelated error readable', () => {
    const part = {
      type: 'tool-project_run_command',
      state: 'output-available',
      output: { isError: true, error: 'ENOENT: no such file or directory' },
    };

    expect(getToolDisplayError(part)).toBe('ENOENT: no such file or directory');
  });

  it('truncates a long multi-line error to its first line', () => {
    const part = {
      type: 'tool-project_run_command',
      state: 'output-available',
      output: { isError: true, error: `${'x'.repeat(400)}\nsecond line` },
    };

    const message = getToolDisplayError(part) ?? '';

    expect(message.endsWith('…')).toBe(true);
    expect(message.length).toBeLessThanOrEqual(140);
    expect(message).not.toContain('second line');
  });

  it('does not claim a bug for a long-timeout provider error', () => {
    const part = {
      type: 'tool-project_run_command',
      state: 'output-available',
      output: { isError: true, error: 'Custom error: The AI provider request failed. Check your provider settings.' },
    };

    expect(getToolDisplayError(part)).toBe('Found a bug in the provider request. Fixing…');
  });
});

describe('toChatFailureHeadline', () => {
  it('replaces the "Custom error" prefix on the alert title', () => {
    expect(
      toChatFailureHeadline('Request Failed', 'Custom error: The AI provider request failed. Check your settings.'),
    ).toBe('Found a bug: The AI provider request failed. Check your settings.');
  });

  it('keeps the existing title for errors that are not provider failures', () => {
    expect(toChatFailureHeadline('Rate Limit Exceeded', 'Too many requests')).toBe('Rate Limit Exceeded');
  });
});
