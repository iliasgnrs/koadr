import { generateText, isStepCount } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { createAgentLoopTools } from './agent-loop';
import type { AgentPlan } from '~/lib/common/agentLoop';
import type { AnyMessage } from '~/lib/persistence/messageMigration';

const plan: AgentPlan = {
  goal: 'Change the button',
  steps: ['Read', 'Patch', 'Run and verify'],
  criteria: [{ id: 'button', description: 'The requested button is present and checks pass.' }],
  requiresPreview: true,
};

const user: AnyMessage = { role: 'user', content: 'Change the button' };

const part = (name: string, output: Record<string, unknown>, id = name) => ({
  type: `tool-${name}`,
  toolCallId: id,
  state: 'output-available',
  output,
});
const verified: AnyMessage[] = [
  user,
  {
    role: 'assistant',
    parts: [
      part('agent_plan', { plan }),
      part('project_patch_file', { patched: true }, 'edit'),
      part(
        'project_run_command',
        { processId: 'server', purpose: 'run', status: 'running', previewReady: true },
        'run',
      ),
      part(
        'project_run_command',
        { processId: 'check', purpose: 'test', status: 'exited', exitCode: 0, previewReady: true },
        'check',
      ),
    ],
  },
];
const completion = {
  outcome: 'complete' as const,
  summary: 'Button updated and checks pass.',
  criteria: [{ id: 'button' }],
};

const executeOptions = { toolCallId: 'complete', messages: [], context: {} };

describe('agent plan and completion tools', () => {
  it('requires the plan tool first and enforces preview criteria for starter builds', async () => {
    const loop = createAgentLoopTools([user], true, true);
    expect(loop.prepareStep({ steps: [] })).toEqual({
      toolChoice: { type: 'tool', toolName: 'agent_plan' },
      activeTools: ['agent_plan'],
    });
    expect(await loop.tools.agent_plan.execute!({ ...plan, requiresPreview: false }, executeOptions)).toMatchObject({
      plan: { requiresPreview: true },
    });
  });

  it('withholds completion until run and test evidence exist', () => {
    const loop = createAgentLoopTools(
      [user, { role: 'assistant', parts: [part('agent_plan', { plan })] }],
      true,
      true,
      ['project_read_file', 'project_run_command'],
    );

    /*
     * `project_run_command` must stay visible before the first edit. The old
     * allowlist dropped it, which is what produced the live failure: the model
     * called a tool that was not in the request, the SDK raised
     * NoSuchToolError, and the turn ended with no preview. Completion is still
     * withheld here, because no run/test evidence exists yet.
     */
    expect(loop.prepareStep({ steps: [] }).activeTools).toEqual([
      'project_read_file',
      'project_run_command',
      'agent_plan',
      'agent_complete',
    ]);
  });

  it('only defers the read-only exploration tools before the first edit', () => {
    const allTools = [
      'project_read_file',
      'project_write_file',
      'project_patch_file',
      'project_create_directory',
      'project_list_paths',
      'project_search_content',
      'project_find_related_files',
      'project_run_command',
      'project_get_process_output',
      'project_stop_process',
      'project_delete_path',
      'web_search',
      'web_fetch',
      'some_future_tool',
    ];

    const loop = createAgentLoopTools(
      [user, { role: 'assistant', parts: [part('agent_plan', { plan })] }],
      true,
      true,
      allTools,
    );

    const active = loop.prepareStep({ steps: [] }).activeTools ?? [];

    expect(active).not.toContain('project_list_paths');
    expect(active).not.toContain('project_search_content');
    expect(active).not.toContain('project_find_related_files');

    for (const name of [
      'project_run_command',
      'project_get_process_output',
      'project_stop_process',
      'project_delete_path',
      'web_search',
      'web_fetch',
    ]) {
      expect(active).toContain(name);
    }

    // A denylist, not an allowlist: a tool added later must be available by default.
    expect(active).toContain('some_future_tool');
  });

  it('rejects completion without actual run and test evidence', async () => {
    const loop = createAgentLoopTools(
      [
        user,
        {
          role: 'assistant',
          parts: [part('agent_plan', { plan }), part('project_patch_file', { patched: true }, 'edit')],
        },
      ],
      true,
      true,
    );
    expect(await loop.tools.agent_complete.execute!(completion, executeOptions)).toMatchObject({
      isError: true,
      completed: false,
      error: expect.stringContaining('purpose test'),
    });
  });

  it('requires every planned criterion and attaches successful tool-call evidence automatically', async () => {
    const loop = createAgentLoopTools(verified, true, true);

    for (const criteria of [[], [{ id: 'invented' }], [{ id: 'button' }, { id: 'button' }]]) {
      expect(await loop.tools.agent_complete.execute!({ ...completion, criteria }, executeOptions)).toMatchObject({
        isError: true,
        completed: false,
        error: expect.stringContaining('criterion'),
        availableEvidence: expect.arrayContaining(['edit', 'run', 'check']),
        plannedCriteria: ['button'],
      });
    }

    const completed = await loop.tools.agent_complete.execute!(
      {
        ...completion,
        criteria: [{ id: 'button', evidence: ['server-123', 'npm run build'] }],
      },
      executeOptions,
    );

    expect(completed).toMatchObject({
      completed: true,
      criteria: [{ id: 'button', evidence: ['edit', 'run', 'check'] }],
    });
  });

  it('supports a concrete blocked outcome without claiming success', async () => {
    const loop = createAgentLoopTools([user], true, true);

    const output = await loop.tools.agent_complete.execute!(
      { outcome: 'blocked', summary: 'Dependency registry is unavailable.', criteria: [] },
      executeOptions,
    );
    expect(output).toMatchObject({ completed: false, blocked: true });
    expect(
      loop.prepareStep({
        steps: [
          {
            toolCalls: [{ toolName: 'agent_complete', toolCallId: 'complete', input: {} }],
            toolResults: [{ toolCallId: 'complete', output }],
          },
        ],
      }),
    ).toEqual({ toolChoice: 'none' });
  });

  it('sees a server-executed plan in the next SDK step of the same request', async () => {
    const loop = createAgentLoopTools([user], true, true);
    const output = await loop.tools.agent_plan.execute!(plan, executeOptions);
    expect(
      loop.prepareStep({
        steps: [
          {
            toolCalls: [{ toolName: 'agent_plan', toolCallId: 'plan', input: plan }],
            toolResults: [{ toolCallId: 'plan', output }],
          },
        ],
      }),
    ).toEqual({ toolChoice: 'required' });
  });

  it('unlocks project tools after the server-executed plan call', () => {
    /*
     * Regression: `agent_plan` executes on the server, so the SDK reports no
     * toolResult for it. The loop then re-narrowed activeTools to agent_plan on
     * every step, and later project tool calls failed with
     * "Model tried to call unavailable tool 'project_write_file'".
     */
    const loop = createAgentLoopTools([user], true, true, ['project_write_file', 'project_read_file']);

    const planStep = {
      toolCalls: [{ toolName: 'agent_plan', toolCallId: 'plan', input: plan }],
      toolResults: [],
    };

    expect(loop.prepareStep({ steps: [planStep] })).toMatchObject({
      toolChoice: 'required',
      activeTools: expect.arrayContaining(['project_write_file', 'project_read_file']),
    });
  });

  /*
   * Thinking-mode models (DeepSeek V4) answer 400 for a forced tool_choice, so the
   * loop must fall back to `auto` while still narrowing the active tool set.
   */
  it('falls back to auto when the model rejects a forced tool choice', () => {
    const loop = createAgentLoopTools([user], true, true, ['project_read_file'], false);

    expect(loop.prepareStep({ steps: [] })).toEqual({
      toolChoice: 'auto',
      activeTools: ['agent_plan'],
    });

    expect(
      loop.prepareStep({
        steps: [
          {
            toolCalls: [{ toolName: 'agent_plan', toolCallId: 'plan', input: plan }],
            toolResults: [{ toolCallId: 'plan', output: { plan } }],
          },
        ],
      }),
    ).toMatchObject({ toolChoice: 'auto' });
  });

  it('allows a final answer after successful completion within the real SDK loop', async () => {
    let call = 0;

    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        const completing = call++ === 0;
        return {
          content: completing
            ? [
                {
                  type: 'tool-call' as const,
                  toolCallId: 'complete',
                  toolName: 'agent_complete',
                  input: JSON.stringify(completion),
                },
              ]
            : [{ type: 'text' as const, text: 'Updated the button. Checks passed.' }],
          finishReason: {
            unified: completing ? ('tool-calls' as const) : ('stop' as const),
            raw: completing ? 'tool_calls' : 'stop',
          },
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 1, reasoning: 0, text: 1 },
          },
          warnings: [],
        };
      },
    });

    const loop = createAgentLoopTools(verified, true, true);

    const result = await generateText({
      model,
      prompt: 'Finish the verified change.',
      system: 'Base project instructions.',
      tools: loop.tools,
      prepareStep: loop.prepareStep,
      stopWhen: isStepCount(4),
    });
    expect(result.text).toBe('Updated the button. Checks passed.');
    expect(model.doGenerateCalls.map((call) => call.toolChoice)).toEqual([{ type: 'required' }, { type: 'none' }]);
    expect(result.steps[0].toolResults[0].output).toMatchObject({ completed: true });
    expect(result.steps).toHaveLength(2);
    expect(model.doGenerateCalls[1].prompt[0]).toMatchObject({
      role: 'system',
      content: expect.stringContaining('completion gate accepted'),
    });
    expect(model.doGenerateCalls[1].prompt[0]).toMatchObject({
      content: expect.stringContaining('Base project instructions.'),
    });
  });
});

describe('agent_complete input tolerance', () => {
  /*
   * A live run failed at the very end: every criterion had passed, but the model
   * wrote a long summary, the schema's `.max(1000)` rejected it, and
   * InvalidToolInputError ended the turn — the user had to type "continue" to get
   * the result. Length is cosmetic, so it is clipped rather than rejected.
   */
  it('clips an over-long summary instead of failing the whole completion', async () => {
    const loop = createAgentLoopTools(
      [
        user,
        {
          role: 'assistant',
          parts: [
            part('agent_plan', { plan }),
            part('project_patch_file', { patched: true, changed: true }, 'edit'),
            part(
              'project_run_command',
              { processId: 'server', purpose: 'run', status: 'running', previewReady: true },
              'run',
            ),
            part(
              'project_run_command',
              { processId: 'check', purpose: 'test', status: 'exited', exitCode: 0, previewReady: true },
              'check',
            ),
          ],
        },
      ],
      true,
      true,
    );

    const summary = 'x'.repeat(4000);

    const output = (await loop.tools.agent_complete.execute!({ ...completion, summary }, executeOptions)) as {
      completed?: boolean;
      summary?: string;
    };

    expect(output.completed).toBe(true);
    expect(output.summary).toHaveLength(1000);
    expect(output.summary?.endsWith('...')).toBe(true);
  });
});
