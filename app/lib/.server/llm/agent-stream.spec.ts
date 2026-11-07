import {
  isStepCount,
  jsonSchema,
  NoSuchToolError,
  streamText,
  tool,
  toUIMessageStream,
  type ToolSet,
  type LanguageModel,
  type TextStreamPart,
} from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createAgentStreamRecovery,
  getToolCatalogue,
  withAgentStreamDeadlines,
  withAgentToolCallRecovery,
} from './agent-stream';
import { toSafeStreamErrorMessage } from '~/lib/.server/api/errors';

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, reasoning: 0, text: 1 },
};

const finish = (controller: ReadableStreamDefaultController<any>, toolCalls = false) => {
  controller.enqueue({
    type: 'finish',
    finishReason: { unified: toolCalls ? 'tool-calls' : 'stop', raw: toolCalls ? 'tool_calls' : 'stop' },
    usage,
  });
  controller.close();
};
const collect = async <TOOLS extends ToolSet>(
  result: { stream: ReadableStream<TextStreamPart<TOOLS>> },
  mapError = toSafeStreamErrorMessage,
) => {
  const chunks = [];

  for await (const chunk of toUIMessageStream({ stream: result.stream, onError: mapError })) {
    chunks.push(chunk);
  }

  return chunks;
};
afterEach(() => vi.useRealTimers());

describe('agent provider recovery', () => {
  it.each([
    '[[{"name":"project_read_file","parameters":{"path":"src/index.css"}}]]',
    '```json\n[{"name":"project_read_file","parameters":{"path":"src/index.css"}}]\n```',
  ])('recovers complete tool JSON through the real tool validator and execution pipeline: %s', async (text) => {
    const execute = vi.fn(async () => ({ content: 'body { margin: 0; }' }));

    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            controller.enqueue({ type: 'text-start', id: 'json' });
            controller.enqueue({ type: 'text-delta', id: 'json', delta: text });
            controller.enqueue({ type: 'text-end', id: 'json' });
            finish(controller);
          },
        }),
      }),
    });
    const result = await streamText({
      model: withAgentToolCallRecovery(withAgentStreamDeadlines(model), vi.fn()),
      prompt: 'Read the project stylesheet.',
      toolChoice: 'required',
      tools: {
        project_read_file: tool({
          inputSchema: jsonSchema({
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
            additionalProperties: false,
          }),
          execute,
        }),
      },
      streamRetries: 0,
    });

    const chunks = await collect(result);
    expect(model.doStreamCalls).toHaveLength(1);
    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith(
      { path: 'src/index.css' },
      expect.objectContaining({ toolCallId: expect.any(String) }),
    );
    expect(chunks.some((chunk) => chunk.type === 'error')).toBe(false);
    expect(chunks.some((chunk) => chunk.type === 'text-delta')).toBe(false);
  });

  it.each([
    '[{"name":"unavailable_tool","parameters":{}}]',
    'Example only: [{"name":"project_read_file","parameters":{"path":"src/index.css"}}]',
    '[{"name":"project_read_file","parameters":{},"extra":"unexpected"}]',
  ])('does not execute unavailable tools or incidental JSON: %s', async (text) => {
    const execute = vi.fn();

    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            controller.enqueue({ type: 'text-start', id: 'json' });
            controller.enqueue({ type: 'text-delta', id: 'json', delta: text });
            controller.enqueue({ type: 'text-end', id: 'json' });
            finish(controller);
          },
        }),
      }),
    });
    const result = await streamText({
      model: withAgentToolCallRecovery(withAgentStreamDeadlines(model), vi.fn()),
      prompt: 'Read a file.',
      toolChoice: 'required',
      tools: { project_read_file: tool({ inputSchema: jsonSchema({ type: 'object', properties: {} }), execute }) },
      streamRetries: 0,
    });

    const chunks = await collect(result);
    expect(execute).not.toHaveBeenCalled();
    expect(chunks.some((chunk) => chunk.type === 'error')).toBe(true);
  });

  it('retries a text-only required-tool response and accepts the recovered real tool call once', async () => {
    const execute = vi.fn(async () => ({ plan: 'recorded' }));

    let attempts = 0;

    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });

            if (attempts++ === 0) {
              controller.enqueue({ type: 'text-start', id: 'invalid' });
              controller.enqueue({ type: 'text-delta', id: 'invalid', delta: '[{"name":"agent_plan"}]' });
              controller.enqueue({ type: 'text-end', id: 'invalid' });
              finish(controller);
            } else {
              controller.enqueue({ type: 'tool-call', toolCallId: 'plan', toolName: 'agent_plan', input: '{}' });
              finish(controller, true);
            }
          },
        }),
      }),
    });

    const onRetry = vi.fn();
    const recovery = createAgentStreamRecovery(onRetry);

    const result = await streamText({
      model: withAgentToolCallRecovery(withAgentStreamDeadlines(model), () => onRetry('tool-call')),
      prompt: 'Build the page.',
      toolChoice: 'required',
      tools: { agent_plan: tool({ inputSchema: jsonSchema({ type: 'object', properties: {} }), execute }) },
      streamRetries: 0,
      onError: recovery.onError,
    });

    const chunks = await collect(result);
    expect(onRetry).toHaveBeenCalledExactlyOnceWith('tool-call');
    expect(model.doStreamCalls).toHaveLength(2);
    expect(execute).toHaveBeenCalledOnce();
    expect(chunks.some((chunk) => chunk.type === 'error')).toBe(false);
    expect(chunks).toContainEqual(expect.objectContaining({ type: 'tool-output-available', toolCallId: 'plan' }));
  });

  it('stops after one unsuccessful tool-call retry and never executes printed JSON', async () => {
    const execute = vi.fn();

    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            controller.enqueue({ type: 'text-start', id: 'invalid' });
            controller.enqueue({ type: 'text-delta', id: 'invalid', delta: '[{"name":"agent_plan"}]' });
            controller.enqueue({ type: 'text-end', id: 'invalid' });
            finish(controller);
          },
        }),
      }),
    });

    const onRetry = vi.fn();
    const recovery = createAgentStreamRecovery(vi.fn());

    const result = await streamText({
      model: withAgentToolCallRecovery(withAgentStreamDeadlines(model), onRetry),
      prompt: 'Build the page.',
      toolChoice: 'required',
      tools: { agent_plan: tool({ inputSchema: jsonSchema({ type: 'object', properties: {} }), execute }) },
      streamRetries: 0,
      onError: recovery.onError,
    });

    const chunks = await collect(result);
    expect(onRetry).toHaveBeenCalledOnce();
    expect(model.doStreamCalls).toHaveLength(2);
    expect(execute).not.toHaveBeenCalled();
    expect(chunks).toContainEqual(
      expect.objectContaining({ type: 'error', errorText: expect.stringContaining('required tool call') }),
    );
  });

  it('waits beyond 45 seconds and retries only the stalled step, preserving the recorded plan', async () => {
    vi.useFakeTimers();

    const recordPlan = vi.fn(async () => ({ plan: 'recorded' }));

    let call = 0;

    const model = new MockLanguageModelV4({
      doStream: async () => {
        const attempt = call++;
        return {
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({ type: 'stream-start', warnings: [] });

              if (attempt === 0) {
                controller.enqueue({ type: 'tool-call', toolCallId: 'plan', toolName: 'agent_plan', input: '{}' });
                finish(controller, true);
              } else if (attempt === 1) {
                controller.enqueue({ type: 'reasoning-start', id: 'thinking' });
                controller.enqueue({
                  type: 'reasoning-delta',
                  id: 'thinking',
                  delta: 'Now let me install dependencies first.',
                });

                // Reproduce the user's provider silence before command/tool output.
              } else {
                controller.enqueue({
                  type: 'tool-call',
                  toolCallId: 'install',
                  toolName: 'project_run_command',
                  input: '{"command":"npm install","purpose":"install"}',
                });
                finish(controller, true);
              }
            },
          }),
        };
      },
    });

    const onRetry = vi.fn();
    const recovery = createAgentStreamRecovery(onRetry);

    const result = await streamText({
      model: withAgentStreamDeadlines(model),
      prompt: 'Build the page.',
      toolChoice: 'required',
      tools: {
        agent_plan: tool({ inputSchema: jsonSchema({ type: 'object', properties: {} }), execute: recordPlan }),
        project_run_command: {
          inputSchema: jsonSchema({
            type: 'object',
            properties: { command: { type: 'string' }, purpose: { type: 'string' } },
            required: ['command', 'purpose'],
          }),
        },
      },
      streamRetries: 0,
      onError: recovery.onError,
      stopWhen: isStepCount(5),
    });

    const collected = collect(result, (error) => toSafeStreamErrorMessage(recovery.getError(error)));
    await vi.advanceTimersByTimeAsync(45_000);
    expect(model.doStreamCalls).toHaveLength(2);
    expect(onRetry).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(75_001);

    const chunks = await collected;
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(recordPlan).toHaveBeenCalledTimes(1);
    expect(model.doStreamCalls).toHaveLength(3);
    expect(chunks.some((chunk) => chunk.type === 'error')).toBe(false);
    expect(chunks).toContainEqual(
      expect.objectContaining({ type: 'tool-input-available', toolName: 'project_run_command', toolCallId: 'install' }),
    );
    expect(model.doStreamCalls[2].prompt).toEqual(model.doStreamCalls[1].prompt);
  });

  it('buffers incomplete failed tool attempts so effects are executed only once', async () => {
    const execute = vi.fn(async () => ({ written: true }));

    let call = 0;

    const model = new MockLanguageModelV4({
      doStream: async () => {
        const fail = call++ === 0;
        return {
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({ type: 'stream-start', warnings: [] });
              controller.enqueue({
                type: 'tool-call',
                toolCallId: fail ? 'discarded' : 'kept',
                toolName: 'project_write_file',
                input: '{}',
              });

              if (fail) {
                controller.enqueue({ type: 'error', error: new Error('Network connection lost') });
                controller.close();
              } else {
                finish(controller, true);
              }
            },
          }),
        };
      },
    });

    const recovery = createAgentStreamRecovery(vi.fn());

    const result = await streamText({
      model: withAgentStreamDeadlines(model),
      prompt: 'Edit the page.',
      tools: { project_write_file: tool({ inputSchema: jsonSchema({ type: 'object', properties: {} }), execute }) },
      streamRetries: 0,
      onError: recovery.onError,
    });

    const chunks = await collect(result);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(chunks).not.toContainEqual(expect.objectContaining({ toolCallId: 'discarded' }));
    expect(chunks).toContainEqual(expect.objectContaining({ type: 'tool-output-available', toolCallId: 'kept' }));
  });

  it('stops after one failed recovery and reports the timeout without a misleading tool error', async () => {
    vi.useFakeTimers();

    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
          },
        }),
      }),
    });

    const onRetry = vi.fn();
    const recovery = createAgentStreamRecovery(onRetry);

    const result = await streamText({
      model: withAgentStreamDeadlines(model, { firstMs: 20, idleMs: 20, attemptMs: 100 }),
      prompt: 'Continue.',
      toolChoice: 'required',
      tools: { project_list_paths: { inputSchema: jsonSchema({ type: 'object', properties: {} }) } },
      streamRetries: 0,
      onError: recovery.onError,
    });

    const collected = collect(result, (error) => toSafeStreamErrorMessage(recovery.getError(error)));
    await vi.advanceTimersByTimeAsync(41);

    const chunks = await collected;
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(model.doStreamCalls).toHaveLength(2);
    expect(chunks).toContainEqual(
      expect.objectContaining({ type: 'error', errorText: expect.stringContaining('provider stopped responding') }),
    );
    expect(JSON.stringify(chunks)).not.toContain('text instead of the required tool call');
  });

  it('respects cancellation and does not retry authentication or rate-limit errors', () => {
    const onRetry = vi.fn();

    for (const error of [
      new DOMException('Network connection cancelled', 'AbortError'),
      Object.assign(new Error('Unauthorized network request'), { statusCode: 401 }),
      Object.assign(new Error('Network rate limit'), { statusCode: 429 }),
    ]) {
      const recovery = createAgentStreamRecovery(onRetry);
      expect(recovery.onError({ error })).toBeUndefined();
    }
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('aborts a silent initial provider request and retries with a fresh signal', async () => {
    vi.useFakeTimers();

    const signals: AbortSignal[] = [];

    const model = new MockLanguageModelV4({
      doStream: async ({ abortSignal }) => {
        signals.push(abortSignal!);

        if (signals.length === 1) {
          return await new Promise<never>((_, reject) =>
            abortSignal!.addEventListener('abort', () => reject(abortSignal!.reason), { once: true }),
          );
        }

        return {
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({ type: 'stream-start', warnings: [] });
              controller.enqueue({ type: 'text-start', id: 'ok' });
              controller.enqueue({ type: 'text-delta', id: 'ok', delta: 'Recovered.' });
              controller.enqueue({ type: 'text-end', id: 'ok' });
              finish(controller);
            },
          }),
        };
      },
    });

    const onRetry = vi.fn();
    const recovery = createAgentStreamRecovery(onRetry);

    const result = await streamText({
      model: withAgentStreamDeadlines(model, { firstMs: 20, idleMs: 20, attemptMs: 100 }),
      prompt: 'Continue.',
      streamRetries: 0,
      onError: recovery.onError,
    });

    const collected = collect(result);
    await vi.advanceTimersByTimeAsync(21);

    const chunks = await collected;
    expect(signals).toHaveLength(2);
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(chunks).toContainEqual(expect.objectContaining({ type: 'text-delta', delta: 'Recovered.' }));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not replay an accepted tool call when the transport closes badly after finish', async () => {
    const execute = vi.fn(async () => ({ written: true }));

    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            controller.enqueue({ type: 'tool-call', toolCallId: 'write', toolName: 'project_write_file', input: '{}' });
            controller.enqueue({ type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage });
            controller.enqueue({ type: 'error', error: new Error('Network connection failed after completion') });
            controller.close();
          },
        }),
      }),
    });

    const onRetry = vi.fn();
    const recovery = createAgentStreamRecovery(onRetry);

    const result = await streamText({
      model: withAgentStreamDeadlines(model),
      prompt: 'Edit.',
      tools: { project_write_file: tool({ inputSchema: jsonSchema({ type: 'object', properties: {} }), execute }) },
      streamRetries: 0,
      onError: recovery.onError,
    });

    const chunks = await collect(result);
    expect(onRetry).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(chunks.some((chunk) => chunk.type === 'error')).toBe(false);
  });
});

describe('automatic tool choice recovery', () => {
  /*
   * Thinking-mode models cannot be forced to call a tool, so the loop sends
   * `auto`. Recovery must still convert printed tool JSON into real calls there.
   */
  it('recovers printed tool JSON under auto without flagging plain text', async () => {
    const execute = vi.fn(async () => ({ content: 'ok' }));

    const reply = (text: string) =>
      new MockLanguageModelV4({
        doStream: async () => ({
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({ type: 'stream-start', warnings: [] });
              controller.enqueue({ type: 'text-start', id: 'text' });
              controller.enqueue({ type: 'text-delta', id: 'text', delta: text });
              controller.enqueue({ type: 'text-end', id: 'text' });
              finish(controller);
            },
          }),
        }),
      });

    const tools = {
      project_read_file: tool({
        inputSchema: jsonSchema({
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
          additionalProperties: false,
        }),
        execute,
      }),
    };

    const recovered = await streamText({
      model: withAgentToolCallRecovery(
        withAgentStreamDeadlines(reply('[{"name":"project_read_file","parameters":{"path":"src/a.css"}}]')),
        vi.fn(),
      ),
      prompt: 'Read the stylesheet.',
      toolChoice: 'auto',
      tools,
      stopWhen: isStepCount(2),
    });

    // The SDK never executes unvalidated tool calls here, so assert on the emitted UI chunks.
    expect(await collect(recovered)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'tool-input-available', toolName: 'project_read_file' }),
      ]),
    );

    const plain = await streamText({
      model: withAgentToolCallRecovery(withAgentStreamDeadlines(reply('The file uses flexbox.')), vi.fn()),
      prompt: 'What does the stylesheet do?',
      toolChoice: 'auto',
      tools,
      stopWhen: isStepCount(2),
    });

    const plainChunks = await collect(plain);

    expect(plainChunks).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'text-delta' })]));
    expect(plainChunks.some((chunk) => chunk.type === 'tool-input-available')).toBe(false);
  });
});

describe('tool markup recovery', () => {
  const tools = () => ({
    project_get_process_output: tool({
      inputSchema: jsonSchema({
        type: 'object',
        properties: { processId: { type: 'string' } },
        required: ['processId'],
        additionalProperties: false,
      }),
    }),
  });

  const markupReply = (markup: string) =>
    new MockLanguageModelV4({
      doStream: async () => ({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            controller.enqueue({ type: 'text-start', id: 't' });
            controller.enqueue({ type: 'text-delta', id: 't', delta: markup });
            controller.enqueue({ type: 'text-end', id: 't' });
            finish(controller);
          },
        }),
      }),
    });

  it.each([
    '<||DSML|| invoke name="project_get_process_output"><||DSML|| parameter name="processId" string="true">p-1<||DSML|| parameter></||DSML|| invoke>',
    '<antml:invoke name="project_get_process_output"><antml:parameter name="processId" string="true">p-1</antml:parameter></antml:invoke>',

    /*
     * Full-width bars (U+FF5C). A real session emitted these and the ASCII-only
     * matcher missed them, so the raw markup reached the UI and the turn stalled
     * waiting for a tool result that never came.
     */
    '\uFF5C\uFF5CDSML\uFF5C\uFF5C invoke name="project_get_process_output">\uFF5C\uFF5CDSML\uFF5C\uFF5C parameter name="processId" string="true">p-1\uFF5C\uFF5CDSML\uFF5C\uFF5C parameter>\uFF5C\uFF5CDSML\uFF5C\uFF5C invoke>',
  ])('recovers a tool call printed as provider markup', async (markup) => {
    await expectRecoveredProcessId(markup, 'p-1');
  });

  /*
   * The live hang: a wrapped, multi-line full-width block whose parameter closes
   * with `</｜｜DSML｜｜ parameter>`. The old terminator captured the `<` as part of
   * the value (`p-1<`), the tool input failed validation, and the retry re-sent
   * the same argument forever — the user sees "Command is still running" and no
   * progress. A recovered call must carry the exact value.
   */
  it.each([
    [
      'multi-line block',
      '\uFF5C\uFF5CDSML\uFF5C\uFF5C calls>\n' +
        '\uFF5C\uFF5CDSML\uFF5C\uFF5C invoke name="project_get_process_output">\n' +
        '\uFF5C\uFF5CDSML\uFF5C\uFF5C parameter name="processId" string="true">25b02b92\uFF5C\uFF5CDSML\uFF5C\uFF5C parameter>\n' +
        '\uFF5C\uFF5CDSML\uFF5C\uFF5C invoke>',
    ],
    [
      'angle-bracket close on full-width bars',
      '\uFF5C\uFF5CDSML\uFF5C\uFF5C invoke name="project_get_process_output">\uFF5C\uFF5CDSML\uFF5C\uFF5C parameter name="processId" string="true">25b02b92</\uFF5C\uFF5CDSML\uFF5C\uFF5C parameter>\uFF5C\uFF5CDSML\uFF5C\uFF5C invoke>',
    ],
    [
      'closing tag without the bar prefix',
      '\uFF5C\uFF5CDSML\uFF5C\uFF5C invoke name="project_get_process_output">\uFF5C\uFF5CDSML\uFF5C\uFF5C parameter name="processId" string="true">25b02b92</parameter></invoke>',
    ],
  ])('keeps the parameter value exact for %s', async (_name, markup) => {
    await expectRecoveredProcessId(markup, '25b02b92');
  });

  async function expectRecoveredProcessId(markup: string, expected: string) {
    const result = await streamText({
      model: withAgentToolCallRecovery(withAgentStreamDeadlines(markupReply(markup)), vi.fn()),
      prompt: 'Poll the running command.',
      toolChoice: 'auto',
      tools: tools(),
      stopWhen: isStepCount(1),
    });

    const chunks = await collect(result);
    expect(chunks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'tool-input-available', toolName: 'project_get_process_output' }),
      ]),
    );
    expect(JSON.stringify(chunks)).toContain(`"processId":"${expected}"`);

    // The raw markup must not reach the UI; only the recovered call and any prose may.
    expect(JSON.stringify(chunks)).not.toMatch(/DSML|antml:invoke|antml:parameter/);
  }
});

describe('invented tool names', () => {
  const tools = () => ({
    project_get_process_output: tool({
      inputSchema: jsonSchema({
        type: 'object',
        properties: { processId: { type: 'string' } },
        required: ['processId'],
        additionalProperties: false,
      }),
    }),
    project_run_command: tool({
      inputSchema: jsonSchema({ type: 'object', properties: { command: { type: 'string' } } }),
    }),
  });

  const markupReply = (markup: string) =>
    new MockLanguageModelV4({
      doStream: async () => ({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            controller.enqueue({ type: 'text-start', id: 't' });
            controller.enqueue({ type: 'text-delta', id: 't', delta: markup });
            controller.enqueue({ type: 'text-end', id: 't' });
            finish(controller);
          },
        }),
      }),
    });

  it('resolves a known near-miss to the real tool instead of failing the turn', async () => {
    const result = await streamText({
      model: withAgentToolCallRecovery(
        withAgentStreamDeadlines(
          markupReply(
            '<||DSML|| invoke name="project_read_command_output"><||DSML|| parameter name="processId" string="true">p-1<||DSML|| parameter></||DSML|| invoke>',
          ),
        ),
        vi.fn(),
      ),
      prompt: 'Poll the running command.',
      toolChoice: 'auto',
      tools: tools(),
      stopWhen: isStepCount(1),
    });

    const chunks = await collect(result);
    expect(JSON.stringify(chunks)).toContain('"toolName":"project_get_process_output"');
    expect(JSON.stringify(chunks)).toContain('"processId":"p-1"');
  });

  it('tells the user when printed markup could not be recovered', async () => {
    const result = await streamText({
      model: withAgentToolCallRecovery(
        withAgentStreamDeadlines(
          markupReply(
            'Let me check.\n<||DSML|| invoke name="project_query_database"><||DSML|| parameter name="id" string="true">1<||DSML|| parameter></||DSML|| invoke>',
          ),
        ),
        vi.fn(),
      ),
      prompt: 'Poll the running command.',
      toolChoice: 'auto',
      tools: tools(),
      stopWhen: isStepCount(1),
    });

    const chunks = await collect(result);
    const rendered = JSON.stringify(chunks);

    expect(rendered).not.toMatch(/DSML|invoke/);
    expect(rendered).toContain('native call');
  });
});

describe('getToolCatalogue', () => {
  it('lists names once, sorted, and forbids inventing new ones', () => {
    const catalogue = getToolCatalogue(['project_run_command', 'agent_plan', 'project_run_command']);

    expect(catalogue).toContain('<available_tools>');
    expect(catalogue).toContain('agent_plan, project_run_command');
    expect(catalogue.match(/project_run_command/g)).toHaveLength(1);
    expect(catalogue).toContain('Never construct a tool name');
  });

  it('adds nothing when no tools are offered', () => {
    expect(getToolCatalogue([])).toBe('');
  });
});

describe('wrapped model identity', () => {
  /*
   * Regression: the wrappers used to spread the model into a new object, which
   * silently dropped the non-enumerable `provider`. The SDK splits it before
   * every request, so every provider failed with "Cannot read properties of
   * undefined (reading 'split')" instead of reaching the network.
   */
  it.each([
    ['withAgentStreamDeadlines', withAgentStreamDeadlines],
    ['withAgentToolCallRecovery', (model: LanguageModel) => withAgentToolCallRecovery(model, vi.fn())],
  ])('%s preserves provider, modelId and supportedUrls', (_name, wrap) => {
    const model = new MockLanguageModelV4({
      provider: 'deepseek.chat',
      modelId: 'deepseek-v4-flash',
      doStream: async () => ({ stream: new ReadableStream() }),
    });

    const wrapped = wrap(model) as Exclude<LanguageModel, string>;

    expect(wrapped.provider).toBe('deepseek.chat');
    expect(wrapped.modelId).toBe('deepseek-v4-flash');
    expect(typeof wrapped.provider.split('.')[0]).toBe('string');
    expect(wrapped.supportedUrls).toBeDefined();
  });

  it('keeps provider identity through both wrappers', () => {
    const model = new MockLanguageModelV4({
      provider: 'deepseek.chat',
      modelId: 'deepseek-v4-flash',
      doStream: async () => ({ stream: new ReadableStream() }),
    });
    const wrapped = withAgentToolCallRecovery(withAgentStreamDeadlines(model), vi.fn()) as Exclude<
      LanguageModel,
      string
    >;

    expect(wrapped.provider).toBe('deepseek.chat');
  });
});

describe('unknown-tool retry', () => {
  /*
   * The live failure: the model called `project_list_paths` on the very first step,
   * when only `agent_plan` was offered (the plan gate). The SDK raised
   * NoSuchToolError, which the recovery callback treated as non-retryable, so the
   * step died and the turn ended before the plan had even been recorded. The user
   * then had to type "continue" by hand.
   *
   * The tool set is recomputed per step, so this error is recoverable: one retry
   * lets the next step offer `agent_plan`, and the run proceeds.
   */
  const unavailableToolError = () => new NoSuchToolError({ toolName: 'project_list_paths' });

  it('retries a NoSuchToolError instead of ending the turn', () => {
    const onRetry = vi.fn();
    const recovery = createAgentStreamRecovery(onRetry);

    const decision = recovery.onError({ error: unavailableToolError() } as never);

    expect(decision).toEqual({ retry: true });
    expect(onRetry).toHaveBeenCalledExactlyOnceWith('tool-call');
  });

  it('matches on the message when the error is not the SDK class', () => {
    const onRetry = vi.fn();
    const recovery = createAgentStreamRecovery(onRetry);

    const decision = recovery.onError({
      error: new Error("Model tried to call unavailable tool 'project_read_file'. Available tools: agent_plan."),
    } as never);

    expect(decision).toEqual({ retry: true });
  });

  it('retries only once, so a model that keeps calling a missing tool still stops', () => {
    const onRetry = vi.fn();
    const recovery = createAgentStreamRecovery(onRetry);

    expect(recovery.onError({ error: unavailableToolError() } as never)).toEqual({ retry: true });
    expect(recovery.onError({ error: unavailableToolError() } as never)).toBeUndefined();
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('keeps the first error so the surfaced message names the real cause', () => {
    const recovery = createAgentStreamRecovery(vi.fn());
    const first = unavailableToolError();

    recovery.onError({ error: first } as never);
    recovery.onError({ error: new Error('second') } as never);

    expect(recovery.getError(new Error('late'))).toBe(first);
  });
});
