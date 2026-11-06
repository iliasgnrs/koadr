import { tool, type Instructions } from 'ai';
import { z } from 'zod';
import {
  getAgentCompletionProblems,
  getAgentLoopInstructions,
  getAgentLoopProgress,
  isAgentPlan,
} from '~/lib/common/agentLoop';
import type { AnyMessage } from '~/lib/persistence/messageMigration';

const planSchema = z
  .object({
    goal: z.string().min(1).max(500),
    steps: z.array(z.string().min(1).max(250)).min(1).max(6),
    criteria: z
      .array(z.object({ id: z.string().min(1).max(40), description: z.string().min(1).max(400) }))
      .min(1)
      .max(8),
    requiresPreview: z.boolean(),
  })
  .refine(
    (plan) => new Set(plan.criteria.map((criterion) => criterion.id)).size === plan.criteria.length,
    'Criterion IDs must be unique.',
  );

/** Plan and completion tools execute on the server; project effects remain in the browser. */
export function createAgentLoopTools<TaskToolName extends string = never>(
  messages: AnyMessage[],
  enabled: boolean,
  requiresPreview: boolean,
  taskToolNames?: TaskToolName[],
  supportsToolChoice = true,
) {
  let currentMessages = messages;

  /*
   * Thinking-mode models reject a forced tool_choice, so they get `auto` with the
   * tool set narrowed instead of `tool`/`required`.
   */
  const forced = <T, F>(choice: T, fallback: F): T | F => (supportsToolChoice ? choice : fallback);

  const tools = {
    agent_plan: tool({
      description:
        'Record a concise task plan and observable completion criteria before editing. Use stable criterion IDs. Require a preview for a web app, and preserve the existing project on follow-up requests.',
      inputSchema: planSchema,
      execute: async (plan) => ({ plan: { ...plan, requiresPreview: requiresPreview || plan.requiresPreview } }),
    }),
    agent_complete: tool({
      description:
        'Finish the current task only after running it and passing relevant checks after the latest edit. Report every planned criterion by its exact ID. The server attaches evidence from successful project tool calls automatically; do not provide process IDs, command names, or guessed evidence IDs. Use outcome blocked with a concrete reason if completion is impossible.',
      inputSchema: z.object({
        outcome: z.enum(['complete', 'blocked']),
        summary: z.string().min(1).max(1000),
        criteria: z
          .array(
            z.object({
              id: z.string().min(1).max(40),
              evidence: z.array(z.string().min(1).max(256)).max(20).optional(),
            }),
          )
          .max(8),
      }),
      execute: async (input) => {
        if (input.outcome === 'blocked') {
          return { completed: false, blocked: true, reason: input.summary };
        }

        const progress = getAgentLoopProgress(currentMessages, enabled);
        const problems = getAgentCompletionProblems(progress);
        const plannedCriteria = progress.plan?.criteria ?? [];
        const plannedIds = new Set(plannedCriteria.map((criterion) => criterion.id));
        const reportedIds = new Set(input.criteria.map((criterion) => criterion.id));

        if (reportedIds.size !== input.criteria.length) {
          problems.push('Report each planned criterion exactly once.');
        }

        for (const criterion of plannedCriteria) {
          if (!reportedIds.has(criterion.id)) {
            problems.push(`Report planned criterion ${criterion.id} by its exact ID.`);
          }
        }

        for (const criterion of input.criteria) {
          if (!plannedIds.has(criterion.id)) {
            problems.push(`Criterion ${criterion.id} is not in the recorded plan.`);
          }
        }

        if (progress.evidence.length === 0) {
          problems.push('Successful project tool-call evidence is missing.');
        }

        if (problems.length > 0) {
          return {
            isError: true,
            completed: false,
            problems,
            availableEvidence: progress.evidence,
            plannedCriteria: progress.plan?.criteria.map((criterion) => criterion.id) ?? [],
            error: problems.join(' '),
          };
        }

        return {
          completed: true,
          summary: input.summary,
          criteria: plannedCriteria.map((criterion) => ({ id: criterion.id, evidence: progress.evidence })),
        };
      },
    }),
  };

  return {
    tools,
    prepareStep: ({
      steps,
      initialInstructions,
    }: {
      steps: Array<{
        toolCalls: Array<{ toolName: string; toolCallId: string; input: unknown; invalid?: boolean }>;
        toolResults: Array<{ toolCallId: string; output: unknown }>;
      }>;
      initialInstructions?: Instructions;
    }): {
      instructions?: Instructions;
      toolChoice: 'none' | 'auto' | 'required' | { type: 'tool'; toolName: 'agent_plan' };
      activeTools?: Array<TaskToolName | 'agent_plan' | 'agent_complete'>;
    } => {
      /*
       * `agent_plan` runs on the server, so the SDK's `toolResults` omit it. Without
       * its output the loop never sees a plan and re-narrows `activeTools` to
       * `agent_plan` on every later step, leaving the model unable to call any
       * project tool ("Model tried to call unavailable tool 'project_write_file'").
       * Reconstruct the plan output from the validated call input in that case.
       */
      const planResult = (call: { toolName: string; input: unknown }) =>
        call.toolName === 'agent_plan' && isAgentPlan(call.input)
          ? { plan: { ...call.input, requiresPreview: requiresPreview || call.input.requiresPreview } }
          : undefined;

      currentMessages = [
        ...messages,
        ...steps.map((step) => ({
          role: 'assistant',
          parts: [
            { type: 'step-start' },
            ...step.toolCalls.map((call) => {
              const result = step.toolResults.find((result) => result.toolCallId === call.toolCallId);
              const output = result ? result.output : planResult(call);

              return {
                type: `tool-${call.toolName}`,
                toolCallId: call.toolCallId,
                input: call.input,
                state: output !== undefined ? 'output-available' : call.invalid ? 'output-error' : 'input-available',
                output,
              };
            }),
          ],
        })),
      ];

      const progress = getAgentLoopProgress(currentMessages, enabled);

      const guidance = [
        getAgentLoopInstructions(progress),
        progress.status === 'pending'
          ? 'Use the supplied tools interface to make actual tool calls. Never print tool-call JSON or a promise to act in place of calling a tool. Follow each tool input schema exactly.'
          : '',
      ]
        .filter(Boolean)
        .join('\n');

      const instructions =
        initialInstructions === undefined
          ? {}
          : {
              instructions:
                typeof initialInstructions === 'string'
                  ? `${initialInstructions}\n\nCurrent agent loop state:\n${guidance}`
                  : [
                      ...(Array.isArray(initialInstructions) ? initialInstructions : [initialInstructions]),
                      { role: 'system' as const, content: guidance },
                    ],
            };

      if (['blocked', 'limited', 'ready'].includes(progress.status)) {
        return { ...instructions, toolChoice: 'none' as const };
      }

      if (progress.status === 'inactive') {
        return { ...instructions, toolChoice: 'auto' as const };
      }

      if (!progress.plan) {
        return {
          ...instructions,
          toolChoice: forced({ type: 'tool' as const, toolName: 'agent_plan' as const }, 'auto' as const),
          activeTools: ['agent_plan' as const],
        };
      }

      /*
       * Only the read-only path tools are held back before the first edit, to keep
       * the model from exploring instead of writing. Everything else — including
       * every run/process tool — stays visible.
       *
       * This used to be an allowlist, which silently dropped `project_run_command`
       * and `project_get_process_output` once a plan existed; the model then called
       * a tool it could not see, hit NoSuchToolError, and the turn ended before a
       * preview. A denylist fails open: a new tool is available by default.
       */
      const deferredUntilFirstEdit = new Set([
        'project_list_paths',
        'project_search_content',
        'project_find_related_files',
      ]);

      const activeProjectTools = taskToolNames?.filter((toolName) => {
        // Repair runs and any task that already edited keep the full toolset.
        if (progress.needsRepair || progress.edited) {
          return true;
        }

        return !deferredUntilFirstEdit.has(toolName);
      });

      return {
        ...instructions,
        toolChoice: forced('required' as const, 'auto' as const),
        ...(taskToolNames
          ? {
              activeTools: [...activeProjectTools!, 'agent_plan' as const, 'agent_complete' as const],
            }
          : {}),
      };
    },
  };
}
