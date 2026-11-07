import { isStepCount, jsonSchema, streamText, tool } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it, vi } from 'vitest';
import { withAgentStreamDeadlines, withAgentToolCallRecovery } from './agent-stream';

/*
 * Scenario sweep for provider output that does not arrive as a native tool call.
 *
 * Each case is a shape seen in a live session (or the obvious neighbour of one).
 * The contract is the same every time: the turn must end, the raw markup must
 * never reach the user, and a call must only run when its name and arguments are
 * real. "Hangs" in production are almost always a turn that produced no tool call
 * and no visible text.
 */
const finish = (controller: ReadableStreamDefaultController<unknown>) => {
  controller.enqueue({
    type: 'finish',
    finishReason: { unified: 'stop', raw: 'stop' },
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  });
  controller.close();
};

const reply = (text: string) =>
  new MockLanguageModelV4({
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: 'stream-start', warnings: [] });
          controller.enqueue({ type: 'text-start', id: 't' });
          controller.enqueue({ type: 'text-delta', id: 't', delta: text });
          controller.enqueue({ type: 'text-end', id: 't' });
          finish(controller);
        },
      }),
    }),
  });

const tools = () => ({
  project_get_process_output: tool({
    inputSchema: jsonSchema({
      type: 'object',
      properties: { processId: { type: 'string' } },
      required: ['processId'],
    }),
  }),
  project_run_command: tool({
    inputSchema: jsonSchema({
      type: 'object',
      properties: { command: { type: 'string' }, purpose: { type: 'string' } },
      required: ['command', 'purpose'],
    }),
  }),
  project_patch_file: tool({
    inputSchema: jsonSchema({
      type: 'object',
      properties: {
        path: { type: 'string' },
        oldText: { type: 'string' },
        newText: { type: 'string' },
        expectedRevision: { type: 'string' },
      },
      required: ['path', 'oldText', 'newText'],
    }),
  }),
});

const run = async (text: string) => {
  const result = streamText({
    model: withAgentToolCallRecovery(withAgentStreamDeadlines(reply(text)), vi.fn()),
    prompt: 'Poll the running command.',
    toolChoice: 'auto',
    tools: tools(),
    stopWhen: isStepCount(1),
  });

  const chunks: unknown[] = [];

  for await (const chunk of result.fullStream) {
    chunks.push(chunk);
  }

  const rendered = JSON.stringify(chunks);

  const calls = chunks.filter((chunk) => (chunk as { type?: string }).type === 'tool-call') as Array<{
    toolName: string;
    input: unknown;
  }>;

  return { rendered, calls };
};

describe('provider output scenarios', () => {
  it.each([
    [
      'ascii bars',
      '<||DSML|| invoke name="project_get_process_output"><||DSML|| parameter name="processId" string="true">p-1<||DSML|| parameter></||DSML|| invoke>',
    ],

    [
      'full-width bars, multi-line, wrapped in a calls block',
      '｜｜DSML｜｜ calls>\n｜｜DSML｜｜ invoke name="project_get_process_output">\n｜｜DSML｜｜ parameter name="processId" string="true">p-1｜｜DSML｜｜ parameter>\n｜｜DSML｜｜ invoke>',
    ],

    [
      'full-width bars closed with </…>',
      '｜｜DSML｜｜ invoke name="project_get_process_output">｜｜DSML｜｜ parameter name="processId" string="true">p-1</｜｜DSML｜｜ parameter>｜｜DSML｜｜ invoke>',
    ],
    [
      'anthropic antml tags',
      '<antml:invoke name="project_get_process_output"><antml:parameter name="processId" string="true">p-1</antml:parameter></antml:invoke>',
    ],
    [
      'prose before the call',
      'Polling now.\n<||DSML|| invoke name="project_get_process_output"><||DSML|| parameter name="processId" string="true">p-1<||DSML|| parameter></||DSML|| invoke>',
    ],
  ])('recovers %s with exact arguments', async (_case, text) => {
    const { rendered, calls } = await run(text);

    expect(calls).toHaveLength(1);
    expect(calls[0].toolName).toBe('project_get_process_output');
    expect(calls[0].input).toEqual({ processId: 'p-1' });
    expect(rendered).not.toMatch(/DSML|antml:invoke/);
  });

  it.each([
    [
      'an unknown tool',
      '<||DSML|| invoke name="project_query_database"><||DSML|| parameter name="id" string="true">1<||DSML|| parameter></||DSML|| invoke>',
    ],
    [
      'a truncated block',
      '<||DSML|| invoke name="project_run_command"><||DSML|| parameter name="command" string="true">npm run dev',
    ],
    ['only a closing tag', '</||DSML|| invoke>'],
  ])('ends the turn without rendering markup for %s', async (_case, text) => {
    const { rendered, calls } = await run(text);

    expect(calls).toHaveLength(0);
    expect(rendered).not.toMatch(/DSML/);
  });

  /*
   * The two-block batch seen live: valid patches solved by a model that printed
   * them instead of calling them. Recovery must keep both, exactly.
   */
  it('recovers a multi-block patch batch with exact arguments', async () => {
    const block = (name: string, params: Array<[string, string]>) =>
      `｜｜DSML｜｜ invoke name="${name}">` +
      params
        .map(([key, value]) => `｜｜DSML｜｜ parameter name="${key}" string="true">${value}｜｜DSML｜｜ parameter>`)
        .join('') +
      '｜｜DSML｜｜ invoke>';

    const { calls } = await run(
      '｜｜DSML｜｜ calls>' +
        block('project_patch_file', [
          ['path', 'src/content/site.ts'],
          ['oldText', 'export type LegalSection = { heading: string; paragraphs: string[] };'],
          ['newText', 'export type LegalSection = { heading: string; paragraphs: readonly string[] };'],
          ['expectedRevision', '527861d06b9a643b9681dfa62f88c771ff0a8fe3a90f410c4d657c101f57bcf4'],
        ]) +
        block('project_patch_file', [
          ['path', 'src/pages/SelfHost.tsx'],
          [
            'oldText',
            "import { CodeBlock } from '../components/CodeBlock';\nimport { CTASection } from '../components/CTASection';",
          ],
          ['newText', "import { CodeBlock } from '../components/CodeBlock';"],
        ]) +
        '｜｜DSML｜｜ calls>',
    );

    expect(calls).toHaveLength(2);
    expect(calls[0].input).toEqual({
      path: 'src/content/site.ts',
      oldText: 'export type LegalSection = { heading: string; paragraphs: string[] };',
      newText: 'export type LegalSection = { heading: string; paragraphs: readonly string[] };',
      expectedRevision: '527861d06b9a643b9681dfa62f88c771ff0a8fe3a90f410c4d657c101f57bcf4',
    });
    expect((calls[1].input as Record<string, unknown>).path).toBe('src/pages/SelfHost.tsx');
    expect((calls[1].input as Record<string, unknown>).oldText).toContain('CTASection');
  });

  it('keeps the valid calls when one block names an unknown tool', async () => {
    const { rendered, calls } = await run(
      '｜｜DSML｜｜ calls>' +
        '｜｜DSML｜｜ invoke name="project_frobnicate">｜｜DSML｜｜ parameter name="path" string="true">a.ts｜｜DSML｜｜ parameter>｜｜DSML｜｜ invoke>' +
        '｜｜DSML｜｜ invoke name="project_run_command">｜｜DSML｜｜ parameter name="command" string="true">npm test｜｜DSML｜｜ parameter>｜｜DSML｜｜ parameter name="purpose" string="true">test｜｜DSML｜｜ parameter>｜｜DSML｜｜ invoke>' +
        '｜｜DSML｜｜ calls>',
    );

    // One unusable call used to discard its siblings and flush the markup to the user.
    expect(calls).toHaveLength(1);
    expect(calls[0].toolName).toBe('project_run_command');
    expect(rendered).not.toMatch(/DSML/);
    expect(rendered).toContain('skipped');
  });

  it('runs the first calls of an over-long batch instead of discarding all of them', async () => {
    const blocks = Array.from(
      { length: 9 },
      (_, index) =>
        `｜｜DSML｜｜ invoke name="project_get_process_output">｜｜DSML｜｜ parameter name="processId" string="true">p-${index}｜｜DSML｜｜ parameter>｜｜DSML｜｜ invoke>`,
    ).join('');

    const { calls } = await run(`｜｜DSML｜｜ calls>${blocks}｜｜DSML｜｜ calls>`);

    expect(calls).toHaveLength(8);
  });

  it('does not treat prose that mentions a tool as a call', async () => {
    const { calls, rendered } = await run('I will use project_get_process_output to read the output.');

    expect(calls).toHaveLength(0);
    expect(rendered).toContain('project_get_process_output');
  });

  it('leaves values ending in a comparison operator intact', async () => {
    const { calls } = await run(
      '<antml:invoke name="project_run_command"><antml:parameter name="command" string="true">echo 1 &lt; 2</antml:parameter><antml:parameter name="purpose" string="true">run</antml:parameter></antml:invoke>',
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].input).toEqual({ command: 'echo 1 &lt; 2', purpose: 'run' });
  });
});
