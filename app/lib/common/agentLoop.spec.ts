import { describe, expect, it } from 'vitest';
import {
  getAgentCompletionProblems,
  getAgentLoopInstructions,
  getAgentLoopProgress,
  isServerAgentTool,
  MAX_AGENT_STEPS,
  PREVIEW_POLL_LIMIT,
  type AgentPlan,
} from './agentLoop';
import type { AnyMessage } from '~/lib/persistence/messageMigration';

describe('server agent tool execution', () => {
  it('keeps plan and completion results out of client approval and dispatch', () => {
    expect(isServerAgentTool('agent_plan')).toBe(true);
    expect(isServerAgentTool('agent_complete')).toBe(true);

    for (const name of ['project_run_command', 'project_patch_file', 'web_search', 'plugin_example', undefined]) {
      expect(isServerAgentTool(name)).toBe(false);
    }
  });
});

const plan: AgentPlan = {
  goal: 'Change the button',
  steps: ['Inspect', 'Patch', 'Run and check'],
  criteria: [{ id: 'button', description: 'The requested button is present and checks pass.' }],
  requiresPreview: true,
};

const user: AnyMessage = { role: 'user', content: 'Change the button' };

function result(name: string, output: Record<string, unknown>, id = name) {
  return { type: `tool-${name}`, toolCallId: id, state: 'output-available', output };
}

function response(...parts: Record<string, unknown>[]): AnyMessage {
  return { role: 'assistant', parts };
}

const planned = result('agent_plan', { plan });
const edited = result('project_patch_file', { patched: true, changed: true }, 'edit');

const run = result(
  'project_run_command',
  { processId: 'server', purpose: 'run', status: 'running', previewReady: true },
  'run',
);
const test = result(
  'project_run_command',
  { processId: 'check', purpose: 'test', status: 'exited', exitCode: 0, previewReady: true },
  'test',
);

const complete = result('agent_complete', { completed: true });
const verifiedMessages = [user, response(planned, edited, run, test)];

describe('agent build loop', () => {
  it('requires a recorded plan, real execution, passing verification and explicit completion', () => {
    const initial = getAgentLoopProgress([user, response({ type: 'text', text: 'I will build it.' })], true);
    expect(initial.status).toBe('pending');
    expect(getAgentCompletionProblems(initial)).toHaveLength(3);

    const verified = getAgentLoopProgress(verifiedMessages, true);
    expect(verified).toMatchObject({ status: 'pending', edited: true, ran: true, tested: true, previewReady: true });
    expect(getAgentCompletionProblems(verified)).toEqual([]);
    expect(getAgentLoopProgress([...verifiedMessages, response(complete)], true).status).toBe('ready');
  });

  it('does not treat a started check or an install as passing verification', () => {
    for (const output of [
      { processId: 'test', purpose: 'test', status: 'running' },
      { processId: 'install', purpose: 'install', status: 'exited', exitCode: 0 },
    ]) {
      const progress = getAgentLoopProgress(
        [user, response(planned, edited, run, result('project_run_command', output), complete)],
        true,
      );
      expect(progress.tested).toBe(false);
      expect(progress.status).toBe('pending');
    }
  });

  it('repairs failed checks and requires a fresh passing result after the repair', () => {
    const failed = result('project_run_command', {
      processId: 'bad',
      purpose: 'test',
      status: 'exited',
      exitCode: 1,
      isError: true,
    });

    const messages = [user, response(planned, edited, run, failed, edited)];
    expect(getAgentLoopProgress(messages, true).tested).toBe(false);
    expect(getAgentLoopProgress([...messages, response(test, complete)], true).status).toBe('ready');
  });

  it('invalidates passing verification and completion after any subsequent change', () => {
    const messages = [...verifiedMessages, response(complete, edited)];
    expect(getAgentLoopProgress(messages, true)).toMatchObject({ tested: false, status: 'pending' });
    expect(getAgentLoopProgress([...messages, response(test, complete)], true).status).toBe('ready');
  });

  it('rejects a check started before an edit even if it finishes afterward', () => {
    const started = result('project_run_command', { processId: 'check', purpose: 'test', status: 'running' });

    const polled = result('project_get_process_output', {
      processId: 'check',
      purpose: 'test',
      status: 'exited',
      exitCode: 0,
    });

    const progress = getAgentLoopProgress([user, response(planned, started, edited, run, polled, complete)], true);
    expect(progress.tested).toBe(false);
    expect(progress.status).toBe('pending');
  });

  it('requires a check after execution and does not complete after stopping the app', () => {
    const nonWebPlan = result('agent_plan', { plan: { ...plan, requiresPreview: false } });
    const earlyTest = { ...test, output: { ...test.output, previewReady: false } };

    const programRun = result('project_run_command', {
      processId: 'program',
      purpose: 'run',
      status: 'exited',
      exitCode: 0,
    });
    expect(
      getAgentLoopProgress([user, response(nonWebPlan, edited, earlyTest, programRun, complete)], true).tested,
    ).toBe(false);
    expect(
      getAgentLoopProgress([user, response(nonWebPlan, edited, programRun, earlyTest, complete)], true).status,
    ).toBe('ready');
    expect(
      getAgentLoopProgress(
        [
          ...verifiedMessages,
          response(complete, result('project_stop_process', { processId: 'server', stopped: true, purpose: 'run' })),
        ],
        true,
      ).status,
    ).toBe('pending');
  });

  it('invalidates a non-web program run after edits', () => {
    const progress = getAgentLoopProgress(
      [
        user,
        response(
          result('agent_plan', { plan: { ...plan, requiresPreview: false } }),
          result('project_run_command', { processId: 'script', purpose: 'run', status: 'exited', exitCode: 0 }),
          edited,
          { ...test, output: { ...test.output, previewReady: false } },
          complete,
        ),
      ],
      true,
    );
    expect(progress.ran).toBe(false);
    expect(progress.status).toBe('pending');
  });

  it('requires preview readiness for a web app and notices a stopped preview', () => {
    const progress = getAgentLoopProgress(
      [
        ...verifiedMessages,
        response(
          complete,
          result('project_get_process_output', {
            processId: 'server',
            purpose: 'run',
            previewReady: false,
            status: 'exited',
            exitCode: 1,
          }),
        ),
      ],
      true,
    );
    expect(progress.previewReady).toBe(false);
    expect(progress.status).toBe('pending');
    expect(getAgentCompletionProblems(progress)).toContain('Confirm a running preview.');
  });

  it('does not force unnecessary edits when a request is already satisfied', () => {
    const progress = getAgentLoopProgress(
      [
        user,
        response(
          planned,
          result('project_read_file', { content: 'requested button already present' }),
          run,
          test,
          complete,
        ),
      ],
      true,
    );
    expect(progress).toMatchObject({ edited: false, status: 'ready' });
  });

  it('no-op patches preserve verification while plan revisions invalidate completion', () => {
    expect(
      getAgentLoopProgress(
        [...verifiedMessages, response(result('project_patch_file', { patched: true, changed: false }), complete)],
        true,
      ).status,
    ).toBe('ready');
    expect(getAgentLoopProgress([...verifiedMessages, response(complete, planned)], true).status).toBe('pending');
  });

  it('excludes failed and unfinished command evidence', () => {
    const progress = getAgentLoopProgress(
      [
        user,
        response(
          result('project_run_command', { processId: 'pending', status: 'running' }, 'pending'),
          result('project_patch_file', { isError: true }, 'failed'),
          result('project_read_file', { content: 'source' }, 'read'),
        ),
      ],
      true,
    );
    expect(progress.evidence).toEqual(['read']);
  });

  it('isolates each follow-up from previous plans, changes and checks', () => {
    expect(
      getAgentLoopProgress(
        [...verifiedMessages, response(complete), { role: 'user', content: 'Move the microphone' }],
        true,
      ),
    ).toMatchObject({ status: 'pending', plan: undefined, tested: false, edited: false, steps: 0, evidence: [] });
  });

  it('keeps informational requests and disabled agent mode outside the build loop', () => {
    expect(getAgentLoopProgress([{ role: 'user', content: 'Explain this component' }], true).status).toBe('inactive');
    expect(getAgentLoopProgress([user], false).status).toBe('inactive');
  });

  it('bounds the task across browser continuation requests and respects denial', () => {
    const messages = [
      user,
      ...Array.from({ length: MAX_AGENT_STEPS }, () =>
        response({ type: 'step-start' }, result('project_read_file', { content: 'source' })),
      ),
    ];
    expect(getAgentLoopProgress(messages, true).status).toBe('limited');

    const denied = getAgentLoopProgress(
      [user, response({ type: 'tool-project_run_command', toolCallId: 'denied', state: 'output-denied' })],
      true,
    );
    expect(denied.status).toBe('blocked');
    expect(getAgentLoopInstructions(denied)).toContain('without claiming success');
  });

  it('rejects completion while project operations are still pending', () => {
    const progress = getAgentLoopProgress(
      [
        ...verifiedMessages,
        response({ type: 'tool-project_patch_file', toolCallId: 'pending', state: 'input-available' }, complete),
      ],
      true,
    );
    expect(progress.status).toBe('pending');
    expect(getAgentCompletionProblems(progress)).toContain('Wait for pending project tool results before completing.');
  });
});

describe('instruction and tool-set agreement', () => {
  /*
   * Before a plan exists, `prepareStep` offers only `agent_plan`, but the guidance
   * told the model to "use project_patch_file or project_write_file now". The model
   * obeyed the prose instead of the tool list, called a tool that was not in the
   * request, and the step died with NoSuchToolError — which is why a fresh chat
   * stalled until the user typed "continue".
   *
   * Whatever the guidance says to call next must actually be offered.
   */
  it('asks for agent_plan while no plan exists', () => {
    const progress = getAgentLoopProgress([user], true);

    expect(progress.plan).toBeUndefined();

    const instructions = getAgentLoopInstructions(progress);

    expect(instructions).toContain('NEXT REQUIRED ACTION: Call agent_plan now');
    expect(instructions).not.toContain('project_patch_file or project_write_file now');
  });

  it('only asks for file edits once the plan is recorded', () => {
    const progress = getAgentLoopProgress([user, response(planned)], true);

    expect(progress.plan).toBeDefined();
    expect(getAgentLoopInstructions(progress)).toContain('project_patch_file or project_write_file now');
  });
});

describe('preview that never becomes ready', () => {
  const poll = (index: number) =>
    result(
      'project_get_process_output',
      { processId: 'server', status: 'running', previewReady: false, output: 'VITE ready' },
      `poll-${index}`,
    );

  it('stays pending while the process is still starting', () => {
    for (let count = 1; count < PREVIEW_POLL_LIMIT; count++) {
      const progress = getAgentLoopProgress(
        [user, response(planned, edited, ...Array.from({ length: count }, (_, i) => poll(i)))],
        true,
      );
      expect(progress.status).toBe('pending');
      expect(progress.previewStalled).toBe(false);
    }
  });

  it('reports limited with an explicit stall after the poll limit', () => {
    const polls = Array.from({ length: PREVIEW_POLL_LIMIT }, (_, i) => poll(i));
    const progress = getAgentLoopProgress([user, response(planned, edited, ...polls)], true);

    expect(progress.status).toBe('limited');
    expect(progress.previewStalled).toBe(true);
    expect(getAgentLoopInstructions(progress)).toContain('never became ready');
  });

  it('does not stall when the preview becomes ready', () => {
    const polls = Array.from({ length: PREVIEW_POLL_LIMIT }, (_, i) => poll(i));

    const ready = result(
      'project_get_process_output',
      { processId: 'server', status: 'running', previewReady: true },
      'ready',
    );

    const progress = getAgentLoopProgress([user, response(planned, edited, ...polls, ready)], true);

    expect(progress.previewStalled).toBe(false);
    expect(progress.status).not.toBe('limited');
  });
});
