import { getToolName, getToolOutput, getToolState } from '~/lib/persistence/messageMigration';
import { TOOL_EXECUTION_DENIED, TOOL_EXECUTION_ERROR, TOOL_NO_EXECUTE_FUNCTION } from '~/utils/constants';

export function getToolDisplayState(part: unknown) {
  const state = getToolState(part);
  const rawOutput = getToolOutput(part);
  const output = rawOutput && typeof rawOutput === 'object' ? (rawOutput as Record<string, unknown>) : {};

  if (
    state === 'output-error' ||
    state === 'output-denied' ||
    output.isError === true ||
    output.blocked === true ||
    [TOOL_EXECUTION_DENIED, TOOL_EXECUTION_ERROR, TOOL_NO_EXECUTE_FUNCTION].includes(rawOutput as any) ||
    (output.status === 'exited' && typeof output.exitCode === 'number' && output.exitCode !== 0)
  ) {
    return 'output-error';
  }

  if (
    state === 'output-available' &&
    output.status === 'running' &&
    ['project_run_command', 'project_get_process_output'].includes(getToolName(part) ?? '')
  ) {
    return 'process-running';
  }

  return state;
}

export function getToolDisplayError(part: unknown): string | undefined {
  if (getToolDisplayState(part) !== 'output-error') {
    return undefined;
  }

  const output = getToolOutput(part);

  if (output && typeof output === 'object') {
    const fields = output as Record<string, unknown>;

    for (const key of ['reason', 'error'] as const) {
      if (typeof fields[key] === 'string') {
        return summarizeToolFailure(fields[key]);
      }
    }

    if ('exitCode' in output && typeof output.exitCode === 'number') {
      return `Command exited with code ${output.exitCode}.`;
    }
  }

  if (part && typeof part === 'object' && 'errorText' in part && typeof part.errorText === 'string') {
    return summarizeToolFailure(part.errorText);
  }

  return typeof output === 'string' ? summarizeToolFailure(output) : 'Tool execution failed.';
}

/*
 * Failure kinds the UI names instead of dumping the raw diagnostic.
 *
 * The tool output stays untouched: the model still receives the full revision and
 * file content it needs to repair the patch. Only what the user reads changes.
 */
export type ToolFailureKind = 'patch-conflict' | 'patch-needs-read' | 'provider' | 'other';

const FAILURE_HEADLINES: Record<Exclude<ToolFailureKind, 'other'>, string> = {
  'patch-conflict': 'Found a bug: the file changed since the last read. Fixing…',
  'patch-needs-read': 'Found a bug: the file was never read. Reading it, then fixing…',
  provider: 'Found a bug in the provider request. Fixing…',
};

/**
 * Longest prefix of a failure message the chat shows. A patch conflict carries the
 * whole file plus a 64-character revision, which buried every other message in the
 * transcript.
 */
const MAX_DISPLAYED_FAILURE_CHARS = 140;

export function classifyToolFailure(message: string): ToolFailureKind {
  if (/patch conflict/i.test(message)) {
    return 'patch-conflict';
  }

  if (/read the file first/i.test(message)) {
    return 'patch-needs-read';
  }

  if (/provider request failed|ai provider|custom error/i.test(message)) {
    return 'provider';
  }

  return 'other';
}

/** Short, human message for the chat. The model still gets the full diagnostic. */
export function summarizeToolFailure(message: string): string {
  const kind = classifyToolFailure(message);

  if (kind !== 'other') {
    return FAILURE_HEADLINES[kind];
  }

  const firstLine = message.trim().split('\n')[0].trim();

  return firstLine.length > MAX_DISPLAYED_FAILURE_CHARS
    ? `${firstLine.slice(0, MAX_DISPLAYED_FAILURE_CHARS - 1)}…`
    : firstLine;
}

/**
 * Rewrites the "Custom error: " prefix the provider layer prepends.
 *
 * The alert keeps its status code and retryability, so only the sentence the user
 * reads is replaced. "Request Failed" told a user nothing and read like the chat
 * itself had broken.
 */
export function toChatFailureHeadline(title: string, message: string): string {
  return message.startsWith('Custom error:') ? `Found a bug: ${message.slice('Custom error:'.length).trim()}` : title;
}
